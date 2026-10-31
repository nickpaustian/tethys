import { describe, it, expect } from "vitest"
import { ResidencyPool, type ResidencyOwner } from "../index.js"

// An owner that remembers what each of its slots holds and pins the ones named
const makeOwner = (pinnedItems: string[] = []) => {
  const held = new Map<number, string>()
  const evicted: string[] = []
  const owner: ResidencyOwner = {
    pinned: (slot) => pinnedItems.includes(held.get(slot) ?? ""),
    evict: (slot) => {
      evicted.push(held.get(slot)!)
      held.delete(slot)
    },
  }
  const place = (pool: ResidencyPool, item: string, now: number) => {
    const slot = pool.allocate(owner, now)
    if (slot >= 0) held.set(slot, item)
    return slot
  }
  return { owner, held, evicted, place }
}

describe("ResidencyPool", () => {
  it("hands out free slots, then the least recently used across owners, telling the owner that loses one", () => {
    const pool = new ResidencyPool({ slots: 3, protectMs: 100 })
    const a = makeOwner()
    const b = makeOwner()
    a.place(pool, "a1", 0)
    b.place(pool, "b1", 10)
    a.place(pool, "a2", 20)
    expect(pool.vacantSlots).toBe(0)
    pool.touch([...a.held].find(([, item]) => item === "a1")![0], 50)
    // a1 was used at 50, so b1 (10) is the oldest
    expect(b.place(pool, "b2", 500)).toBeGreaterThanOrEqual(0)
    expect(b.evicted).toEqual(["b1"])
    expect(a.place(pool, "a3", 600)).toBeGreaterThanOrEqual(0)
    expect(a.evicted).toEqual(["a2"])
  })

  it("never takes a protected or pinned slot", () => {
    const pool = new ResidencyPool({ slots: 2, protectMs: 100 })
    const a = makeOwner(["root"])
    const b = makeOwner()
    a.place(pool, "root", 0)
    b.place(pool, "b1", 50)
    expect(b.place(pool, "b2", 120)).toBe(-1)
    expect(pool.availableSlots(120)).toBe(0)
    expect(b.place(pool, "b2", 200)).toBeGreaterThanOrEqual(0)
    expect(b.evicted).toEqual(["b1"])
    expect(a.evicted).toEqual([])
  })

  it("ranks every owner's offer together and grants each only its share of the free slots", () => {
    const pool = new ResidencyPool({ slots: 4, budget: false })
    const a = makeOwner()
    const b = makeOwner()
    b.place(pool, "b0", 0)
    // Three free slots and one pending fetch of a's: two to share out
    pool.offer(b.owner, [{ priority: 9, id: "b-high" }, { priority: 1, id: "b-low" }], 0, 0)
    const forA = pool.offer(a.owner, [{ priority: 5, id: "a-mid" }, { priority: 2, id: "a-low" }], 1, 1)
    expect(forA.map((w) => w.id)).toEqual(["a-mid"])
    const forB = pool.offer(b.owner, [{ priority: 9, id: "b-high" }, { priority: 1, id: "b-low" }], 0, 2)
    expect(forB.map((w) => w.id)).toEqual(["b-high"])
  })

  it("lets an offer age out, so an owner that stops asking holds no share", () => {
    const pool = new ResidencyPool({ slots: 1, budget: false, offerMs: 100 })
    const a = makeOwner()
    const b = makeOwner()
    pool.offer(a.owner, [{ priority: 9 }], 0, 0)
    expect(pool.offer(b.owner, [{ priority: 1 }], 0, 50)).toEqual([])
    expect(pool.offer(b.owner, [{ priority: 1 }], 0, 200)).toEqual([{ priority: 1 }])
  })

  it("raises the scale while stuck, holds it with the budget off, and eases it once there is room", () => {
    const pool = new ResidencyPool({ slots: 2, protectMs: 10_000, budgetIntervalMs: 100 })
    const a = makeOwner()
    a.place(pool, "a1", 0)
    a.place(pool, "a2", 0)
    pool.offer(a.owner, [{ priority: 1 }], 0, 100)
    pool.offer(a.owner, [{ priority: 1 }], 0, 200)
    expect(pool.scale).toBeCloseTo(1.25)
    pool.offer(a.owner, [{ priority: 1 }], 0, 300)
    expect(pool.scale).toBeCloseTo(1.5625)
    pool.budget = false
    pool.offer(a.owner, [{ priority: 1 }], 0, 400)
    expect(pool.scale).toBeCloseTo(1.5625)
    pool.budget = true
    pool.release(a.owner)
    pool.offer(a.owner, [], 0, 500)
    expect(pool.scale).toBeCloseTo(1.5625 / 1.1)
  })

  it("frees an owner's slots on release without telling it, and counts owners", () => {
    const pool = new ResidencyPool({ slots: 3 })
    const a = makeOwner()
    const b = makeOwner()
    a.place(pool, "a1", 0)
    a.place(pool, "a2", 0)
    pool.join(b.owner)
    expect(pool.stats).toMatchObject({ owners: 2, freeSlots: 1 })
    expect(pool.statsOf(a.owner).slots).toBe(2)
    pool.release(a.owner)
    expect(pool.stats).toMatchObject({ owners: 1, freeSlots: 3 })
    expect(a.evicted).toEqual([])
  })
})
