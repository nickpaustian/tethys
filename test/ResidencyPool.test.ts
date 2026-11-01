import { describe, it, expect } from "vitest"
import { CLAIMED, ResidencyPool, type ResidencyOwner } from "../index.js"

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

  it("grants a want a slot it can contest, asks the owner to yield it only when the claimant allocates, and gives that slot first once yieldMs is up", () => {
    const pool = new ResidencyPool({ slots: 2, protectMs: 10_000, yieldMs: 100, budget: false })
    const a = makeOwner()
    const yielded: number[] = []
    a.owner.yield = (slot) => yielded.push(slot)
    const b = makeOwner()
    a.place(pool, "a-low", 0, 1)
    a.place(pool, "a-high", 0, 50)
    const low = [...a.held].find(([, item]) => item === "a-low")![0]
    pool.post(b.owner, [{ priority: 9 }, { priority: 8 }], 0, 10)
    pool.settle(10)
    // Granted (a-low is worth less than 9 / 1.5), but nothing is given up yet
    expect(pool.post(b.owner, [], 0, 10)).toEqual([{ priority: 9 }])
    expect(yielded).toEqual([])
    // b's page arrives: allocating without claiming takes nothing, claiming asks a to yield
    expect(pool.allocate(b.owner, 60, 9)).toBe(-1)
    expect(pool.allocate(b.owner, 60, 9, true)).toBe(CLAIMED)
    expect(yielded).toEqual([low])
    expect(a.evicted).toEqual([])
    // A yielding slot is not claimed twice
    expect(pool.allocate(b.owner, 70, 9, true)).toBe(-1)
    expect(yielded).toEqual([low])
    expect(pool.availableSlots(155)).toBe(0)
    // Even unprotected by use, a yielding slot waits out its yieldMs: only a-high counts
    pool.protectMs = 1
    expect(pool.availableSlots(155)).toBe(1)
    pool.protectMs = 10_000
    expect(pool.availableSlots(160)).toBe(1)
    expect(b.place(pool, "b1", 160, 9)).toBe(low)
    expect(a.evicted).toEqual(["a-low"])
  })

  it("gives a claimed slot at once when its owner shows nothing of it, and lets an owner drop a slot's value without using it", () => {
    const pool = new ResidencyPool({ slots: 1, protectMs: 10_000, budget: false })
    const a = makeOwner()
    a.owner.yield = () => false
    const b = makeOwner()
    a.place(pool, "a1", 0, 100)
    const slot = [...a.held.keys()][0]
    // Worth too much to contest, until its owner says it no longer needs it
    expect(pool.allocate(b.owner, 10, 9, true)).toBe(-1)
    pool.setValue(slot, 0)
    expect(pool.allocate(b.owner, 20, 9, true)).toBe(slot)
    expect(a.evicted).toEqual(["a1"])
  })

  it("with contestOwn, lets an owner alone in a full pool trade its own least valued slot for a want worth more", () => {
    const pool = new ResidencyPool({ slots: 2, protectMs: 10_000, budget: false, contestOwn: true })
    const a = makeOwner(["root"])
    const yielded: number[] = []
    a.owner.yield = (slot) => yielded.push(slot)
    a.place(pool, "root", 0, 100)
    a.place(pool, "leaf", 0, 2)
    const leaf = [...a.held].find(([, item]) => item === "leaf")![0]
    const decide = (priority: number, now: number) => {
      pool.post(a.owner, [{ priority }], 0, now)
      pool.settle(now)
      return pool.post(a.owner, [], 0, now)
    }
    expect(decide(2.5, 10)).toEqual([])
    expect(decide(5, 20)).toEqual([{ priority: 5 }])
    expect(pool.allocate(a.owner, 30, 5, true)).toBe(CLAIMED)
    expect(yielded).toEqual([leaf])
    pool.contestOwn = false
    expect(decide(500, 40)).toEqual([])
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

  it("sets a cutoff from the posted demand that fits the slots, ignores wants below it, and lowers it only past its band", () => {
    // Wants at the cutoff itself still count, so wants worth Infinity are never turned away
    const pool = new ResidencyPool({ slots: 10, cutoffHeadroom: 0.2, cutoffBand: 0.1 })
    const a = makeOwner()
    const b = makeOwner()
    // One frame of both owners posting; the next frame's first post settles it and returns a's grants
    const frame = (demandA: number[], demandB: number[], wantsA: { priority: number }[], now: number) => {
      const granted = pool.post(a.owner, wantsA, 0, now, demandA)
      pool.post(b.owner, [], 0, now, demandB)
      return granted
    }
    // 8 of 10 slots to fill (20% headroom) from 12 demanded values: the cutoff is the 9th largest
    const wants = [{ priority: 9 }, { priority: 4 }, { priority: 3.5 }]
    frame([12, 11, 10, 9, 8, 7], [6, 5, 4, 3, 2, 1], wants, 0)
    const granted = frame([12, 11, 10, 9, 8, 7], [6, 5, 4, 3, 2, 1], wants, 1)
    expect(pool.cutoff).toBe(4)
    expect(granted).toEqual([{ priority: 9 }, { priority: 4 }])
    // Demand eases a little: inside the band, the cutoff holds
    frame([12, 11, 10, 9, 8, 7], [6, 5, 3.9], [], 2)
    frame([12, 11, 10, 9, 8, 7], [6, 5, 3.9], [], 3)
    expect(pool.cutoff).toBe(4)
    // Well below: it follows
    frame([12, 11, 10], [6, 5], [], 4)
    frame([12, 11, 10], [6, 5], [], 5)
    expect(pool.cutoff).toBe(0)
    // Off with the budget
    pool.budget = false
    frame([12, 11, 10, 9, 8, 7], [6, 5, 4, 3, 2, 1], [], 6)
    frame([12, 11, 10, 9, 8, 7], [6, 5, 4, 3, 2, 1], [], 7)
    expect(pool.cutoff).toBe(0)
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
