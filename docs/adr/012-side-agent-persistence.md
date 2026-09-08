# ADR-012: Atomic JSON V1 with SQLite migration triggers

Status: **Proposed**
Date: 2026-08-22

## Context

Bridge state needs durable ordering and restart recovery, but expected V1 scale is local and small.
The repository has no SQLite dependency and already uses private JSON with serialized atomic
replacement for notification history.

Executable queue state requires stricter corruption behavior than notification history: malformed
state must not silently become an empty queue.

## Decision

V1 uses `.state/persistent-side-agents.json`, configurable by
`PERSISTENT_SIDE_AGENT_STORE_FILE`.

- One process-local serialized mutation queue and one supported BFF writer.
- State directory `0700`, file `0600`.
- Full schema, referential, sequence, and transition validation before publication.
- Same-directory unique temp file, flush, rename, and best-effort parent-directory flush.
- Monotonic document and record revisions.
- Missing state initializes empty; malformed/unsupported state is preserved and disables dispatch.
- Prompts/answer snapshots are bounded and retention runs inside serialized mutations.

## SQLite migration triggers

Migrate when any one is true:

1. Multiple BFF processes must share the store.
2. Retained records exceed 5,000 or the file exceeds 10 MiB.
3. Indexed search/cursor pagination makes full-document scans unsuitable.
4. Contended multi-record transactions become common.
5. State-write p95 exceeds 100 ms for seven days.
6. Cross-process leasing or transactional outbox behavior is required.
7. Full rewrites create measurable event-loop or storage pressure.
8. Per-project encryption, selective backup, or row-level retention is required.

Migration stops dispatch, validates/checksums JSON, imports in one SQLite transaction, verifies all
counts/links/sequences/digests, then preserves JSON as a read-only backup. There is no dual-write
period. Rollback is allowed only before new SQLite mutations.

## Alternatives

| Alternative | Reason rejected |
|---|---|
| SQLite immediately | Adds runtime/migration surface before measured need |
| One JSON file per specialist | Cross-specialist limits and atomic cleanup become harder |
| Append-only JSONL | Compaction and current-state recovery are more complex |
| Browser storage | Execution is server-owned and must survive device changes |

## Consequences

- V1 matches existing local single-process patterns.
- Every mutation rewrites a bounded document.
- Multiple writers are unsupported and must fail closed.
- Atomic replacement does not create a transaction with OpenCode.

## Acceptance criteria

- Fault injection proves failed writes preserve the previous snapshot.
- Malformed or unsupported state disables dispatch without deleting source data.
- Concurrent mutations preserve sequence/revision invariants.
- File/directory permissions and second-writer behavior are tested.
