export interface ResidencyOwner {
  // Must this slot keep what it holds whatever else is evicted (a root page, say)?
  pinned(slot: number): boolean
  // The pool gave this slot to something else; forget what it held
  evict(slot: number): void
}

export interface ResidencyOffer {
  // In a measure every owner shares (projected error in pixels, screen coverage), so offers
  // rank across owners
  priority: number
}

export interface ResidencyPoolOptions {
  // Things resident at once, across every owner
  slots: number
  // Milliseconds a used slot is safe from being taken
  protectMs?: number
  // Milliseconds an owner's offer counts in the ranking after it was made
  offerMs?: number
  // How many times a slot's value another owner's want must exceed to take it while it is
  // protected; above 1 so two owners with like needs do not trade the same slots back and forth
  contestMargin?: number
  // Whether the budget adjusts `scale`; off, it stays where it is
  budget?: boolean
  // Milliseconds between budget decisions; longer than protectMs, since a change shows only
  // once the old cut leaves protection
  budgetIntervalMs?: number
  // Free share of the slots below which the scale is not lowered
  budgetHeadroom?: number
  // What the scale is multiplied by when the pool is stuck, and divided by as room returns
  raiseBy?: number
  easeBy?: number
  // Largest the scale may grow
  maxScale?: number
}

export interface ResidencyOwnerStats {
  slots: number
  wanted: number
  pending: number
}

export interface ResidencyPoolStats {
  owners: number
  slots: number
  freeSlots: number
  scale: number
}

// One budget of equal slots shared by every owner that keeps things resident: geometry pages,
// texture tiles, anything with a fixed cost per slot. The storage itself stays with whoever
// owns it; the pool decides which slot each new thing goes in and which owner loses one.
//
// Slots are handed out free first, then least recently used across owners; the owner of a slot
// taken is told through `evict`. A slot pinned by its owner is never taken. A slot used within
// `protectMs` is safe from its own owner's wants and from LRU, but not from another owner whose
// want is worth more: owners give each slot a value when they use it, in the measure their
// wants are ranked by (what the page would be worth to ask for again), and a want worth more
// than `contestMargin` times a protected slot's value may take it. So an owner that arrives to
// a full pool gets the slots another holds for less than they are worth to it, and the split
// between owners follows what each one's detail is worth rather than who came first. A slot
// given no value is never contested.
//
// Requests are ranked across owners too. Each owner offers what it wants with priorities and
// how many it already has in flight; the pool ranks every owner's latest offer together and
// grants the asking owner only those of its wants that fall within the free capacity. No owner
// waits on another, so one that stops offering (frozen, off screen) stalls nothing; its last
// offer ages out.
//
// Once nothing is free and nothing is worth contesting, nothing moves, so the budget works on
// what is wanted instead: `scale` rises while more is wanted than fits and
// nothing was placed in the last interval, and falls back toward 1 once wants are met with
// room to spare. Owners apply it to their own detail measure: a pixel error multiplies by it,
// a texture lod bias adds log2 of it.
export default class ResidencyPool {
  public readonly slots: number
  public protectMs: number
  public offerMs: number
  public contestMargin: number
  public budget: boolean
  public budgetIntervalMs: number
  public budgetHeadroom: number
  public raiseBy: number
  public easeBy: number
  public maxScale: number
  // What every owner's detail measure is scaled by to fit; 1 when everything wanted fits
  public scale: number = 1
  private readonly owners: (ResidencyOwner | null)[]
  private readonly lastUsed: Float64Array
  private readonly values: Float64Array
  // The free slots as a stack, so taking or freeing one is O(1)
  private readonly freeSlots: Int32Array
  private freeSlotCount: number
  private allocations: number = 0
  private allocationsAtBudget: number = 0
  private lastBudget: number = -Infinity
  private readonly offers: Map<ResidencyOwner, { at: number; pending: number; wanted: ResidencyOffer[] }> = new Map()
  private readonly members: Set<ResidencyOwner> = new Set()

  constructor({
    slots,
    protectMs = 500,
    offerMs = 250,
    contestMargin = 1.5,
    budget = true,
    budgetIntervalMs = 600,
    budgetHeadroom = 0.1,
    raiseBy = 1.25,
    easeBy = 1.1,
    maxScale = 64,
  }: ResidencyPoolOptions) {
    if (!(slots >= 1)) throw new Error(`ResidencyPool: needs at least one slot, got ${slots}`)
    this.slots = Math.floor(slots)
    this.protectMs = protectMs
    this.offerMs = offerMs
    this.contestMargin = contestMargin
    this.budget = budget
    this.budgetIntervalMs = budgetIntervalMs
    this.budgetHeadroom = budgetHeadroom
    this.raiseBy = raiseBy
    this.easeBy = easeBy
    this.maxScale = maxScale
    this.owners = new Array(this.slots).fill(null)
    this.lastUsed = new Float64Array(this.slots)
    this.values = new Float64Array(this.slots).fill(Infinity)
    this.freeSlots = new Int32Array(this.slots)
    for (let i = 0; i < this.slots; i++) this.freeSlots[i] = this.slots - 1 - i
    this.freeSlotCount = this.slots
  }

  // Counts an owner in the stats before it holds anything; allocating joins it too
  public join(owner: ResidencyOwner): void {
    this.members.add(owner)
  }

  public ownerOf(slot: number): ResidencyOwner | null {
    return this.owners[slot]
  }

  // Used now; `value`, when given, is what the slot's contents are worth to its owner
  public touch(slot: number, now: number, value?: number): void {
    this.lastUsed[slot] = now
    if (value !== undefined) this.values[slot] = value
  }

  public get vacantSlots(): number {
    return this.freeSlotCount
  }

  private evictable(slot: number, minUsed: number): boolean {
    const owner = this.owners[slot]
    return owner !== null && this.lastUsed[slot] < minUsed && !owner.pinned(slot)
  }

  // Slots something new could take now: free ones and those neither protected nor pinned
  public availableSlots(now: number): number {
    const minUsed = now - this.protectMs
    let count = this.freeSlotCount
    for (let slot = 0; slot < this.slots; slot++) if (this.evictable(slot, minUsed)) count++
    return count
  }

  // A slot for `owner`'s want of this priority: a free one, else the least recently used that
  // may be taken, else the least valued protected slot of another owner that the priority
  // contests; its owner is told before this returns. -1 when none can be had. The priority is
  // the slot's value until its owner touches it with another
  public allocate(owner: ResidencyOwner, now: number, priority: number = Infinity): number {
    this.members.add(owner)
    let slot: number
    if (this.freeSlotCount > 0) {
      slot = this.freeSlots[--this.freeSlotCount]
    } else {
      const minUsed = now - this.protectMs
      slot = -1
      let oldest = Infinity
      for (let s = 0; s < this.slots; s++) {
        if (!this.evictable(s, minUsed)) continue
        if (this.lastUsed[s] < oldest) {
          oldest = this.lastUsed[s]
          slot = s
        }
      }
      if (slot === -1 && priority !== Infinity) slot = this.cheapestContestable(owner, priority, now)
      if (slot === -1) return -1
      this.owners[slot]!.evict(slot)
    }
    this.owners[slot] = owner
    this.lastUsed[slot] = now
    this.values[slot] = priority
    this.allocations++
    return slot
  }

  // A protected slot of another owner whose value `priority` beats by the margin, least valued first
  private cheapestContestable(owner: ResidencyOwner, priority: number, now: number): number {
    const minUsed = now - this.protectMs
    let best = -1
    let lowest = priority / this.contestMargin
    for (let s = 0; s < this.slots; s++) {
      const holder = this.owners[s]
      if (holder === null || holder === owner || this.lastUsed[s] < minUsed || this.values[s] >= lowest || holder.pinned(s)) continue
      lowest = this.values[s]
      best = s
    }
    return best
  }

  // Give back a slot its owner no longer needs
  public free(slot: number): void {
    if (!this.owners[slot]) return
    this.owners[slot] = null
    this.freeSlots[this.freeSlotCount++] = slot
  }

  // Offer what `owner` wants and how many it has in flight; returns the wants it may act on
  // now. Every owner's latest offer is ranked together: the highest take the free capacity left
  // once every owner's pending ones are counted, and the rest may each claim a protected slot of
  // another owner that they contest, least valued first
  public offer<T extends ResidencyOffer>(owner: ResidencyOwner, wanted: T[], pending: number, now: number): T[] {
    this.members.add(owner)
    this.offers.set(owner, { at: now, pending, wanted })
    let free = this.availableSlots(now)
    const ranked: Array<{ owner: ResidencyOwner; offer: ResidencyOffer }> = []
    for (const [who, o] of this.offers) {
      if (now - o.at > this.offerMs) {
        this.offers.delete(who)
        continue
      }
      free -= o.pending
      for (const w of o.wanted) ranked.push({ owner: who, offer: w })
    }
    ranked.sort((a, b) => b.offer.priority - a.offer.priority)
    const granted: T[] = []
    let placeable = 0
    let contestable: Array<{ owner: ResidencyOwner; value: number }> | null = null
    for (const { owner: who, offer: want } of ranked) {
      if (free > 0) {
        free--
      } else {
        contestable ??= this.contestable(now)
        const at = contestable.findIndex((c) => c.owner !== who && want.priority > c.value * this.contestMargin)
        if (at === -1) continue
        contestable.splice(at, 1)
      }
      placeable++
      if (who === owner) granted.push(want as T)
    }
    this.adjustBudget(now, placeable)
    return granted
  }

  // Protected slots that hold a value, least valued first
  private contestable(now: number): Array<{ owner: ResidencyOwner; value: number }> {
    const minUsed = now - this.protectMs
    const slots: Array<{ owner: ResidencyOwner; value: number }> = []
    for (let s = 0; s < this.slots; s++) {
      const holder = this.owners[s]
      if (holder === null || this.lastUsed[s] < minUsed || this.values[s] === Infinity || holder.pinned(s)) continue
      slots.push({ owner: holder, value: this.values[s] })
    }
    return slots.sort((a, b) => a.value - b.value)
  }

  private adjustBudget(now: number, placeable: number): void {
    if (!this.budget || now - this.lastBudget < this.budgetIntervalMs) return
    let wanted = 0
    let pending = 0
    for (const o of this.offers.values()) {
      wanted += o.wanted.length
      pending += o.pending
    }
    const placed = this.allocations - this.allocationsAtBudget
    this.allocationsAtBudget = this.allocations
    this.lastBudget = now
    if (wanted > placeable && placed === 0) this.scale = Math.min(this.maxScale, this.scale * this.raiseBy)
    else if (wanted === 0 && pending === 0 && this.scale > 1 && this.availableSlots(now) > this.slots * this.budgetHeadroom) this.scale = Math.max(1, this.scale / this.easeBy)
  }

  // Forget an owner: its slots are free and its offer withdrawn. It is not told
  public release(owner: ResidencyOwner): void {
    for (let slot = 0; slot < this.slots; slot++) if (this.owners[slot] === owner) this.free(slot)
    this.offers.delete(owner)
    this.members.delete(owner)
  }

  public statsOf(owner: ResidencyOwner): ResidencyOwnerStats {
    let slots = 0
    for (let slot = 0; slot < this.slots; slot++) if (this.owners[slot] === owner) slots++
    const offer = this.offers.get(owner)
    return { slots, wanted: offer?.wanted.length ?? 0, pending: offer?.pending ?? 0 }
  }

  public get stats(): ResidencyPoolStats {
    return { owners: this.members.size, slots: this.slots, freeSlots: this.freeSlotCount, scale: this.scale }
  }
}
