import { describe, it, expect } from "vitest"
import { ReadbackGate } from "../index.js"

// A context whose fences signal when the test says the GPU has caught up
const fakeContext = () => {
  const fences: { signalled: boolean }[] = []
  const gl = {
    SYNC_STATUS: 1,
    SIGNALED: 2,
    UNSIGNALED: 3,
    SYNC_GPU_COMMANDS_COMPLETE: 4,
    fenceSync: () => {
      const fence = { signalled: false }
      fences.push(fence)
      return fence
    },
    getSyncParameter: (fence: { signalled: boolean }) => (fence.signalled ? 2 : 3),
    deleteSync: () => {},
    flush: () => {},
  }
  return { gl: gl as unknown as WebGL2RenderingContext, catchUp: () => fences.forEach((f) => (f.signalled = true)) }
}
const endFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

// A reader whose own fence the test signals, counting its reads
const reader = () => {
  const r = { ready: false, reads: 0, readback: { ready: () => r.ready, read: () => r.reads++ } }
  return r
}

describe("ReadbackGate", () => {
  it("is shared by everything on one context", () => {
    const { gl } = fakeContext()
    expect(ReadbackGate.for(gl)).toBe(ReadbackGate.for(gl))
    expect(ReadbackGate.for(fakeContext().gl)).not.toBe(ReadbackGate.for(gl))
  })

  it("reads every ready readback together at a frame's first ask, once the frame before has finished on the GPU", async () => {
    const { gl, catchUp } = fakeContext()
    const gate = ReadbackGate.for(gl)
    const a = reader(), b = reader(), c = reader()
    gate.submit(a, a.readback)
    gate.submit(b, b.readback)
    gate.submit(c, c.readback)
    a.ready = b.ready = true
    // The frame before has not finished: nothing is read
    await endFrame()
    expect(gate.collected(a)).toBe(false)
    expect(a.reads).toBe(0)
    await endFrame()
    catchUp()
    // The first ask reads both that are ready; c's own fence has not signalled
    expect(gate.collected(b)).toBe(true)
    expect([a.reads, b.reads, c.reads]).toEqual([1, 1, 0])
    expect(gate.collected(b)).toBe(false)
    expect(gate.collected(a)).toBe(true)
    // Ready now, but a frame reads only at its first ask
    c.ready = true
    expect(gate.collected(c)).toBe(false)
    await endFrame()
    catchUp()
    expect(gate.collected(c)).toBe(true)
    expect(gate.stats).toMatchObject({ reads: 3, waiting: 0 })
  })

  it("forgets a cancelled readback", async () => {
    const { gl, catchUp } = fakeContext()
    const gate = ReadbackGate.for(gl)
    const a = reader()
    a.ready = true
    gate.submit(a, a.readback)
    gate.cancel(a)
    await endFrame()
    catchUp()
    expect(gate.collected(a)).toBe(false)
    expect(a.reads).toBe(0)
  })

  it("grants one pass a frame, to the reader that has waited longest, and forgets one that stops asking", async () => {
    const { gl } = fakeContext()
    const gate = ReadbackGate.for(gl)
    const a = {}, b = {}, c = {}
    const turns = new Map<object, number>([[a, 0], [b, 0], [c, 0]])
    for (let frame = 0; frame < 9; frame++) {
      let granted = 0
      for (const reader of [a, b, c]) if (gate.turn(reader)) { granted++; turns.set(reader, turns.get(reader)! + 1) }
      expect(granted).toBe(1)
      await endFrame()
    }
    expect([...turns.values()]).toEqual([3, 3, 3])
    // c stops asking: a and b share the turns
    for (let frame = 0; frame < 4; frame++) {
      expect(gate.turn(a) || gate.turn(b)).toBe(true)
      await endFrame()
    }
    gate.cancel(a)
    expect(gate.turn(b)).toBe(true)
  })
})
