# stdb-localfirst

Offline-first layer for SpacetimeDB TypeScript modules. Reducers run on the
client first, are written to a durable intent log, and are delivered to the
server when a connection exists. The server stays the single source of truth;
the client only predicts.

```
click ──► run reducer locally ──► overlay (predicted rows) ──► UI
              │
              └──► intent log on disk ──► send when online ──► server re-executes
                                                                    │
                       rebase: drop overlay, replay pending ◄── server deltas ──► base
```

## What is where

| Path | Purpose |
|---|---|
| `packages/localfirst/src/server` | Submodule (`applied_intents`, purge schedule) and the `offlineReducer()` wrapper |
| `packages/localfirst/src/client` | `LocalFirst` engine: local store, executor, intent log, snapshot, syncer, SDK link, stores |
| `packages/localfirst/src/sys-shim` | Stub for the host-only `spacetime:sys@x.y` import so module code loads on the client |
| `packages/localfirst/src/testing` | Deterministic simulation: fake server, virtual network, fault-injecting storage |
| `packages/localfirst/test` | Unit, end-to-end (fake server) and DST tests |
| `examples/todo-module` | Real SpacetimeDB module using the library |
| `examples/todo-client` | Node demo against a real local server: offline, restart, sync, converge |

## Server side

```ts
import { schema, table, t } from 'spacetimedb/server';
import * as localfirst from 'stdb-localfirst/server';
import { installPurge, offlineReducer } from 'stdb-localfirst/server';

const todos = table({ name: 'todos', public: true }, {
  id: t.uuid().primaryKey(),        // client-chosen key
  title: t.string(),
  done: t.bool(),
  createdAt: t.timestamp(),
});

const spacetimedb = schema({ todos, lf: localfirst });   // mount the submodule
export default spacetimedb;

export const init = spacetimedb.init(ctx => installPurge(ctx.as.lf, {}));

export const createTodo = offlineReducer(spacetimedb, 'lf', { id: t.uuid(), title: t.string() },
  (ctx, { id, title }) => {
    ctx.db.todos.insert({ id, title, done: false, createdAt: ctx.clientTimestamp });
  });
```

`offlineReducer` appends two parameters, `intentId: uuid` and `clientTs: timestamp`.
On the server it checks `applied_intents` before running the body, so a
redelivered intent is a silent no-op. `installPurge` starts a scheduled reducer
that forgets markers older than the retention window (default 30 days). That
window is the contract: a client offline longer than that whose ack was lost
could run an intent twice.

## Client side

```ts
import { LocalFirst, OpfsStorage, createSdkLink } from 'stdb-localfirst/client';
import * as mod from 'my-module';                 // the module source itself
import { DbConnection, reducers } from './module_bindings';

const workingSet = { queries: ['SELECT * FROM todos'] };
const lf = await LocalFirst.open({ module: mod, reducers, storage: new OpfsStorage(), workingSet });

lf.call(mod.createTodo, { id: uuid(), title: 'buy milk' });   // predicted immediately, logged, queued

DbConnection.builder().withUri(URI).withDatabaseName(DB)
  .onConnect(conn => lf.connect(createSdkLink(conn, { workingSet, accessors: ['todos'] })))
  .onDisconnect(() => lf.disconnect())
  .build();
```

The client bundle must alias the host-only import to the shim:

```ts
// vite.config.ts
resolve: { alias: [{ find: /^spacetime:sys@.*$/, replacement: 'stdb-localfirst/sys-shim' }] }
```

Reads: `lf.db.todos.iter()`, `lf.db.todos.id.find(id)`, or reactive
`tableStore(lf, 'todos')` (Svelte store contract) and `useLocalTable(useSyncExternalStore, lf, 'todos')`.

## The rules a consumer follows

1. Rows created offline carry a client-chosen key passed as an argument. Auto-increment inserts are refused at prediction time.
2. Use `ctx.clientTimestamp` for "when the user did it"; `ctx.timestamp` is when the server committed it.
3. Declare the whole working set once. Tables not fully covered are marked `coverage: 'partial'`, where a cache miss means "unknown" and the call is queued without prediction (or thrown with `{ strict: true }`).
4. Await `handle.durable` before telling the user "saved". `handle.settled` resolves with `acked`, `failed` or `cancelled`.
5. When the server rejects an intent, later unsent intents that read or wrote what it wrote are cancelled and reported through `onIntent`.
6. Provide `beforeDrain` to refresh an auth token before the queue is sent after a long offline period.

## Durability design

- Intent log: framed `[len][crc32][payload]` records, two slots with generation header and commit marker. Compaction writes the other slot and switches only on success, so a torn rewrite never loses a durable intent. A failed append marks the slot dirty and the next write moves to a fresh slot.
- Snapshot: base layer only (server-confirmed rows), two slots, highest valid generation wins. Predicted rows are rebuilt from the log on boot, never snapshotted.
- Storage adapters: memory, Node files (append + fsync, temp + rename), OPFS (sync access handle in a worker, writable stream on the main thread).

## Testing

```
just test            # unit + fake-server end-to-end + 40-seed simulation
just dst 500 200     # long simulation run
just server          # local SpacetimeDB
just integration     # publish example module, generate bindings, run the Node demo
```

The simulation drives one or two clients through random calls, disconnects,
crashes (restart from the bytes on disk), foreign writes, torn and failed
storage operations, lost calls and lost acks, then checks: every durable intent
settles exactly once, no intent has effects twice on the server, failed intents
had no server effects, and every client's merged view equals the server's.

## Known limits

- Reconnect re-downloads the whole working set; SpacetimeDB has no "changes since" resume.
- OPFS adapter is written against the spec but has not been run in a browser here.
- One process per storage directory; concurrent tabs are not coordinated.
- Row-level security filters inside submodules are ignored by the host today, so the submodule keeps `applied_intents` private instead.

## Browser tests

`just browser-test` runs `packages/browser-tests` with Playwright browsers from
nixpkgs (Chromium, Firefox and WebKit, no downloads). It exercises the OPFS
adapter on the main thread and inside a Worker, persistence across reloads,
torn-log recovery on real files, and the full engine in a page against a
throwaway local SpacetimeDB spawned by the test: offline calls, reload, sync,
a conflicting client, and closing the tab mid-drain. Playwright's Linux WebKit
has no OPFS, so it runs the sync scenarios with the memory adapter and skips
reload persistence.

Two things a browser bundle needs (see `packages/browser-tests/harness/bundle.ts`):
alias `spacetime:sys@*` to the shim, and patch the `globalThis.window = ...`
line in `spacetimedb/dist/server/index.mjs`, which throws in browsers.
