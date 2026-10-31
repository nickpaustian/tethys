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
// taken is told through `evict`. A slot used within `protectMs`, or pinned by its owner, is
// never taken.
//
// Requests are ranked across owners too. Each owner offers what it wants with priorities and
// how many it already has in flight; the pool ranks every owner's latest offer together and
// grants the asking owner only those of its wants that fall within the free capacity. No owner
// waits on another, so one that stops offering (frozen, off screen) stalls nothing; its last
// offer ages out.
//
// Ranking only shares out free capacity. Once every slot is protected nothing moves, so the
// budget works on what is wanted instead: `scale` rises while more is wanted than fits and
// nothing was placed in the last interval, and falls back toward 1 once wants are met with
// room to spare. Owners apply it to their own detail measure: a pixel error multiplies by it,
// a texture lod bias adds log2 of it.
export default class ResidencyPool {
  public readonly slots: number
  public protectMs: number
  public offerMs: number
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
    this.budget = budget
    this.budgetIntervalMs = budgetIntervalMs
    this.budgetHeadroom = budgetHeadroom
    this.raiseBy = raiseBy
    this.easeBy = easeBy
    this.maxScale = maxScale
    this.owners = new Array(this.slots).fill(null)
    this.lastUsed = new Float64Array(this.slots)
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

  public touch(slot: number, now: number): void {
    this.lastUsed[slot] = now
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

  // A slot for `owner`: a free one, else the least recently used that may be taken, whose owner
  // is told before this returns. -1 when every slot is protected or pinned
  public allocate(owner: ResidencyOwner, now: number): number {
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
      if (slot === -1) return -1
      this.owners[slot]!.evict(slot)
    }
    this.owners[slot] = owner
    this.lastUsed[slot] = now
    this.allocations++
    return slot
  }

  // Give back a slot its owner no longer needs
  public free(slot: number): void {
    if (!this.owners[slot]) return
    this.owners[slot] = null
    this.freeSlots[this.freeSlotCount++] = slot
  }

  // Offer what `owner` wants and how many it has in flight; returns the wants it may act on
  // now: those that rank within the free capacity once every owner's pending ones are counted
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
    this.adjustBudget(now, free)
    if (free <= 0 || wanted.length === 0) return []
    ranked.sort((a, b) => b.offer.priority - a.offer.priority)
    const granted: T[] = []
    for (let i = 0; i < Math.min(free, ranked.length); i++) if (ranked[i].owner === owner) granted.push(ranked[i].offer as T)
    return granted
  }

  private adjustBudget(now: number, free: number): void {
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
    if (wanted > Math.max(0, free) && placed === 0) this.scale = Math.min(this.maxScale, this.scale * this.raiseBy)
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
