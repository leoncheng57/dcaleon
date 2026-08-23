# Persistent side-agent threat model

Status: **Proposed**
Related: [ADR-010](adr/010-persistent-side-agent-bridge.md),
[ADR-011](adr/011-side-agent-delivery-semantics.md), and
[ADR-012](adr/012-side-agent-persistence.md)

## Scope

This model covers parent-scoped named specialists backed by persistent OpenCode child sessions, a
BFF-owned FIFO question bridge, a durable answer inbox, and explicit attachment to the parent's
next human prompt. It does not claim that OpenCode supplies a durable job queue or process-independent
liveness. Ambiguous work is never replayed automatically.

## Existing baseline

- The browser calls the BFF rather than OpenCode, keeping credentials server-side.
- Every OpenCode session operation is directory-scoped, and browser directories are canonicalized
  beneath configured roots with symlink-escape protection.
- Existing child mutation routes verify both directory and direct `parentID` ownership.
- Browser prompts use `prompt_async`; policy activation and submission are serialized per session.
- Child permission inheritance remains unverified.
- Classic SSE has no replay cursor and is never authoritative state.
- Notification persistence demonstrates private, serialized, atomic JSON replacement.
- OpenCode tools execute directly on the host as the service user, without a container boundary.

## Assets

| Asset | Required property |
|---|---|
| Host filesystem and Git repositories | Tools remain inside the intended project/worktree and policy |
| OpenCode and forge credentials | Never enter browser responses, prompts, inbox content, logs, or notifications |
| Project and parent boundaries | One parent's specialist cannot be read, prompted, attached, or aborted through another |
| Permission policy | Every specialist turn executes under an explicitly resolved allowed agent policy |
| FIFO integrity | Questions are not silently skipped, reordered, duplicated, or replayed |
| Prompt/result integrity | Model prose is never interpreted as trusted lifecycle metadata |
| User intent | Answers never enter or wake the parent without explicit user action |
| Persistent state | Restart recovery does not accept malformed or partial state as valid |
| Auditability | Operators can explain submission, answer, attachment, interruption, and uncertainty |

## Trust boundaries

```text
Browser/device
  |  untrusted IDs, prompts, revisions, retries, attach actions
  v
Express BFF
  |-- ownership and revision checks
  |-- per-specialist FIFO scheduler
  |-- private atomic bridge store
  |
  |  authenticated, directory-scoped HTTP
  v
OpenCode server
  |-- persistent transcripts
  |-- model/provider
  |-- host-executed tools
  v
Project/worktree filesystem and external services
```

Important secondary boundaries are BFF-to-state-file crash windows, non-transactional BFF-to-
OpenCode submission, lossy global SSE, model output crossing into parent context, and multiple
devices racing on one delivery revision.

## Actors

| Actor | Capability |
|---|---|
| Authorized human | Creates specialists/questions, reads answers, attaches, dismisses, and resolves uncertainty |
| Stale second device | Repeats actions against old revisions and races another device |
| Reachable local/tailnet caller | Calls BFF APIs without using the SPA if network ACLs permit it |
| Malicious website | Attempts cross-origin or navigation-based requests against a reachable BFF |
| Prompt-injected model | Produces deceptive prose, fake markers/IDs, or requests for secrets and wider permissions |
| Malicious repository content | Supplies instructions through files, issues, tests, and tool output |
| Faulty OpenCode server | Returns malformed metadata, duplicate events, or misleading process status |
| Local same-account process | Reads or modifies `.state` unless OS permissions and process isolation prevent it |
| Accidental operator | Restarts services, runs two BFFs, edits state, moves projects, or changes versions |

## Security invariants

1. An opaque ID is a locator, never proof of authorization.
2. Every read/mutation verifies canonical directory, parent ID, side-agent ID, and child session ID.
3. Stored paths are revalidated before prompt, abort, and parent delivery.
4. Specialist type maps to a bounded server-owned agent; the browser never chooses an arbitrary
   OpenCode identity or permission policy.
5. At most one bridge-owned question is active in one child session.
6. Queue order uses immutable sequence numbers, not timestamps or client order.
7. Prose, titles, XML-like tags, and apparent markers never authorize or settle a transition.
8. Completion requires the correlated assistant turn; status absence and SSE never prove completion.
9. Crash-ambiguous submission becomes `interrupted`; it is never replayed automatically.
10. Accepting an answer does not send a parent prompt. The next human send remains explicit.
11. Mutations use revisions and idempotency keys; stale devices receive a conflict.
12. Malformed persistent state disables dispatch rather than starting with an empty queue.
13. Prompts, answers, errors, queue depth, and retention are bounded.

## Threat analysis

### Spoofing and ownership

| Threat | Mitigation | Residual risk |
|---|---|---|
| Forged specialist/question/parent/child ID | Generate IDs server-side; return uniform 404 for ownership failure; reload and verify all linked fields | Timing may still reveal coarse existence |
| Valid question attached through another parent | Parent is immutable on creation; attach route never accepts replacement parent | Same-account state-file edits bypass application checks |
| Cross-project child session ID | Require canonical directory equality in bridge record and fresh OpenCode metadata | Upstream wrong-directory behavior needs live probing |
| Arbitrary privileged agent | Map specialist types server-side; start read-oriented; require explicit review before Build specialists | Build policy still permits configured host mutation |
| Fake completion marker in prose | Correlate by application question record and upstream message IDs; marker text alone has no authority | Message immutability needs live verification |

### Tampering and replay

| Threat | Mitigation | Residual risk |
|---|---|---|
| Queue reorder or duplicate dispatch | Assign sequence inside serialized store mutation; dispatch lowest eligible sequence; one active turn | Store and OpenCode cannot share one transaction |
| Crash after possible OpenCode acceptance | Persist intent first; reconcile deterministic marker; otherwise mark interrupted and block automatic retry | Manual retry can still duplicate accepted work; UI must warn |
| Multi-device accept/dismiss race | Require `expectedRevision`; same idempotency key returns prior outcome; conflicting action returns 409 | Distinct valid actions still race; exactly one transition wins |
| State-file corruption/replacement | `0700` directory, `0600` file, same-directory temp/rename, schema and invariant validation, fail closed | Same-account processes can still tamper |
| Answer changed between inbox and delivery | Persist bounded snapshot/digest and child message ID; revalidate before attachment | Transcript mutability is unverified |

### Repudiation

Record operation, timestamp, revision, idempotency digest, question/child/parent correlation, and
evidence class. Do not claim cryptographic human identity where the BFF has no authenticated user
principal. Model claims never substitute for transcript metadata.

### Information disclosure

| Threat | Mitigation | Residual risk |
|---|---|---|
| Cross-parent inbox leakage | Apply ownership checks to list, detail, accept, dismiss, cancel, and event views | Every new endpoint must repeat the check |
| Traversal or symlink escape | Use `requireWorkspaceDirectory`; never join browser input to state-file path | Agent tools can still read allowed project secrets |
| Secrets retained in answers | Private storage, size/retention limits, explicit deletion, no answer prose in notifications/logs | Reliable arbitrary-secret redaction is impossible |
| Credential leakage | Keep upstream calls in BFF; redact auth, URLs, paths, bodies, and environment from telemetry | A compromised BFF has all server credentials |
| State file served accidentally | Keep `.state` outside client build/static roots | External server misconfiguration remains possible |

### Denial of service

| Threat | Mitigation | Residual risk |
|---|---|---|
| Unbounded questions/prompts | Enforce prompt size, queue depth, parent specialist count, global records and pagination | Legitimate bulk work may need batching |
| Large answer history | Bound answer snapshots; expire bodies after retention while preserving minimal audit metadata | OpenCode transcript retention is independent |
| Event flood/missed events | Treat SSE as deduplicated nudge; poll only nonterminal work; bound caches | Polling can load OpenCode during outages |
| Stuck question blocks FIFO forever | Show inspect, cancel, dismiss, and explicit retry; never skip silently | Human intervention is intentional |
| Two BFF writers | V1 refuses unsupported multi-writer operation; SQLite is the migration trigger | Correct process detection/locking is still required |
| Malformed store silently loses queue | Preserve corrupt file, disable dispatch, expose health error | Manual repair may be required |

### Elevation of privilege and prompt injection

| Threat | Mitigation | Residual risk |
|---|---|---|
| Child inherits stale/broad permissions | Prefer explicitly created specialist child; verify live; apply server-owned policy before every turn; fail closed | OpenCode permission inheritance remains an evidence gap |
| Browser selects internal agent | Reject arbitrary names and unknown identities | Future specialist types need separate allowlist review |
| Repository content persuades scope escape | Existing permission rules remain primary host guardrail; include canonical scope in trusted instructions | No container means policy bypass affects the host |
| Answer injects parent instructions | Label as untrusted model output, render separately, require explicit attach and explicit human send | LLM instruction hierarchy is not hard isolation |
| Unauthenticated BFF reachability | Require private-network ACL or authenticated reverse proxy; verify Origin/Host/CSRF posture before broader exposure | Current repository has no visible application principal |

## Dispatch and delivery rules

1. Persist queued question and immutable sequence.
2. Persist submitting intent before `prompt_async`.
3. Reconcile marked child user turn and correlated assistant turn.
4. Never use `session.idle`, status disappearance, or hand-back prose as terminal evidence.
5. On restart, continue only questions proven never submitted; reconcile all others without replay.
6. Completed answers enter the parent-owned inbox.
7. Attach creates a removable, provenance-labelled composer context item; it never calls
   `prompt_async` by itself.
8. Dismissal does not delete the OpenCode transcript.

## Retention and limits

Recommended V1 defaults:

- 32 KiB question text and 128 KiB answer snapshot;
- 100 queued questions per specialist and 20 specialists per parent;
- retain nonterminal and unresolved records until explicit resolution;
- retain ready answer bodies for 30 days;
- retain attached/dismissed metadata and digest for 90 days, dropping bodies after 30;
- cap operational errors at 2 KiB;
- never place result prose, tool output, paths, IDs, or credentials in lock-screen notifications.

## Security test matrix

### Ownership

- Reject absent, relative, outside-root, symlink-escaped, moved, and deleted directories.
- Reject a valid question through the wrong directory, parent, specialist, or child session.
- Reject arbitrary/internal agents and mismatched agent identities.
- Exercise ownership on every list and mutation route, not only prompt/abort.

### FIFO and replay

- Prove unique ordered sequence under concurrent creation and one active turn per child.
- Drop/duplicate SSE and verify no duplicate or missing transition.
- Crash before store flush, after submitting flush, after OpenCode acceptance, and after answer
  observation; prove no unsafe automatic replay.
- Verify manual retry creates a new question/attempt and exposes duplicate-execution risk.

### Injection

- Put fake IDs, completion words, reminder tags, and side-agent tags in question/answer prose.
- Attach output containing "ignore previous instructions" and verify untrusted labelling/no auto-send.
- Verify control characters, bidi controls, HTML, Markdown links, and oversized text render safely.
- Verify notifications and telemetry contain no answer prose, paths, URLs, IDs, or credentials.

### Persistence and races

- Inject write, sync, and rename failures; the previous complete snapshot remains valid.
- Load malformed JSON, unknown version, duplicate IDs/sequences, broken references, and impossible
  states; dispatch stays disabled.
- Race accept against dismiss/cancel/delete from two devices; one revision wins and one gets 409.
- Start a second BFF against the same JSON store; it must refuse or acquire an exclusive lock.

## Evidence gaps

Live verification is required for message-ID stability, event ordering, transcript mutability,
wrong-directory behavior, explicit `parentID` creation, repeated specialist prompts, permission
patch behavior, child permissions across mode changes, compaction effects, and OpenCode restart
shapes. Deployment ACL, authentication, Origin, and CSRF posture also require operational review.

Until resolved, uncertainty degrades to interrupted work, disabled dispatch, or explicit human
review rather than automatic replay.
