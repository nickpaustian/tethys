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

describe("ReadbackGate", () => {
  it("is shared by everything on one context", () => {
    const { gl } = fakeContext()
    expect(ReadbackGate.for(gl)).toBe(ReadbackGate.for(gl))
    expect(ReadbackGate.for(fakeContext().gl)).not.toBe(ReadbackGate.for(gl))
  })

  it("lets one read through a frame, and none until the frame before has finished on the GPU", async () => {
    const { gl, catchUp } = fakeContext()
    const gate = ReadbackGate.for(gl)
    const a = {}, b = {}
    expect(gate.request(a)).toBe(true)
    expect(gate.request(b)).toBe(false)
    await endFrame()
    expect(gate.request(b)).toBe(false)
    await endFrame()
    catchUp()
    expect(gate.request(b)).toBe(true)
  })

  it("takes turns: a reader that read last gives way to one turned away", async () => {
    const { gl, catchUp } = fakeContext()
    const gate = ReadbackGate.for(gl)
    const a = {}, b = {}
    expect(gate.request(a)).toBe(true)
    expect(gate.request(b)).toBe(false)
    await endFrame()
    catchUp()
    expect(gate.request(a)).toBe(false)
    expect(gate.request(b)).toBe(true)
    await endFrame()
    catchUp()
    expect(gate.request(a)).toBe(true)
  })

  it("serves every reader in turn, however many ask, and forgets one that stops asking", async () => {
    const { gl, catchUp } = fakeContext()
    const gate = ReadbackGate.for(gl)
    const readers = [{}, {}, {}]
    const reads = [0, 0, 0]
    for (let frame = 0; frame < 9; frame++) {
      readers.forEach((r, i) => gate.request(r) && reads[i]++)
      await endFrame()
      catchUp()
    }
    expect(reads).toEqual([3, 3, 3])
    const [a, b] = readers
    for (let frame = 0; frame < 4; frame++) {
      expect(gate.request(a) || gate.request(b)).toBe(true)
      await endFrame()
      catchUp()
    }
  })
})
