# Persistent side-agent state tables

Status: **Proposed**

These tables are normative refinements of the [persistent side-agent RFC](persistent-side-agents-rfc.md).
OpenCode owns sessions/transcripts; the BFF owns specialist identity, FIFO questions, correlation,
answer snapshots, and explicit parent delivery.

## State ownership

| Record | Durable owner | Authoritative external evidence | Serialization owner |
|---|---|---|---|
| Specialist | Versioned bridge store | Child with matching directory and `parentID` | Bridge-store mutation lock |
| Question | Versioned bridge store | Marked child user turn and correlated assistant turn | Per-specialist scheduler |
| Delivery | Versioned bridge store | Deterministic context marker in parent user message | Parent prompt critical section |
| Specialist health | Derived | Child ownership, status, upstream availability | Never persisted as lifecycle |

V1 supports one BFF writer. Multiple writers require a transactional store and lease protocol.

## Specialist lifecycle

| State | Meaning | Scheduler behavior | Restart behavior |
|---|---|---|---|
| `active` | Accepts questions; linked child was validated on creation | Oldest question may run when no active question and child not positively busy | Revalidate parent, child, directory; never recreate silently |
| `archived` | Accepts no new questions and retains history | Never schedules | Remains archived; child transcript retained |

Derived health:

| Health | Evidence | Consequence |
|---|---|---|
| `ready` | Ownership valid, upstream reachable, no active question, child not busy | FIFO head may be claimed |
| `busy` | Bridge question active or OpenCode positively reports busy | Do not submit another turn |
| `unavailable` | Required upstream read unavailable | Pause scheduling; preserve state |
| `orphaned` | Parent/child absent, directory differs, or parent link differs | Reject prompt/abort; never rebind automatically |

### Specialist transitions

| From | To | Trigger | Guards |
|---|---|---|---|
| None | `active` | Create | Canonical directory; parent valid; name unique; type allowed; child relationship verified |
| `active` | `active` | Rename | Current revision; normalized name remains unique |
| `active` | `archived` | Archive/delete | Current revision; no submitting/running/cancelling question |
| `archived` | `active` | Explicit reactivate | Current revision; child relationship remains valid |
| `archived` | `archived` | Idempotent replay | Same key and canonical request |

Upstream disappearance changes health, not lifecycle, and never creates a replacement child.

## Question states

| State | Meaning | Durable evidence | Restart behavior |
|---|---|---|---|
| `queued` | Persisted and never crossed submission boundary | ID, prompt, specialist, FIFO sequence | Resume scheduling; this is not replay |
| `submitting` | Prompt may have reached OpenCode | Claim and deterministic marker persisted first | Search transcript; never call `prompt_async` automatically |
| `running` | Marked child user turn exists; assistant incomplete | Exact child user message ID | Reconcile transcript/status; interruption if outcome cannot be proved |
| `answered` | Correlated assistant completed | Child user/assistant IDs plus bounded snapshot/digest | Terminal; delivery inbox committed atomically |
| `failed` | Correlated terminal error | Explicit error from correlated turn/rejection | Terminal; no automatic retry |
| `cancelling` | Cancellation intent persisted after submission may have started | Durable intent before abort | Reconcile answer/error/cancellation; never replay |
| `cancelled` | Local pre-submit cancel or explicit terminal cancellation | Local queued transition or correlated cancellation evidence | Terminal |
| `interrupted` | Outcome cannot be proven safely | Submission crossed or active turn observed without terminal proof | Terminal in V1; explicit retry creates a new question |

### Legal question transitions

| From | To | Trigger | Guard/evidence |
|---|---|---|---|
| None | `queued` | Create | Specialist active; idempotently persisted |
| `queued` | `submitting` | Scheduler claims FIFO head | No active question; ownership valid; child not positively busy; persist before network |
| `queued` | `cancelled` | User cancels | Current revision; no submission claim |
| `submitting` | `running` | Marker observed | Exact deterministic marker in child user message |
| `submitting` | `answered` | Fast completion | Marker and corresponding completed assistant in one read |
| `submitting` | `failed` | Explicit rejection/error | Terminal evidence tied to attempt |
| `submitting` | `cancelling` | User cancels | Persist intent before abort |
| `submitting` | `interrupted` | Acceptance ambiguous | No terminal proof and safe outcome unavailable |
| `running` | `answered` | Assistant completes | Completed turn corresponds to marked user turn |
| `running` | `failed` | Assistant fails | Explicit correlated terminal error |
| `running` | `cancelling` | User cancels | Current revision; persist intent before abort |
| `running` | `interrupted` | Ownership/process disappears | Incomplete turn, not positively busy, no terminal proof |
| `cancelling` | `answered` | Completion wins race | Completed correlated assistant turn |
| `cancelling` | `failed` | Error wins race | Explicit correlated terminal error |
| `cancelling` | `cancelled` | Cancellation completes | Explicit correlated cancellation evidence |
| `cancelling` | `interrupted` | Outcome ambiguous | Cannot distinguish cancel/completion/interruption |

Entering `answered` and creating delivery `inbox` is one atomic store transaction.

### Illegal question transitions

| Attempt | Error | Reason |
|---|---|---|
| Submit a non-head question | `SPECIALIST_CONCURRENCY_CONFLICT` | FIFO violation |
| Submit with active bridge question | `SPECIALIST_CONCURRENCY_CONFLICT` | One turn per child |
| Submit while child busy with unowned work | `SPECIALIST_CONCURRENCY_CONFLICT` | Never overlap/adopt external activity |
| Create under archived specialist | `SPECIALIST_ARCHIVED` | Archived specialists accept no work |
| Cancel a terminal question | `QUESTION_NOT_CANCELLABLE` | Terminal state |
| Cancel with stale revision | `REVISION_CONFLICT` | Stale device |
| Treat status absence/idle as answered | Invariant violation | Not terminal evidence |
| Assign newest answer without marker | Invariant violation | Correlation must be question-specific |
| Move interrupted back to queued | `INVALID_STATE_TRANSITION` | Unsafe replay |
| Mutate through another scope | `QUESTION_NOT_FOUND` | Hide ownership mismatch |
| Continue after ownership loss | `CHILD_OWNERSHIP_LOST` | Authorization no longer holds |

## Delivery states

| State | Meaning | Parent behavior | Restart behavior |
|---|---|---|---|
| `inbox` | Answer waits for disposition | No context change or parent turn | Preserve |
| `accepted` | User attached answer to next message | Show removable context; do not prompt | Preserve |
| `delivering` | Human parent prompt reserved answer and may have reached OpenCode | Parent prompt critical section owns it | Search parent transcript; never resend automatically |
| `delivered` | Parent user message contains deterministic context marker | No longer attachable | Terminal |
| `dismissed` | User chose not to deliver | Remove attachment; retain history | Terminal |

`DELIVERY_OUTCOME_AMBIGUOUS` is evidence on `accepted`, not a sixth state. It means a prior
delivery could not be proven after restart; it never causes automatic resubmission.

### Legal delivery transitions

| From | To | Trigger | Guard/evidence |
|---|---|---|---|
| None | `inbox` | Question answered | Atomic with answer snapshot |
| `inbox` | `accepted` | User accepts | Answer exists; current revision |
| `inbox` | `dismissed` | User dismisses | Answer exists; current revision |
| `accepted` | `dismissed` | User removes/dismisses | No parent prompt owns delivery |
| `accepted` | `delivering` | User sends parent prompt | Reservation committed before submission |
| `delivering` | `delivered` | Marker observed | Exact question/child-turn marker in parent message |
| `delivering` | `accepted` | Proven pre-send failure | No parent marker; safe to release reservation |
| `delivering` | `accepted` | Ambiguous recovery | Set ambiguity code; do not send |

### Illegal delivery transitions

| Attempt | Error | Reason |
|---|---|---|
| Accept before answered | `ANSWER_NOT_AVAILABLE` | No answer exists |
| Accept dismissed/delivered | `ANSWER_ALREADY_RESOLVED` | Terminal delivery |
| Accept/dismiss while delivering | `CANCELLATION_CONFLICT` | Parent prompt may own answer |
| Deliver directly from inbox | Invariant violation | Explicit accept required |
| Enter delivering without human prompt | Invariant violation | Answers never wake parent |
| Auto-submit after ambiguous recovery | Invariant violation | Detection-only recovery |
| Mark delivered from prior HTTP 204 alone | Invariant violation | Recovery requires transcript marker |

## Evidence precedence

| Priority | Evidence | Conclusion |
|---:|---|---|
| 1 | Exact parent context marker in parent user message | Delivery delivered |
| 2 | Question marker followed by completed assistant | Question answered |
| 3 | Question marker followed by terminal assistant error | Question failed |
| 4 | Explicit correlated cancellation evidence | Question cancelled |
| 5 | Marker/incomplete assistant plus positive busy | Running/cancelling remains active |
| 6 | Durable pre-submission record without claim | Queued |
| 7 | Missing status, idle, disconnect, timeout, restart | No terminal conclusion; preserve/interrupt |

Stronger evidence wins races. Cancellation intent cannot override an answer completed first.

## Scheduler ownership

| Scope | Owner | Lock duration | Permitted work |
|---|---|---|---|
| Bridge store | Process-local mutation queue | Read-modify-atomic-write only | IDs, revisions, transitions, idempotency |
| Specialist FIFO | `(directory,parent,sideAgent)` lock | Claim through terminal evidence | One active question |
| OpenCode child | Validated specialist record | Revalidated before prompt/abort | Recorded child only |
| Parent delivery | Parent prompt critical section | Reservation through submission outcome persistence | Accepted answers on explicit human prompt |
| Cross-specialist work | Independent locks | Concurrent under global cap | Different children only |
| External child activity | Not bridge-owned | Until external activity clears | Wait; never overlap/adopt |

Never hold the store lock across an OpenCode call. Persist claim, release, call, then reconcile in
a new mutation.

## Restart matrix

| Persisted state | Required action | Forbidden action |
|---|---|---|
| Active specialist | Revalidate directory/parent/child | Recreate/rebind missing child |
| Queued | Resume FIFO when ready | Skip order |
| Submitting | Search exact marker and terminal turn | Call `prompt_async` again |
| Running | Reconcile turn/status | Infer completion from idle/absence |
| Cancelling | Reconcile answer/error/cancellation | Assume abort means cancelled |
| Terminal question | Preserve | Reopen/retry |
| Inbox | Preserve | Attach automatically |
| Accepted | Preserve context | Start parent prompt |
| Delivering | Search parent marker | Replay parent prompt |
| Terminal delivery | Preserve | Reopen/redeliver |

Startup reconciliation completes before scheduling new questions for a specialist.

## Invariants

1. Every specialist belongs to exactly one canonical directory and parent.
2. Every prompt/abort revalidates child directory and `parentID`.
3. Normalized specialist names are unique within one parent.
4. At most one question per specialist is submitting, running, or cancelling.
5. FIFO sequence is immutable; only the head submits.
6. Question marker is durable before any possible submission.
7. Assistant turns are assigned only to the exact marked user turn.
8. Answered and inbox are atomic.
9. Missing status, idle, background launch completion, and generic hand-back are not terminal.
10. Interrupted execution is never automatically replayed; retry creates a new ID/marker.
11. Accept changes bridge/composer state only; it never prompts the parent.
12. Delivering begins only with an explicit human parent prompt.
13. Parent marker is durable before parent submission and is recovery proof.
14. Ambiguous parent delivery is never automatically replayed.
15. Revisions increase once per committed mutation; stale `If-Match` does not mutate.
16. Idempotency replays only identical canonical input.
17. Pagination cursors bind endpoint, scope, filters, and ordering.
18. Archiving never deletes child transcript/history.
19. SSE accelerates reconciliation but is never sole evidence.
20. Different specialists may run concurrently; one specialist never does.
