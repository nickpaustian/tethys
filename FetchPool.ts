export interface FetchPoolOptions {
  // Fetches in flight at once across every client
  concurrency?: number
  // Milliseconds of received bytes the bandwidth estimate averages over
  bandwidthWindowMs?: number
}

export interface PoolClientOptions {
  // Relative share of the pool: a request is ordered by weight x its own priority, so a client
  // whose work matters more when both are starved gets a higher weight
  weight?: number
  // Connections the client is owed before weight and priority decide: while it has fewer than
  // this in flight, its waiting request starts ahead of every other client's, so a module with
  // small frequent fetches (tiles) is not starved by one with large valuable ones (pages)
  reserve?: number
}

export interface PoolTicket {
  // Restate the request's priority (0..1 within its client) while it is still waiting
  setPriority(priority: number): void
  // Withdraw a waiting request; a running one is left to its own abort handling
  cancel(): void
  readonly started: boolean
}

export interface PoolRunContext {
  // Report bytes as they arrive so the pool can measure bandwidth
  progress: (bytes: number) => void
}

export type PoolRun = (context: PoolRunContext) => Promise<void>

export interface PoolClientStats {
  name: string
  weight: number
  reserve: number
  queued: number
  inFlight: number
  started: number
  bytes: number
}

export interface FetchPoolStats {
  concurrency: number
  inFlight: number
  queued: number
  // Over the bandwidth window
  bytesPerSecond: number
  clients: PoolClientStats[]
}

interface Entry {
  client: PoolClient
  priority: number
  run: PoolRun
  onCancel?: () => void
  started: boolean
  order: number
}

// One connection budget shared by every module that streams: each module keeps its own queue
// (what it wants, restated every pass, aborted when stale) and submits fetches here with a
// priority normalised within itself; the pool starts the highest weight x priority across
// clients whenever a slot is free and measures the bytes they bring in, so one bandwidth figure
// can drive every module's detail cap.
export default class FetchPool {
  public readonly concurrency: number
  private readonly bandwidthWindowMs: number
  private waiting: Entry[] = []
  private inFlight: number = 0
  private order: number = 0
  private disposed: boolean = false
  // Bytes per 250 ms bucket, oldest first
  private buckets: Array<{ at: number; bytes: number }> = []
  private clients: Map<string, PoolClient> = new Map()

  constructor({ concurrency = 12, bandwidthWindowMs = 2000 }: FetchPoolOptions = {}) {
    this.concurrency = concurrency
    this.bandwidthWindowMs = bandwidthWindowMs
  }

  public client(name: string, { weight = 1, reserve = 0 }: PoolClientOptions = {}): PoolClient {
    let client = this.clients.get(name)
    if (!client) {
      client = new PoolClient(this, name, weight, reserve)
      this.clients.set(name, client)
    } else {
      client.weight = weight
      client.reserve = reserve
    }
    return client
  }

  // Called by PoolClient.submit
  public enqueue(client: PoolClient, priority: number, run: PoolRun, onCancel?: () => void): PoolTicket {
    const entry: Entry = { client, priority, run, onCancel, started: false, order: this.order++ }
    this.waiting.push(entry)
    this.pump()
    return {
      setPriority: (p) => {
        entry.priority = p
        if (!entry.started) this.pump()
      },
      cancel: () => {
        if (entry.started) return
        const at = this.waiting.indexOf(entry)
        if (at !== -1) this.waiting.splice(at, 1)
        entry.onCancel?.()
      },
      get started() {
        return entry.started
      },
    }
  }

  private pump(): void {
    if (this.disposed) return
    while (this.inFlight < this.concurrency && this.waiting.length > 0) {
      // A client under its reserve is owed the slot; among the owed, or among the rest, the
      // highest weight x priority wins, oldest first on ties
      let best = -1
      let bestOwed = false
      for (let i = 0; i < this.waiting.length; i++) {
        const a = this.waiting[i]
        const owed = a.client.inFlight < a.client.reserve
        if (best !== -1) {
          if (bestOwed && !owed) continue
          if (owed === bestOwed) {
            const b = this.waiting[best]
            const ea = a.client.weight * a.priority, eb = b.client.weight * b.priority
            if (!(ea > eb || (ea === eb && a.order < b.order))) continue
          }
        }
        best = i
        bestOwed = owed
      }
      const [entry] = this.waiting.splice(best, 1)
      entry.started = true
      this.inFlight++
      entry.client.onStart()
      const context: PoolRunContext = {
        progress: (bytes) => {
          entry.client.onBytes(bytes)
          this.record(bytes)
        },
      }
      entry.run(context).catch(() => undefined).finally(() => {
        this.inFlight--
        entry.client.onFinish()
        this.pump()
      })
    }
  }

  private record(bytes: number): void {
    const now = performance.now()
    const last = this.buckets[this.buckets.length - 1]
    if (last && now - last.at < 250) last.bytes += bytes
    else this.buckets.push({ at: now, bytes })
    while (this.buckets.length > 0 && now - this.buckets[0].at > this.bandwidthWindowMs) this.buckets.shift()
  }

  // Bytes per second received over the window; 0 while nothing has arrived recently
  public get bytesPerSecond(): number {
    const now = performance.now()
    while (this.buckets.length > 0 && now - this.buckets[0].at > this.bandwidthWindowMs) this.buckets.shift()
    if (this.buckets.length === 0) return 0
    const bytes = this.buckets.reduce((n, b) => n + b.bytes, 0)
    const span = Math.max(250, now - this.buckets[0].at)
    return (bytes * 1000) / span
  }

  public get stats(): FetchPoolStats {
    return {
      concurrency: this.concurrency,
      inFlight: this.inFlight,
      queued: this.waiting.length,
      bytesPerSecond: this.bytesPerSecond,
      clients: [...this.clients.values()].map((c) => c.stats),
    }
  }

  public dispose(): void {
    this.disposed = true
    for (const entry of this.waiting) entry.onCancel?.()
    this.waiting = []
  }
}

// A module's handle on the pool: submits its fetches with a priority normalised within the
// module (0..1) and keeps its own counts
export class PoolClient {
  public weight: number
  public reserve: number
  public readonly name: string
  private pool: FetchPool
  private queued: number = 0
  private running: number = 0
  private started: number = 0
  private bytes: number = 0

  constructor(pool: FetchPool, name: string, weight: number, reserve: number = 0) {
    this.pool = pool
    this.name = name
    this.weight = weight
    this.reserve = reserve
  }

  public get inFlight(): number {
    return this.running
  }

  public submit(priority: number, run: PoolRun, onCancel?: () => void): PoolTicket {
    this.queued++
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      this.queued--
    }
    return this.pool.enqueue(
      this,
      priority,
      async (context) => {
        settle()
        await run(context)
      },
      () => {
        settle()
        onCancel?.()
      }
    )
  }

  public onStart(): void {
    this.running++
    this.started++
  }

  public onFinish(): void {
    this.running--
  }

  public onBytes(bytes: number): void {
    this.bytes += bytes
  }

  public get stats(): PoolClientStats {
    return { name: this.name, weight: this.weight, reserve: this.reserve, queued: this.queued, inFlight: this.running, started: this.started, bytes: this.bytes }
  }
}
