# Tethys

A shared fetch pool for modules that stream: one connection budget, priorities that cross module boundaries, and a bandwidth figure. Optional; [Atlas](https://github.com/nickpaustian/atlas) and [Theia](https://github.com/nickpaustian/theia) each stream on their own without it, and take a client of it when both are present.

Tethys is the Titaness of the fresh water that feeds every river, which is what the pool is to the modules that drink from it.

## Install

```
npm install @nickpaustian/tethys
```

No dependencies. Atlas and Theia do not depend on this package: each declares its own `PoolClient` interface (`submit` returning a ticket with `setPriority`, `cancel` and `started`), which Tethys's client satisfies, as does any object with the same shape.

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

## Development

```
npm ci
npm test            # vitest: ordering, re-prioritising and cancelling, slot accounting, the bandwidth window
npm run typecheck
npm run build       # dist/
```

CI runs typecheck, tests and build on every push and pull request, and publishes to npm with provenance on a `v*` tag.

## Licence

MIT.
