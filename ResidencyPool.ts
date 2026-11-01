export interface ResidencyOwner {
  // Must this slot keep what it holds whatever else is evicted (a root page, say)?
  pinned(slot: number): boolean
  // The pool gave this slot to something else; forget what it held
  evict(slot: number): void
  // Optional: another owner has claimed this slot, which goes in yieldMs; stop using what it
  // holds now (fade it out) so its going is not seen. Owners without it are evicted at once
  yield?(slot: number): void
}

export interface ResidencyWant {
  // In a measure every owner shares (projected error in pixels, screen coverage), so wants
  // rank across owners
  priority: number
}

export interface ResidencyPoolOptions {
  // Things resident at once, across every owner
  slots: number
  // Milliseconds a used slot is safe from being taken
  protectMs?: number
  // How many times a slot's value another owner's want must exceed to take it while it is
  // protected; above 1 so two owners with like needs do not trade the same slots back and forth
  contestMargin?: number
  // Milliseconds a contested slot whose owner can yield stays with it, to fade out what it holds
  yieldMs?: number
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
// given no value is never contested. An owner that can `yield` is told its slot is claimed and
// keeps it for `yieldMs`, so it can fade out what the slot holds rather than lose it from one
// frame to the next; the slot is then the first taken.
//
// Requests are ranked across owners once a frame. Each owner posts what it wants with
// priorities and how many it already has in flight; `settle` ranks every post since the last
// settle together, grants the highest the free capacity and the rest whatever slots they can
// contest, and judges the scale, all in one pass. A post returns the owner's grants from the
// last settle, so wants are acted on a frame after they are posted. The pool settles by itself
// when an owner posts a second time, since a new frame has then begun, so hosts need not call
// it; one may call it after every owner's update to decide within the frame. An owner that
// posted nothing counts as wanting nothing, so one that stops updating (frozen, off screen)
// holds no share of what is handed out.
//
// Once nothing is free and nothing is worth contesting, nothing moves, so the budget works on
// what is wanted instead: `scale` rises while more is wanted than fits and
// nothing was placed in the last interval, and falls back toward 1 once wants are met with
// room to spare. Owners apply it to their own detail measure: a pixel error multiplies by it,
// a texture lod bias adds log2 of it.
export default class ResidencyPool {
  public readonly slots: number
  public protectMs: number
  public contestMargin: number
  public yieldMs: number
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
  // When each slot was claimed from an owner that yields; -1 when it was not
  private readonly yieldingAt: Float64Array
  // The free slots as a stack, so taking or freeing one is O(1)
  private readonly freeSlots: Int32Array
  private freeSlotCount: number
  private allocations: number = 0
  private allocationsAtBudget: number = 0
  private lastBudget: number = -Infinity
  // What each owner posted since the last settle, what the last settle ranked, and its grants
  private posts: Map<ResidencyOwner, { pending: number; wanted: ResidencyWant[] }> = new Map()
  private settled: Map<ResidencyOwner, { pending: number; wanted: ResidencyWant[] }> = new Map()
  private readonly grants: Map<ResidencyOwner, ResidencyWant[]> = new Map()
  private readonly members: Set<ResidencyOwner> = new Set()

  constructor({
    slots,
    protectMs = 500,
    contestMargin = 1.5,
    yieldMs = 250,
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
    this.contestMargin = contestMargin
    this.yieldMs = yieldMs
    this.budget = budget
    this.budgetIntervalMs = budgetIntervalMs
    this.budgetHeadroom = budgetHeadroom
    this.raiseBy = raiseBy
    this.easeBy = easeBy
    this.maxScale = maxScale
    this.owners = new Array(this.slots).fill(null)
    this.lastUsed = new Float64Array(this.slots)
    this.values = new Float64Array(this.slots).fill(Infinity)
    this.yieldingAt = new Float64Array(this.slots).fill(-1)
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

  private yielded(slot: number, now: number): boolean {
    return this.yieldingAt[slot] >= 0 && now - this.yieldingAt[slot] >= this.yieldMs
  }

  // A yielding slot goes only once its owner has had yieldMs to fade it out, however long since
  // it was used: the owner stops using what it holds as soon as it is told
  private evictable(slot: number, now: number): boolean {
    const owner = this.owners[slot]
    if (owner === null || owner.pinned(slot)) return false
    return this.yieldingAt[slot] >= 0 ? this.yielded(slot, now) : this.lastUsed[slot] < now - this.protectMs
  }

  // Slots something new could take now: free ones, those neither protected nor pinned, and
  // those whose owner has had its time to yield
  public availableSlots(now: number): number {
    let count = this.freeSlotCount
    for (let slot = 0; slot < this.slots; slot++) if (this.evictable(slot, now)) count++
    return count
  }

  // A slot for `owner`'s want of this priority: a free one, else one whose owner has yielded
  // it, else the least recently used that may be taken, else the least valued protected slot of
  // another owner that cannot yield that the priority contests; its owner is told before this
  // returns. -1 when none can be had, as when a claimed slot is still yielding. The priority is
  // the slot's value until its owner touches it with another
  public allocate(owner: ResidencyOwner, now: number, priority: number = Infinity): number {
    this.members.add(owner)
    let slot: number
    if (this.freeSlotCount > 0) {
      slot = this.freeSlots[--this.freeSlotCount]
    } else {
      slot = -1
      let oldest = Infinity
      for (let s = 0; s < this.slots; s++) {
        if (!this.evictable(s, now)) continue
        const used = this.yielded(s, now) ? -Infinity : this.lastUsed[s]
        if (used < oldest) {
          oldest = used
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
    this.yieldingAt[slot] = -1
    this.allocations++
    return slot
  }

  // A protected slot of another owner that cannot yield, whose value `priority` beats by the
  // margin, least valued first
  private cheapestContestable(owner: ResidencyOwner, priority: number, now: number): number {
    const minUsed = now - this.protectMs
    let best = -1
    let lowest = priority / this.contestMargin
    for (let s = 0; s < this.slots; s++) {
      const holder = this.owners[s]
      if (holder === null || holder === owner || holder.yield || this.lastUsed[s] < minUsed || this.values[s] >= lowest || holder.pinned(s)) continue
      lowest = this.values[s]
      best = s
    }
    return best
  }

  // Give back a slot its owner no longer needs
  public free(slot: number): void {
    if (!this.owners[slot]) return
    this.owners[slot] = null
    this.yieldingAt[slot] = -1
    this.freeSlots[this.freeSlotCount++] = slot
  }

  // Post what `owner` wants this frame and how many it has in flight, replacing its last post;
  // returns its grants from the last settle, which it should act on as far as they are still
  // wanted. Settles first if the owner already posted since the last settle
  public post<T extends ResidencyWant>(owner: ResidencyOwner, wanted: T[], pending: number, now: number): T[] {
    this.members.add(owner)
    if (this.posts.has(owner)) this.settle(now)
    this.posts.set(owner, { pending, wanted })
    const granted = this.grants.get(owner) ?? []
    this.grants.delete(owner)
    return granted as T[]
  }

  // Ranks every post since the last settle: the highest wants take the free capacity left once
  // every owner's in-flight count is taken off, the rest each claim a protected slot of another
  // owner that they contest, least valued first. Then judges the scale
  public settle(now: number): void {
    this.settled = this.posts
    this.posts = new Map()
    this.grants.clear()
    let free = this.availableSlots(now)
    const ranked: Array<{ owner: ResidencyOwner; want: ResidencyWant }> = []
    for (const [owner, post] of this.settled) {
      free -= post.pending
      for (const want of post.wanted) ranked.push({ owner, want })
    }
    ranked.sort((a, b) => b.want.priority - a.want.priority)
    let placeable = 0
    let contestable: Array<{ slot: number; owner: ResidencyOwner; value: number; taken: boolean }> | null = null
    let cheapest = 0
    for (const { owner, want } of ranked) {
      if (free > 0) {
        free--
      } else {
        contestable ??= this.contestable(now)
        // The claim is the cheapest untaken slot of another owner below the want's limit
        while (cheapest < contestable.length && contestable[cheapest].taken) cheapest++
        const limit = want.priority / this.contestMargin
        let at = -1
        for (let i = cheapest; i < contestable.length && contestable[i].value < limit; i++) {
          if (!contestable[i].taken && contestable[i].owner !== owner) {
            at = i
            break
          }
        }
        if (at === -1) continue
        const claim = contestable[at]
        claim.taken = true
        // An owner that can yield keeps the slot a while to fade out what it holds; one that
        // cannot loses it when the claimant's page arrives
        if (claim.owner.yield) {
          this.yieldingAt[claim.slot] = now
          claim.owner.yield(claim.slot)
        }
      }
      placeable++
      let list = this.grants.get(owner)
      if (!list) this.grants.set(owner, (list = []))
      list.push(want)
    }
    this.adjustBudget(now, placeable)
  }

  // Protected slots that hold a value, least valued first
  private contestable(now: number): Array<{ slot: number; owner: ResidencyOwner; value: number; taken: boolean }> {
    const minUsed = now - this.protectMs
    const slots: Array<{ slot: number; owner: ResidencyOwner; value: number; taken: boolean }> = []
    for (let s = 0; s < this.slots; s++) {
      const holder = this.owners[s]
      if (holder === null || this.lastUsed[s] < minUsed || this.yieldingAt[s] >= 0 || this.values[s] === Infinity || holder.pinned(s)) continue
      slots.push({ slot: s, owner: holder, value: this.values[s], taken: false })
    }
    return slots.sort((a, b) => a.value - b.value)
  }

  private adjustBudget(now: number, placeable: number): void {
    if (!this.budget || now - this.lastBudget < this.budgetIntervalMs) return
    let wanted = 0
    let pending = 0
    for (const post of this.settled.values()) {
      wanted += post.wanted.length
      pending += post.pending
    }
    const placed = this.allocations - this.allocationsAtBudget
    this.allocationsAtBudget = this.allocations
    this.lastBudget = now
    if (wanted > placeable && placed === 0) this.scale = Math.min(this.maxScale, this.scale * this.raiseBy)
    else if (wanted === 0 && pending === 0 && this.scale > 1 && this.availableSlots(now) > this.slots * this.budgetHeadroom) this.scale = Math.max(1, this.scale / this.easeBy)
  }

  // Forget an owner: its slots are free and its posts and grants withdrawn. It is not told
  public release(owner: ResidencyOwner): void {
    for (let slot = 0; slot < this.slots; slot++) if (this.owners[slot] === owner) this.free(slot)
    this.posts.delete(owner)
    this.settled.delete(owner)
    this.grants.delete(owner)
    this.members.delete(owner)
  }

  public statsOf(owner: ResidencyOwner): ResidencyOwnerStats {
    let slots = 0
    for (let slot = 0; slot < this.slots; slot++) if (this.owners[slot] === owner) slots++
    const post = this.settled.get(owner)
    return { slots, wanted: post?.wanted.length ?? 0, pending: post?.pending ?? 0 }
  }

  public get stats(): ResidencyPoolStats {
    return { owners: this.members.size, slots: this.slots, freeSlots: this.freeSlotCount, scale: this.scale }
  }
}
