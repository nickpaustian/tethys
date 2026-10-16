import { describe, it, expect } from "vitest"
import { FetchPool } from "../index.js"

const deferred = () => {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// A run that blocks until released, recording the order it was started in
const makeRuns = () => {
  const started: string[] = []
  const gates = new Map<string, ReturnType<typeof deferred>>()
  const run = (name: string) => async () => {
    started.push(name)
    const gate = deferred()
    gates.set(name, gate)
    await gate.promise
  }
  return { started, run, release: (name: string) => gates.get(name)!.resolve(), fail: (name: string) => gates.get(name)!.reject(new Error("boom")) }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe("FetchPool", () => {
  it("starts up to the concurrency and queues the rest", async () => {
    const pool = new FetchPool({ concurrency: 2 })
    const client = pool.client("a")
    const { started, run, release } = makeRuns()
    client.submit(1, run("one"))
    client.submit(1, run("two"))
    client.submit(1, run("three"))
    expect(started).toEqual(["one", "two"])
    expect(pool.stats).toMatchObject({ inFlight: 2, queued: 1 })
    release("one")
    await tick()
    expect(started).toEqual(["one", "two", "three"])
    expect(pool.stats).toMatchObject({ inFlight: 2, queued: 0 })
  })

  it("orders waiting requests by weight times priority, oldest first on ties", async () => {
    const pool = new FetchPool({ concurrency: 1 })
    const geometry = pool.client("geometry", { weight: 1 })
    const texture = pool.client("texture", { weight: 0.8 })
    const { started, run, release } = makeRuns()
    texture.submit(1, run("blocker"))
    texture.submit(1, run("texture-high"))        // 0.8
    geometry.submit(0.5, run("geometry-half"))    // 0.5
    geometry.submit(1, run("geometry-high"))      // 1.0
    texture.submit(0.9, run("texture-mid"))       // 0.72
    geometry.submit(0.8, run("geometry-tie"))     // 0.8, submitted after texture-high
    for (const name of ["blocker", "geometry-high", "texture-high", "geometry-tie", "texture-mid", "geometry-half"]) {
      release(name)
      await tick()
    }
    expect(started).toEqual(["blocker", "geometry-high", "texture-high", "geometry-tie", "texture-mid", "geometry-half"])
  })

  it("lets a waiting request be re-prioritised or withdrawn, and ignores cancel once started", async () => {
    const pool = new FetchPool({ concurrency: 1 })
    const client = pool.client("a")
    const { started, run, release } = makeRuns()
    const first = client.submit(1, run("first"))
    let cancelled = false
    const low = client.submit(0.1, run("low"), () => { cancelled = true })
    const mid = client.submit(0.5, run("mid"))
    expect(first.started).toBe(true)
    expect(low.started).toBe(false)
    low.setPriority(0.9)
    first.cancel()
    expect(pool.stats.inFlight).toBe(1)
    release("first")
    await tick()
    expect(started).toEqual(["first", "low"])
    mid.cancel()
    expect(cancelled).toBe(false)
    release("low")
    await tick()
    expect(started).toEqual(["first", "low"])
    expect(pool.stats.queued).toBe(0)
    expect(pool.stats.clients[0]).toMatchObject({ queued: 0, inFlight: 0, started: 2 })
  })

  it("frees the slot when a run rejects", async () => {
    const pool = new FetchPool({ concurrency: 1 })
    const client = pool.client("a")
    const { started, run, fail } = makeRuns()
    client.submit(1, run("bad"))
    client.submit(1, run("next"))
    fail("bad")
    await tick()
    expect(started).toEqual(["bad", "next"])
    expect(pool.stats.inFlight).toBe(1)
  })

  it("measures bytes per client and per second, and forgets them after the window", async () => {
    const pool = new FetchPool({ concurrency: 4, bandwidthWindowMs: 60 })
    const a = pool.client("a")
    const b = pool.client("b")
    await Promise.all([
      new Promise<void>((done) => a.submit(1, async ({ progress }) => { progress(1000); progress(500); done() })),
      new Promise<void>((done) => b.submit(1, async ({ progress }) => { progress(250); done() })),
    ])
    const rate = pool.stats.bytesPerSecond
    expect(rate).toBeGreaterThan(0)
    expect(rate).toBeLessThanOrEqual((1750 * 1000) / 250 + 1)
    expect(pool.stats.clients.map((c) => [c.name, c.bytes])).toEqual([["a", 1500], ["b", 250]])
    await new Promise((r) => setTimeout(r, 90))
    expect(pool.stats.bytesPerSecond).toBe(0)
  })

  it("cancels everything waiting on dispose and starts nothing more", () => {
    const pool = new FetchPool({ concurrency: 1 })
    const client = pool.client("a")
    const { started, run } = makeRuns()
    const cancelled: string[] = []
    client.submit(1, run("running"))
    client.submit(1, run("waiting"), () => cancelled.push("waiting"))
    pool.dispose()
    expect(cancelled).toEqual(["waiting"])
    expect(pool.stats.queued).toBe(0)
    client.submit(1, run("late"))
    expect(started).toEqual(["running"])
  })

  it("reuses a client by name and updates its weight", () => {
    const pool = new FetchPool()
    const first = pool.client("a", { weight: 0.5 })
    const again = pool.client("a", { weight: 0.7 })
    expect(again).toBe(first)
    expect(first.weight).toBe(0.7)
  })
})
