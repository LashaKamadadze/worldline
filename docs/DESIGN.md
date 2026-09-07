# stdb-localfirst design

Server-authoritative local-first for SpacetimeDB. The client runs the module's
own TypeScript reducers against a local copy of the working set, shows the
result immediately, persists the intent, and ships it when online. The server
is the only source of truth; the client rebases its unconfirmed intents on top
of every server delta and drops the ones the server rejects.

## Non-goals

- No CRDTs, no merge functions, no conflict UI. A rejected intent is a failed
  call, exactly as it would be online.
- No SQLite, no third-party storage engine. The on-disk format is two small
  hand-written files whose every byte is covered by a CRC.
- No fork of the SDK. The SDK's `DbConnection` is wrapped, not patched.

## State model

```
view      = overlay(pending intents, in order)  over  base
base      = server-confirmed rows for the subscribed working set
pending   = intents persisted locally and not yet acked/failed/cancelled
```

Rebase replays every pending intent against the new base whenever the base
changes (a server delta) or the pending set changes (an ack, a failure, a new
call). An intent whose reducer now throws is marked failed; intents that read
what it wrote are cancelled before they are sent.

## Invariants (checked by the simulation on every seed)

1. Every intent reported durable settles exactly once: acked, failed or cancelled.
2. An intent acked on the client has been applied on the server.
3. An intent failed or cancelled on the client has no effects on the server.
4. No intent has effects more than once on the server.
5. After quiescence each client's merged view equals the server's tables.
6. After a crash, every durable unsettled intent is still pending.

Invariant 4 is the server's job: `offlineReducer` records every applied intent
id in `applied_intents` and returns early on a repeat, so at-least-once
delivery collapses to exactly-once. Invariant 6 is the log's job.

## Durability

Intent log, two slots (`intents.log.a`, `intents.log.b`):

- Frame: `[u32 length][u32 crc32][payload]`. A short or mismatching frame ends
  the readable prefix; nothing after it is trusted.
- Each slot starts with a header frame carrying a generation number and ends,
  when compacted, with a commit frame. The slot with the highest generation
  and a valid header wins on open.
- Append goes to the active slot and is fsynced before `call()` reports the
  intent durable. A failed or torn append marks the slot dirty; the next write
  compacts into the other slot instead of appending after garbage.
- Compaction writes the surviving intents into the other slot, fsyncs, then
  the new generation makes that slot the active one. A crash at any point
  leaves one of the two slots complete.

Snapshot, two slots (`snapshot.a`, `snapshot.b`): base rows only, never
predicted rows, so a stale snapshot can only cost a re-download, never a
phantom row. Highest valid generation wins; the working-set hash is stored so
a changed subscription discards the snapshot.

Storage adapters: memory (tests), Node files (append with fsync, write via
unique temp file + fsync + rename + directory fsync, O_EXCL pid lock file with
stale-pid reclaim), OPFS (sync access handle in a worker, Web Locks for the
single-writer rule).

## Limits

Every bound lives in `packages/localfirst/src/shared/limits.ts` and is
asserted at the point of use. Relationships between limits are asserted once
at module load.

| Limit | Value | Why |
| --- | --- | --- |
| pending intents | 10 000 | bounds log size, rebase time and memory |
| in-flight window | 64 | bounds duplicate work after a lost ack |
| intent args | 1 MiB | bounds one frame; larger is corrupt by definition |
| log slot compaction | 64 MiB | bounds open time |
| read/write set per intent | 4 096 | beyond this a read collapses to a table scan |
| tables | 1 024 | bounds per-table maps |
| snapshot rows per table | 1 000 000 | larger working sets must be split |
| snapshot bytes | 512 MiB | bounds one write |
| listeners per kind | 1 024 | leak detector |
| timestamps | 2000..2200 | catches ms/µs confusion at the boundary |

## Back of the envelope

Measured on one laptop core with the unit perf test and the live 10 000-row
scenario:

| Operation | Cost |
| --- | --- |
| primary-key lookup through the overlay | ~1 µs |
| rebase 1 000 pending over 20 000 rows | ~30 ms |
| rebase 200 pending over 10 000 rows (live) | ~6 ms, ~2 ms per ack |
| drain 200 intents, in-flight window 1 / 16 (localhost) | ~3.2 s / ~0.4 s, round trips dominate |
| 5 000 appends with fsync (Node files) | ~0.9 s |
| initial load of 10 000 rows | ~70 ms |
| snapshot 10 000 rows / boot from it | ~30 ms / ~15 ms |

Rebase is O(pending × writes per intent) plus O(pending × table) for tables
with non-primary-key unique constraints, which scan. Keep unique constraints on
the primary key for tables that pending intents touch.

## Threat model

Trusted: the module code, the SpacetimeDB host, the local disk's contents
between fsync and crash (a torn write is expected, a lying fsync is not).

Untrusted: the network (calls and acks may be lost, delayed, reordered per
session but not within one), the process lifetime (kill at any instruction),
storage operations (any append, write or read may fail or tear), the clock
(skew is tolerated; `clientTimestamp` is data, not ordering).

Not defended: a second writer bypassing the lock, malicious edits to the log
(CRC catches corruption, not forgery), an attacker with the auth token.

## Testing strategy

- Unit tests per component (framing, log, store, executor, dependencies,
  snapshot, limits, node storage).
- Deterministic simulation: virtual scheduler, faulty storage, fake network
  with per-session FIFO and loss, fake server running the real wrapped
  reducers, random crashes and double-opens. Same seed, same trace.
- Live tests against real SpacetimeDB 2.10.0 servers, one per file on a random
  port: conflicts, socket kills, server SIGKILL and restart, 10 000-row working
  sets, a 300-op differential run of the local `ctx.db` against the host,
  identity and purge behaviour.
- Browser tests through Playwright for the OPFS adapter and Web Locks.
