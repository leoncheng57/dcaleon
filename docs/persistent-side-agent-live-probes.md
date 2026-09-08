# Persistent side-agent live probes

Status: **Proposed live-contract probe for OpenCode 1.18.21**
Last verified: **Not yet run**

This probe separates repository-supported API facts from the live hypotheses that the persistent
side-agent design needs. Passing it demonstrates reusable child sessions on one tested OpenCode
version; it does not establish a durable job scheduler, autonomous restart, or guaranteed
child-to-parent hand-back.

## Safety boundary

| Behavior | Default |
|---|---|
| `--help` | No network or writes |
| `--dry-run` | Prints the plan without network, path canonicalization, or report writes |
| Live execution | Requires `--run` and `PERSISTENT_SIDE_AGENT_PROBE_ACK=CREATE_AND_DELETE_PROBE_SESSIONS` |
| Probe-session tools | Denied by appending a deny rule for every discovered tool |
| Existing sessions | Never patched, prompted, aborted, or deleted |
| Cleanup | Considers only session IDs returned by the current invocation |
| Server restart | Manual only; the script never controls the supervisor |
| Parent deletion | Disabled unless separately acknowledged |
| Provider traffic | Live prompts can incur provider cost |

A live run can still create model requests, events, notification records, and transient session
history. Use a disposable project and review the generated private report before sharing it.

## CLI

```bash
npx tsx scripts/probe-persistent-side-agents.ts --help

npx tsx scripts/probe-persistent-side-agents.ts \
  --dry-run \
  --directory /absolute/project/path \
  --model provider/model

PERSISTENT_SIDE_AGENT_PROBE_ACK=CREATE_AND_DELETE_PROBE_SESSIONS \
npx tsx scripts/probe-persistent-side-agents.ts \
  --run \
  --directory /absolute/project/path \
  --model provider/model \
  --output .state/persistent-side-agent-probe.json
```

Optional flags are `--timeout-ms`, `--poll-ms`, `--keep-sessions`, and
`--include-parent-delete`. The deletion experiment additionally requires
`PERSISTENT_SIDE_AGENT_DESTRUCTIVE_ACK=DELETE_PROBE_PARENT`.

| Exit | Meaning |
|---:|---|
| 0 | Help/dry-run succeeded, or all required live probes passed |
| 1 | A live probe failed, timed out, or cleanup was incomplete |
| 2 | Arguments or acknowledgements were invalid |

## Probe matrix

| Probe | Automated | Mutating | Required |
|---|---:|---:|---:|
| Health and pinned version | Yes | No | Yes |
| Tool discovery | Yes | No | Yes |
| Parent/child creation with `parentID` | Yes | Yes | Yes |
| Parent children and directory-list discovery | Yes | No | Yes |
| Tool-denial suffix | Yes | Yes | Yes |
| First direct child prompt | Yes | Yes | Yes |
| Second turn and context continuity | Yes | Yes | Yes |
| Idle child persistence | Yes | No | Yes |
| Parent transcript isolation | Yes | No | Observational |
| Parent deletion behavior | Explicit opt-in | Yes | No |
| OpenCode restart persistence | Manual | External | No |
| Crash during a turn | Manual | External | No |

## Automated sequence

```mermaid
sequenceDiagram
    participant Probe
    participant OpenCode
    participant Parent
    participant Child

    Probe->>OpenCode: GET /global/health
    Probe->>OpenCode: GET tool IDs and baseline sessions
    Probe->>OpenCode: POST /session (parent)
    Probe->>OpenCode: POST /session parentID=parent (child)
    Probe->>Parent: GET children and transcript baseline
    Probe->>Child: PATCH deny every discovered tool
    Probe->>Child: POST prompt_async turn 1
    Probe->>Child: poll status + transcript to completed turn
    Probe->>Child: POST prompt_async turn 2
    Probe->>Child: poll status + transcript to completed turn
    Probe->>Parent: inspect transcript for direct-prompt hand-back
    Probe->>OpenCode: abort if busy; delete child then parent
```

The first turn asks for a unique marker. The second asks for a different marker containing the
first marker. A `204` proves only prompt acceptance. Passing evidence requires a newly completed
assistant turn in the same child transcript.

The poller never infers completion from disappearance from `GET /session/status`; the status map
is process-local and absence is not terminal evidence.

## Required assertions

| ID | Passing evidence |
|---|---|
| `contract.health` | Healthy response and captured server version |
| `relationship.create` | Child has the created parent's exact `parentID` |
| `relationship.children` | Parent children contains the child exactly once |
| `relationship.list` | Directory session list contains both probe sessions |
| `safety.permissions` | Child permission suffix denies every discovered tool |
| `prompt.first` | New completed assistant turn contains turn-one marker |
| `persistence.idle` | Completed child remains readable and listed while not busy |
| `prompt.second` | Same child accepts and completes another prompt |
| `persistence.context` | Turn-two answer includes the requested turn-one marker |
| `cleanup.child` | Created child is deleted or cleanup failure is recorded |
| `cleanup.parent` | Created parent is deleted or cleanup failure is recorded |

Parent transcript changes, direct-prompt hand-backs, experimental capabilities, and unknown-ID
error status after deletion are observations rather than pass requirements.

## Ownership and cleanup

The implementation maintains an in-memory list populated only from successful create responses.
Before aborting or deleting, it re-reads the session and verifies ID, canonical directory, title
prefix, and run ID. It never discovers cleanup targets from a title search or directory listing.

Children are removed before parents. A session is aborted only when status positively reports
`busy` or `retry`. `--keep-sessions` retains created IDs in the private report for manual restart
inspection. Interrupt signals enter the same cleanup path rather than exiting immediately.

## Manual restart procedure

1. Run the probe with `--keep-sessions` and verify both turns completed.
2. Restart OpenCode through its actual supervisor; do not automate this in the probe.
3. Inspect the report's retained parent and child IDs.
4. Verify both sessions remain readable, linked, and present in directory/children listings.
5. Record status separately. Absence after restart is expected and does not imply completion.
6. If provider traffic is acceptable, prompt the retained child once more to establish resumability.
7. Clean up only the exact IDs from the private report after re-validating their run-prefixed titles.

| Evidence | Supported conclusion |
|---|---|
| Child survives idle and a second prompt | Session-level persistence |
| Child survives server restart | Durable session persistence |
| Status entry disappears after restart | Process liveness registry reset, not failure |
| Child accepts a post-restart prompt | Resumability across restart |
| No autonomous post-restart work | Expected; no scheduler was claimed |

## Parent deletion experiment

With both acknowledgements present, the probe deletes only its created parent, then re-reads the
child and directory list. It classifies observed behavior as `cascade`, `orphan-retained`,
`parent-link-cleared`, or `inconclusive`; it must not predict cascade semantics.

## Redaction and report handling

- Never log authorization headers, passwords, environment contents, raw SSE URLs, or complete
  `/doc` responses.
- Print the server origin without credentials, query, or path.
- Print only a directory basename and SHA-256 prefix.
- Keep full local directory and created session IDs only in the private report needed for cleanup.
- Do not retain full transcript text or arbitrary OpenCode error bodies.
- Write reports atomically with mode `0600`.
- Treat every report as containing sensitive local identifiers.

The report records probe IDs, durations, bounded evidence, sanitized errors, created-session
ownership, cleanup outcome, and a verdict for idle persistence, repeated-turn reuse, and optional
parent-deletion behavior.

## No-live verification

```bash
npx tsx scripts/probe-persistent-side-agents.ts --help

OPENCODE_URL=http://127.0.0.1:1 \
npx tsx scripts/probe-persistent-side-agents.ts \
  --dry-run \
  --directory /tmp/nonexistent-persistent-side-agent-probe \
  --model test/example

npm run typecheck
```

The dry run must succeed with an unreachable URL and nonexistent directory, proving it performs no
fetch, canonicalization, session creation, or report write.

> Passing automated probes proves that a child session can serve as a reusable, idle-persistent
> conversational side agent on the tested OpenCode version. It does not prove autonomous execution,
> durable liveness, crash recovery, scheduled work, guaranteed hand-back, or process-independent
> background ownership.
