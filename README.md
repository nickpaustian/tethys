# Tethys

Shared budgets for modules that stream. A **fetch pool**: one connection budget, priorities that cross module boundaries, and a bandwidth figure. A **residency pool**: one memory budget of equal slots shared by many owners, with eviction, ranking and a detail scale across them. Both are engine-free. [Atlas](https://github.com/nickpaustian/atlas) and [Theia](https://github.com/nickpaustian/theia) build their shared atlases and arenas on the residency pool, and take a client of the fetch pool when one is given.

Tethys is the Titaness of the fresh water that feeds every river, which is what the pool is to the modules that drink from it.

## Install

```
npm install @nickpaustian/tethys
```

No dependencies. Atlas and Theia depend on it for `ResidencyPool`. For the fetch pool they declare their own `PoolClient` interface (`submit` returning a ticket with `setPriority`, `cancel` and `started`), which Tethys's client satisfies, as does any object with the same shape.

## Why

The browser gives one bandwidth pool and a small connection budget per host. Two streaming modules each running their own concurrency compete blind: texture tiles can starve geometry pages, and neither knows how fast bytes are arriving. The pool owns when each fetch starts and measures what comes in. Each module keeps its own queue semantics (what it wants, restated every pass, dropped when no longer wanted, aborted when stale), so nothing about their behaviour changes except who says go.

## Usage

```ts
import { FetchPool } from "@nickpaustian/tethys"

const pool = new FetchPool({ concurrency: 12 })
const mesh = await ClusteredMesh.load(url, { pool: pool.client("theia", { weight: 1 }) })
const vt = new VirtualTexture({ channels, pool: pool.client("atlas", { weight: 0.8 }) })

pool.stats.bytesPerSecond // over the last two seconds, for a detail cap policy
```

A client submits each fetch with a priority normalised within the module (its most wanted item is 1). The pool starts the waiting request with the highest `weight × priority` whenever a slot is free, oldest first on ties, after any client that is still under its `reserve`. Giving geometry the higher weight is a reasonable default, because a missing page reads as a hole where a missing tile reads as a soft texture. A waiting request can be withdrawn or re-prioritised; a running one is left to its module's own abort handling, which frees the slot when the fetch settles.

Theia submits a ticket per page and gathers its coalesced range request only when the pool starts one, so neighbours that arrived in the queue since are still pulled in. Atlas submits a ticket per tile.

## Options

`new FetchPool(options)`:

| option | default | meaning |
| --- | --- | --- |
| `concurrency` | 12 | fetches in flight at once across every client |
| `bandwidthWindowMs` | 2000 | milliseconds of received bytes the bandwidth estimate averages over |

`pool.client(name, options)` returns the client for `name`, creating it on first use:

| option | default | meaning |
| --- | --- | --- |
| `weight` | 1 | relative share of the pool; a request is ordered by weight × its own priority |
| `reserve` | 0 | connections the client is owed before weight and priority decide: while it has fewer than this in flight, its waiting request starts ahead of every other client's. A module with small frequent fetches (tiles, a few kilobytes each) is otherwise starved by one whose fetches rank higher for seconds at a time (geometry pages after a zoom); a reserve of a quarter of the pool for each keeps both moving |

## Writing a client

```ts
const client = pool.client("tiles", { weight: 0.8 })

const ticket = client.submit(priority, async ({ progress }) => {
  const response = await fetch(url)
  for await (const chunk of response.body) progress(chunk.byteLength)
}, () => { /* called if the ticket is cancelled before it starts */ })

ticket.setPriority(0.4)   // while still waiting
ticket.cancel()           // withdraw a waiting request
ticket.started            // true once the run has begun
```

`submit(priority, run, onCancel?)` queues a run and returns a ticket. `client.inFlight` is how many of its runs are going. `run` receives a context whose `progress(bytes)` feeds the bandwidth estimate; the slot is freed when the run's promise settles, however it settles. The pool never aborts a running fetch; that stays with the client. `client.weight` can be changed at any time.

## Stats

`pool.stats` returns:

| field | meaning |
| --- | --- |
| `concurrency` | the pool's budget |
| `inFlight`, `queued` | requests running and waiting across all clients |
| `bytesPerSecond` | received bytes over the last `bandwidthWindowMs` |
| `clients[]` | per client: `name`, `weight`, `reserve`, `queued`, `inFlight`, `started`, `bytes` |

## Residency pool

Many owners keeping things resident in one store of equal slots: geometry pages in a vertex arena, tiles in a texture atlas, anything with a fixed cost per slot. The storage stays with whoever owns it; the pool decides which slot each new thing goes in and which owner loses one, so a scene's objects share one budget and detail goes where the screen needs it.

```ts
import { ResidencyPool, type ResidencyOwner } from "@nickpaustian/tethys"

const pool = new ResidencyPool({ slots: 4096 })

const owner: ResidencyOwner = {
  pinned: (slot) => slot === myRootSlot,        // never taken (a root page)
  evict: (slot) => forget(slot),                // the pool gave this slot to someone else
  yield: (slot) => fadeOut(slot),               // optional: claimed, goes in yieldMs
}

// Each frame: post what is wanted, with priorities every owner shares (projected error in
// pixels, screen coverage), and how many are in flight; act on what the last settle granted
for (const want of pool.post(owner, wanted, inFlight, performance.now())) request(want)

// When something arrives, with the priority it was wanted at
const slot = pool.allocate(owner, performance.now(), priority)   // -1 when none can be had

// Each frame, for what is in use and what it is worth (what it would be asked for again with)
pool.touch(slot, performance.now(), value)

detail.threshold = pixelError * pool.scale             // or a texture lod bias of log2(pool.scale)
pool.release(owner)                                    // the owner goes: its slots are free
```

- **Eviction.** Slots go free first, then least recently used across owners. The owner of a slot taken is told through `evict` before `allocate` returns. A slot `pinned` by its owner is never taken.
- **Contesting.** A slot touched within `protectMs` is safe from LRU and from its own owner's wants, but not from another owner whose want is worth more than `contestMargin` times the slot's value (the least valued goes first). So an owner arriving to a full pool gets what others hold for less than it is worth to it, and the split between owners follows what each one's detail is worth rather than who came first. The margin keeps two owners with like needs from trading slots back and forth. Values come from `touch(slot, now, value)`, in the measure wants are ranked by; a slot never given one is never contested (`allocate` gives it the priority it was claimed with).
- **Yielding.** Taking a slot that is in use shows: whatever it held vanishes from one frame to the next. The settle only reserves contested slots; nothing is given up until what was wanted arrives. Then `allocate(owner, now, priority, true)` claims the least valued slot it contests: an owner with a `yield` hook is told and keeps it for `yieldMs` to fade out what it holds, and `allocate` returns `CLAIMED`; the claimant holds its data and calls again (without claiming) until the slot, now the first one `allocate` takes, is free. A yielding slot is not claimed twice, and is not taken before its `yieldMs` is up even when its owner has stopped using it. An owner without the hook loses a contested slot as soon as the claimant allocates; one whose `yield` returns `false` (nothing of the slot is showing, say it is off screen) gives it up at once too.
- **Dropping a value.** `setValue(slot, value)` changes what a slot is worth without counting it as used: an owner that no longer needs something sets it to 0, and any want may claim it while it is still protected, rather than waiting `protectMs` for it to become least recently used.
- **Contesting your own.** With `contestOwn`, an owner's want may take its own slots the same way, so even one owner alone in a full pool trades what it holds for what is worth more, one swap at a time as things arrive, and needs no scale to make room.
- **Cutoff.** An owner that passes its `demand` to `post` (the value of everything its cut holds or wants) shares in a `cutoff`: the value of the slots-th most valuable thing across every owner's demand, less `cutoffHeadroom`. Wants worth less are not granted, so owners ask for no more than fits. It rises at once and falls once demand drops a `cutoffBand` below it; values of Infinity (the camera inside something's bounds) are never turned away.
- **Ranking, once a frame.** Each owner posts what it wants with priorities and how many it has in flight. `settle(now)` ranks every post since the last settle in one pass: the highest wants take the free capacity left after every owner's in-flight count, those further down whatever slots they can contest, and the scale is judged once. `post` returns the owner's grants from the last settle, so wants are acted on a frame after they are posted; act on those still wanted. The pool settles by itself when an owner posts a second time, since a new frame has begun, so a host need not call `settle`; calling it after every owner's update decides within the frame instead. An owner that posted nothing counts as wanting nothing, so one that stops updating (frozen, off screen) holds no share of what is handed out. The decision is the same whatever order owners update in, and costs one ranking a frame however many owners there are.
- **Scale.** Once nothing is free and nothing is worth contesting, nothing moves. `scale` then rises (× `raiseBy`) while more is wanted than fits and nothing was placed in the last `budgetIntervalMs`, and falls back toward 1 (÷ `easeBy`) once wants are met and `budgetHeadroom` of the slots is free. Owners apply it to their own detail measure, so every owner coarsens evenly.

`new ResidencyPool(options)`:

| option | default | meaning |
| --- | --- | --- |
| `slots` | required | things resident at once across every owner |
| `capacity` | `slots` | units of storage the things share when they cost different amounts: `allocate(owner, now, priority, claim, cost)` makes room by the unit (least recently used first, then contested slots, as many as the cost needs, giving nothing up unless enough can be), wants carry a `cost`, `pending` is in units, and the cutoff counts each `demand` value at its `demandCosts` entry. Theia's arena counts blocks, a page costing one a cluster |
| `protectMs` | 500 | milliseconds a used slot is safe from being taken |
| `contestMargin` | 1.5 | how many times a protected slot's value another owner's want must exceed to take it |
| `yieldMs` | 250 | milliseconds an owner with a `yield` hook keeps a contested slot before it goes |
| `contestOwn` | false | let an owner's wants contest its own protected slots too |
| `cutoffHeadroom` | 0.05 | share of the slots the cutoff leaves free for arrivals and fades |
| `cutoffBand` | 0.1 | how far demand must fall below the cutoff before it is lowered |
| `budget` | true | whether `scale` follows what fits; off, it stays where it is |
| `budgetIntervalMs` | 600 | milliseconds between scale decisions; keep it longer than `protectMs` |
| `budgetHeadroom` | 0.1 | free share of the slots below which the scale is not lowered |
| `raiseBy`, `easeBy` | 1.25, 1.1 | the scale's steps up and down (Atlas uses √2 and 2^¼, half a level up and a quarter down) |
| `maxScale` | 64 | largest the scale may grow |

`pool.stats` gives `owners`, `slots`, `freeSlots`, `scale` and `cutoff`; `pool.statsOf(owner)` its `slots`, `wanted` and `pending`. `vacantSlots`, `availableSlots(now)` and `ownerOf(slot)` read the state; `free(slot)` gives one slot back; `join(owner)` counts an owner before it holds anything.

## Development

```
npm ci
npm test            # vitest: ordering, re-prioritising and cancelling, slot accounting, the bandwidth window; residency eviction, protection and pins, contesting by value, yielding, ranking across owners at a settle, settling by itself a frame late, the scale
npm run typecheck
npm run build       # dist/
```

CI runs typecheck, tests and build on every push and pull request, and publishes to npm with provenance on a `v*` tag.

## Licence

MIT.
