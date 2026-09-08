# Persistent side-agent observability and operator runbook

Status: **Proposed**

## Principles

- Observe BFF orchestration, not model correctness.
- Durable state and transcript reconciliation are authoritative; SSE is a latency optimization.
- Emit one structured event per durable lifecycle transition.
- Never log question/answer text, transcript parts, raw directories, attachments, credentials, or
  arbitrary upstream error bodies.
- Metrics use bounded labels only.
- Model/provider completion latency is outside application SLOs.

Pino and `pino-pretty` already exist in dependencies; the design should consolidate current
unstructured server warnings rather than introduce another logging runtime.

## Correlation model

| Field | Lifetime | Metric label? |
|---|---|---:|
| `process_instance_id` | One BFF process | No |
| `http_request_id` | One incoming HTTP request | No |
| `side_agent_id` | One named specialist record | No |
| `question_id` | One durable question | No |
| `dispatch_attempt_id` | One OpenCode submission attempt | No |
| `child_session_id` | One OpenCode child | No |
| `directory_hash` | Stable local project correlation | No |
| `event_connection_id` | One upstream SSE connection | No |
| `store_generation` | One committed snapshot | No |
| `revision` | One record version | No |

Never label metrics by directory, request, specialist, child, model, provider, or user.

## Structured event example

```json
{
  "time": "2026-08-22T12:00:00.000Z",
  "level": "info",
  "service": "custom-dca-opencode-bff",
  "component": "persistent-side-agent",
  "event": "side_agent.question.transition",
  "schema_version": 1,
  "process_instance_id": "bffi_...",
  "http_request_id": "httpr_...",
  "side_agent_id": "sa_...",
  "question_id": "sq_...",
  "dispatch_attempt_id": "sqa_...",
  "child_session_id": "ses_...",
  "directory_hash": "sha256:...",
  "from_state": "submitting",
  "to_state": "running",
  "evidence": "child_user_marker_observed",
  "duration_ms": 42,
  "store_generation": 17,
  "revision": 4,
  "result": "success"
}
```

## Event catalogue

| Event | Level | Required bounded fields |
|---|---|---|
| `side_agent.store.loaded` | info | version, generation, specialist/nonterminal counts, duration |
| `side_agent.store.corrupt` | error | file basename, error code, recoverable=false |
| `side_agent.store.write_failed` | error | generation, error code, duration |
| `side_agent.specialist.created` | info | specialist/child IDs, directory hash |
| `side_agent.question.enqueued` | info | question ID, queue depth, revision |
| `side_agent.question.idempotent_replay` | info | question ID, input_match=true |
| `side_agent.question.idempotency_conflict` | warn | key digest prefix, input_match=false |
| `side_agent.dispatch.started` | info | question/attempt IDs, queue wait |
| `side_agent.dispatch.accepted` | info | evidence, upstream duration |
| `side_agent.dispatch.interrupted` | warn | failure boundary, safe error code |
| `side_agent.question.transition` | info | old/new state, evidence, revision |
| `side_agent.question.cancel_requested` | info | expected revision |
| `side_agent.cancel.race` | warn | winner=answer/failure/cancellation |
| `side_agent.delivery.accepted` | info | question ID, delivery revision |
| `side_agent.delivery.attached` | info | question/parent IDs, evidence |
| `side_agent.reconcile.completed` | info/debug | trigger, candidate/changed counts, duration |
| `side_agent.reconcile.failed` | warn | safe error code, retry delay |
| `side_agent.scheduler.starvation` | error | oldest age, runnable specialist count |
| `side_agent.invariant_violation` | error/fatal | bounded invariant, specialist paused |
| `opencode.event.connected` | info | connection ID, reconnect count |
| `opencode.event.disconnected` | warn | connection ID, connected duration, retry delay |
| `opencode.process_generation.changed` | warn | old/new generation, affected count |

## Stable error codes

```text
PSA_FEATURE_DISABLED
PSA_STORE_CORRUPT
PSA_STORE_VERSION_UNSUPPORTED
PSA_STORE_WRITE_FAILED
PSA_DIRECTORY_INVALID
PSA_OWNERSHIP_MISMATCH
PSA_SPECIALIST_CREATE_FAILED
PSA_CHILD_SESSION_MISSING
PSA_PROMPT_REJECTED
PSA_ACCEPTANCE_INTERRUPTED
PSA_PROVIDER_RETRYING
PSA_PROVIDER_FAILED
PSA_REVISION_CONFLICT
PSA_IDEMPOTENCY_CONFLICT
PSA_ILLEGAL_TRANSITION
PSA_DUPLICATE_MARKER
PSA_ABORT_FAILED
PSA_RECONCILE_FAILED
PSA_STARVATION
PSA_INVARIANT_VIOLATION
```

Errors expose safe summaries only. `OpencodeError` can carry upstream response prose, so its body
must not flow into logs, metrics, notifications, or browser errors.

## Redaction

Always remove question/answer text, transcript parts, attachment names/data URLs, raw directories,
repository paths, URL queries, auth tokens, headers/cookies, environment values, permission
patterns, commands, raw provider bodies, idempotency keys, and OpenCode request/response bodies.

Safe fields are bounded states/error codes, modes, counts/durations, HTTP status classes, booleans,
internal correlation IDs in logs, and store-file basename. Tests should seed credential-like values,
URLs, and absolute paths, then assert none appear in captured logs, metrics, health, errors, or
notifications.

## Metrics

### Counters

```text
dca_psa_questions_total{result="enqueued|idempotent_replay|rejected"}
dca_psa_dispatch_total{result="accepted|interrupted|rejected"}
dca_psa_transitions_total{from_state="...",to_state="...",evidence="..."}
dca_psa_reconcile_total{result="success|failure",trigger="startup|poll|sse|manual"}
dca_psa_cancellations_total{result="cancelled|answer_won|failure_won|failed"}
dca_psa_deliveries_total{result="accepted|attached|dismissed|conflict"}
dca_psa_store_writes_total{result="success|failure"}
dca_psa_invariant_violations_total{invariant="..."}
dca_psa_sse_disconnects_total
dca_psa_provider_retries_total
```

### Gauges and histograms

```text
dca_psa_queue_depth
dca_psa_nonterminal_questions{state="..."}
dca_psa_oldest_queued_age_seconds
dca_psa_active_specialists
dca_psa_dispatch_slots_used
dca_psa_store_generation
dca_psa_store_healthy
dca_psa_reconciler_lag_seconds
dca_psa_sse_connected

dca_psa_store_write_duration_seconds
dca_psa_queue_wait_duration_seconds
dca_psa_dispatch_duration_seconds
dca_psa_reconcile_duration_seconds
dca_psa_state_convergence_duration_seconds
dca_psa_http_request_duration_seconds{route="...",method="...",status_class="..."}
```

## Health extension

```json
{
  "persistentSideAgents": {
    "enabled": true,
    "ready": true,
    "storeHealthy": true,
    "storeVersion": 1,
    "storeGeneration": 17,
    "schedulerRunning": true,
    "reconcilerRunning": true,
    "queueDepth": 2,
    "nonterminal": 3,
    "interrupted": 0,
    "oldestQueuedAgeSeconds": 4,
    "lastReconciledAt": "2026-08-22T12:00:00.000Z",
    "lastErrorCode": null
  }
}
```

Component readiness is false for corrupt/unsupported state, incomplete startup reconciliation,
unexpected scheduler stop, uncommitted store write failure, or invariant pause. Provider/SSE
failure degrades the component but need not make the entire BFF unhealthy.

## Dashboards

1. **Overview:** queue depth, nonterminal by state, oldest age, acceptance/interruption rate,
   reconciliation lag, store failures, SSE, OpenCode health/version.
2. **Reliability:** accepted/answered transitions, duplicate markers, idempotency conflicts,
   cancellation races, provider retries/failures.
3. **Capacity/fairness:** slots used, runnable specialists, queue-wait percentiles, oldest age,
   starvation. Per-specialist diagnosis comes from sampled logs, not metric labels.
4. **Restart/recovery:** BFF starts, OpenCode generation changes, startup reconcile duration,
   evidence classes, questions left interrupted.

## Alerts

| Alert | Condition | Severity | First action |
|---|---|---|---|
| Store corrupt | unhealthy for 1 minute | P1 | Disable dispatch, preserve file |
| Store writes fail | 3 consecutive or 5 minutes | P1 | Pause scheduler; inspect disk/permissions |
| Duplicate marker | Any | P1 | Pause specialist; inspect transcript |
| Interruption spike | >2/15m or >1% dispatches | P2 | Check BFF/OpenCode transport/restarts |
| Reconciler stalled | lag >30s for 5m | P2 | Preserve diagnostics; restart if safe |
| Queue starvation | eligible age >120s with free slot | P2 | Inspect scheduler fairness |
| Queue backlog | depth >50 or oldest >10m | P3 | Check blockers/provider/concurrency |
| SSE disconnected | >5m | P3 | Confirm polling convergence |
| New interrupted work | Any | P2 | Determine OpenCode generation/change |

## SLOs

| SLO | Target | Definition |
|---|---:|---|
| Durable enqueue | 99.9% | Success returns only after committed state |
| At-most-once automatic dispatch | 100% | No question marker automatically submitted twice |
| State convergence | 99% within 15s | Durable state matches observable evidence |
| Startup recovery | 99% within 30s | Initial reconciliation completes |
| Queue dispatch availability | 99.5% within 30s | Eligible question begins submission, excluding pause/block/provider outage |
| Cancellation acknowledgement | 99% within 10s | Reaches terminal or explicit pending state |
| Store integrity | 100% | No acknowledged question lost |
| Redaction | 100% | No forbidden content in operational output |

Model completion time and quality are explicitly excluded.

## Operator runbook

### Feature will not start

1. Check health and `lastErrorCode`.
2. Confirm flag and state permissions.
3. Disable feature before copying/inspecting corrupt state.
4. Never replace the store with an empty file.
5. Validate schema, references, sequences, and nonterminal records.

### Queue will not dispatch

1. Check scheduler/reconciler readiness, pause state, slots, and oldest age.
2. Check child status and pending permission/question state.
3. Search structured logs by question ID.
4. Trigger manual reconciliation before restart.

### Question is interrupted

1. Do not retry automatically.
2. Search the child transcript for the exact question marker.
3. One marker can reconcile submission; duplicates pause the specialist.
4. If evidence remains absent, let the user create a new retry linked by `retryOf`.

### Cancellation is stuck

1. Check whether answer/failure won the race.
2. Retry abort only while cancelling and only after fresh ownership verification.
3. After OpenCode restart, preserve interrupted/manual-review state unless evidence proves outcome.

### SSE is down

Confirm polling and convergence lag before intervening. Inspect global-event reachability and retry
backoff. Never restart solely for a short SSE outage.

### Backlog/starvation

Compare free slots with runnable specialists, confirm round-robin selection, inspect blocked head
questions, and pause the offending specialist if necessary. Do not increase concurrency before
checking one-child serialization.

### Rollback

Disable feature, restart BFF, confirm no new dispatch events, preserve the store, and remember that
already accepted OpenCode work may continue. Abort only by explicit operator action. Prefer
roll-forward after schema migration.

## Incident evidence bundle

Collect health, BFF/OpenCode versions and process times, redacted logs for correlation IDs, store
version/generation/counts plus a separately secured state copy, SSE history, queue/reconcile metrics,
and matching failure-scenario ID. Do not place prompt or transcript content in normal incident tickets.
