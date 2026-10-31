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
  const place = (pool: ResidencyPool, item: string, now: number, priority?: number) => {
    const slot = pool.allocate(owner, now, priority)
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

  it("ranks every owner's post together at a settle and grants each its share of the free slots", () => {
    const pool = new ResidencyPool({ slots: 4, budget: false })
    const a = makeOwner()
    const b = makeOwner()
    b.place(pool, "b0", 0)
    // Three free slots and one pending fetch of a's: two to share out
    expect(pool.post(b.owner, [{ priority: 9, id: "b-high" }, { priority: 1, id: "b-low" }], 0, 0)).toEqual([])
    pool.post(a.owner, [{ priority: 5, id: "a-mid" }, { priority: 2, id: "a-low" }], 1, 0)
    pool.settle(1)
    expect(pool.post(a.owner, [], 0, 2).map((w) => w.id)).toEqual(["a-mid"])
    expect(pool.post(b.owner, [], 0, 2).map((w) => w.id)).toEqual(["b-high"])
    expect(pool.statsOf(a.owner)).toMatchObject({ wanted: 2, pending: 1 })
  })

  it("settles by itself when an owner posts again, a frame late, and counts an owner that did not post as wanting nothing", () => {
    const pool = new ResidencyPool({ slots: 1, budget: false })
    const a = makeOwner()
    const b = makeOwner()
    pool.post(a.owner, [{ priority: 9 }], 0, 0)
    pool.post(b.owner, [{ priority: 1 }], 0, 0)
    // a's second post settles the first frame: a outranks b for the one slot
    expect(pool.post(a.owner, [], 0, 16)).toEqual([{ priority: 9 }])
    expect(pool.post(b.owner, [{ priority: 1 }], 0, 16)).toEqual([])
    // a stopped asking, so the next settle gives b the slot
    expect(pool.post(b.owner, [{ priority: 1 }], 0, 32)).toEqual([{ priority: 1 }])
  })

  it("lets another owner's want take a protected slot it is worth more than, least valued first, never the owner's own or a pinned one", () => {
    const pool = new ResidencyPool({ slots: 3, protectMs: 1000, budget: false })
    const a = makeOwner(["root"])
    const b = makeOwner()
    a.place(pool, "root", 0, 100)
    a.place(pool, "low", 0, 2)
    a.place(pool, "mid", 0, 4)
    const decide = (wants: { priority: number }[], now: number) => {
      pool.post(b.owner, wants, 0, now)
      pool.settle(now)
      return pool.post(b.owner, [], 0, now)
    }
    // All protected: a's own want cannot take its own slots, b's must beat a value by 1.5x
    expect(a.place(pool, "a-more", 10, 50)).toBe(-1)
    expect(decide([{ priority: 2.5 }], 10)).toEqual([])
    // 7 beats "low" (2); 6.5 would need more than 1.5 x "mid" (4), and "low" is spoken for; "root" is pinned
    expect(decide([{ priority: 7 }, { priority: 5.5 }, { priority: 1 }], 10)).toEqual([{ priority: 7 }])
    expect(decide([{ priority: 7 }, { priority: 6.5 }], 10)).toEqual([{ priority: 7 }, { priority: 6.5 }])
    expect(b.place(pool, "b1", 20, 7)).toBeGreaterThanOrEqual(0)
    expect(a.evicted).toEqual(["low"])
    // b's new slot carries its want's value, so a cannot take it back for less
    pool.touch([...a.held].find(([, item]) => item === "mid")![0], 30, 4)
    expect(a.place(pool, "a-back", 40, 9)).toBe(-1)
    expect(a.place(pool, "a-back", 40, 11)).toBeGreaterThanOrEqual(0)
    expect(b.evicted).toEqual(["b1"])
  })

  it("does not raise the scale while wants can be met by contesting", () => {
    const pool = new ResidencyPool({ slots: 2, protectMs: 10_000, budgetIntervalMs: 100 })
    const a = makeOwner()
    const b = makeOwner()
    a.place(pool, "a1", 0, 1)
    a.place(pool, "a2", 0, 1)
    const frame = (priority: number, now: number) => {
      pool.post(b.owner, [{ priority }], 0, now)
      pool.settle(now)
    }
    frame(5, 100)
    expect(b.place(pool, "b1", 150, 5)).toBeGreaterThanOrEqual(0)
    frame(5, 200)
    frame(5, 300)
    expect(pool.scale).toBe(1)
    // Worth too little to contest a2: stuck, so the scale rises
    frame(1.2, 400)
    expect(pool.scale).toBeCloseTo(1.25)
  })

  it("raises the scale while stuck, holds it with the budget off, and eases it once there is room", () => {
    const pool = new ResidencyPool({ slots: 2, protectMs: 10_000, budgetIntervalMs: 100 })
    const a = makeOwner()
    a.place(pool, "a1", 0)
    a.place(pool, "a2", 0)
    const frame = (wants: { priority: number }[], now: number) => {
      pool.post(a.owner, wants, 0, now)
      pool.settle(now)
    }
    frame([{ priority: 1 }], 100)
    frame([{ priority: 1 }], 200)
    expect(pool.scale).toBeCloseTo(1.25)
    frame([{ priority: 1 }], 300)
    expect(pool.scale).toBeCloseTo(1.5625)
    pool.budget = false
    frame([{ priority: 1 }], 400)
    expect(pool.scale).toBeCloseTo(1.5625)
    pool.budget = true
    pool.release(a.owner)
    frame([], 500)
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
