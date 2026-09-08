# ADR-010: Application-owned FIFO side-agent bridge

Status: **Proposed**
Date: 2026-08-22

## Context

OpenCode child sessions are durable conversations, but the application currently derives child
state from incomplete sources and has no durable job/result registry. Background launch completion
does not prove child completion, process status disappears on restart, and classic SSE has no
replay cursor.

Persistent named specialists need ordering, per-question correlation, parent ownership, restart
reconciliation, and honest handling of ambiguous submission.

## Decision

The application owns a persistent FIFO bridge keyed by parent and named specialist.

- Each specialist maps to one explicitly parent-linked OpenCode child session.
- Each question receives an application ID and immutable monotonic sequence.
- At most one question per specialist is submitting or running.
- Different specialists may run concurrently under a bounded global limit.
- OpenCode remains authoritative for session transcript and terminal assistant-turn evidence.
- SSE is a nudge; polling and durable transcript reads reconcile state.
- A crash-ambiguous submission becomes interrupted and is never automatically replayed.
- Browser-supplied arbitrary agent identities are rejected.

## Alternatives

| Alternative | Reason rejected |
|---|---|
| Extend the derived task-child ledger | It collapses resumed task parts and has no per-question delivery record |
| Depend on background hand-back prose | It is heuristic and not guaranteed once per turn |
| Use transcript order as the queue | It cannot atomically represent application ownership, attempts, or delivery state |
| Concurrent prompts in one child | Result correlation and conversational ordering become ambiguous |
| Automatically replay interrupted work | It can duplicate destructive effects |

## Consequences

- The BFF owns queue persistence, reconciliation, limits, and recovery UX.
- FIFO can remain blocked until a user resolves an interrupted question.
- Specialist context persists naturally in one OpenCode child transcript.
- The bridge provides at-most-once automatic submission, not exactly-once execution.
- V1 supports one BFF writer to the JSON store.

## Acceptance criteria

- Ownership is verified by canonical directory, parent, specialist, and child session.
- Concurrent enqueue preserves sequence and one-active-turn invariants.
- Duplicate/stale events cannot settle a question.
- Crash-window tests prove no automatic replay.
- Live probes validate explicit child creation, repeated prompts, and permissions before release.
