const e=`# Sub-agents and child sessions

This guide explains delegated work in custom-dca-opencode: what creates a child session, how
the browser observes it, where Plan/Build permissions apply, and when a separate Git worktree
is the safer form of parallelism.

The important boundary is that OpenCode owns sessions and task execution. This application
adds a browser UI, a credential-holding BFF, and a derived view of child state; it is not a
durable background-job scheduler.

## Terminology

| Term | Meaning in this repository |
|---|---|
| **Task-tool sub-agent** | An OpenCode agent invoked by a parent turn through a delegation tool. OpenCode normally creates a child session for it. The child session has a \`parentID\` pointing to the parent. |
| **Parent session** | The session whose agent invoked the delegation tool. Parent and child remain separate transcripts. |
| **Foreground task** | A synchronous delegation. The repository's adapter treats a completed foreground task part as terminal because its supported contract says the parent call waited for the child. |
| **Background task** | An asynchronous delegation. Launch returns quickly and the workflow reports a task identifier; completion arrives later. A completed launch part does **not** prove that the child finished. |
| **Independent worker session** | A separately started OpenCode session, usually in its own Git worktree and branch. It is not a task-tool child unless it was created with a \`parentID\`. |
| **Session todo** | A checklist item from \`GET /session/{id}/todo\`. Todos organize one session; they do not execute work or create sessions. OpenCode 1.18.21 todos have no stable \`id\`. |
| **\`subtask\` command** | Catalogue metadata on a slash command. The UI displays whether a command is \`subtask\` or \`primary\`, but that flag is not child-session navigation and does not itself create or track a child. |
| **Sub-agent depth** | OpenCode's limit on nested delegation. This repository's project config sets \`subagent_depth\` to \`3\`. The Settings page displays the global config value read-only, which may differ from a project override. |

The durable relationship key is the **child session ID**. The derived ledger is keyed by the
session ID found in the child list and task-part metadata, not by a transcript tool-part ID.
Resuming a child can produce more than one task part for the same session.

The repository's \`background-subagent\` reminder asks an agent to report a task type and task
ID after launch. That human-facing launch identifier should not be confused with a durable
BFF job record: no such record exists. The UI reconciles OpenCode child session IDs instead.

## Architecture and data flow

The browser never calls OpenCode directly. Most requests carry an absolute \`directory\`, which
the BFF validates and forwards to the one long-lived OpenCode server. OpenCode can host sessions
for many projects in that single process.

\`\`\`mermaid
flowchart TD
    Browser[Browser SPA]
    BFF[Express BFF]
    OC[OpenCode server]
    Parent[Parent session]
    ChildA[Child session A]
    ChildB[Child session B]

    Browser -->|HTTP + SSE| BFF
    BFF -->|directory-scoped API| OC
    OC --> Parent
    Parent -->|task tool| ChildA
    Parent -->|task tool| ChildB
    ChildA -->|result / hand-back| Parent
    ChildB -->|result / hand-back| Parent
    OC -->|one global event stream| BFF
    BFF -->|fan-out + polling nudges| Browser
\`\`\`

*Figure 1. Native task data flow. The BFF fans out one upstream event stream; OpenCode creates
task-tool children.*

\`SessionSummary.parentID\` models the direct parent relationship. Session listings also derive
\`childCount\`, and the Hub builds a recursive hierarchy from those summaries. Root session creation
and native task delegation remain unchanged. The sub-agent panel also exposes a separate managed
launch path described below.

## Native tasks and managed children

There are two intentionally different delegation lanes:

- **Native task:** an agent invokes OpenCode's \`task\` tool. OpenCode owns task permissions,
  foreground/background behavior, depth accounting, resume and result hand-back. Parent session
  denies remain a child security ceiling.
- **Managed child:** a human uses **Launch child** in the sub-agent panel, or the composer's
  **Launch a Managed Child** workflow. The BFF creates a child
  with an explicit \`parentID\`, a retained agent (Plan, Build, Explore, or General), model, metadata
  and creation-time policy, verifies that OpenCode persisted those fields exactly, then prompts the
  child directly. It is independent of the parent's mode history and is never exposed as an
  agent-callable tool.

Managed children appear in \`/session/{parent}/children\` and have their own transcript and status,
but they create no native task part and inject no completion hand-back into the parent. Their state
therefore comes from the existing child transcript/status ledger. \`origin\`, requested agent and
requested model are provenance only; they do not prove effective capability.

\`\`\`mermaid
flowchart TD
    Human[Human selects Managed Child] --> Form[Workflow or panel form]
    Form --> Preview[Preview exact prompt and trusted injector]
    Preview --> Consent{Can selected agent modify?}
    Consent -->|Yes| Confirm[Explicit modify confirmation]
    Consent -->|No| Validate
    Confirm --> Validate[Validate agent catalogue and model]
    Validate -->|Rejected| NoLaunch[No session is created]
    Validate -->|Accepted| Create[Create parent-linked child with fixed rules]
    Create --> Verify[Re-read and verify persisted config]
    Verify -->|Mismatch| Cleanup[Delete partial child]
    Verify -->|Exact| Prompt[Submit child prompt asynchronously]
    Prompt --> Ledger[Derived child ledger]
\`\`\`

*Figure 2. Managed-child creation is a human-authorized, fail-closed lane. It does not create a
native task card or automatic hand-back.*

### Retained agents and the capability matrix

The launchable roster is fixed to four retained agents. The catalogue
(\`GET /api/managed-child-agents\`) filters that fixed list against the live upstream agent list:
hidden or invalid agents are dropped, a can-modify agent must cover every discovered tool, and an
empty or all-read-only tool catalogue fails the request closed rather than guessing.

| Agent | Access class | Session ceiling at launch | Extra authorization |
|---|---|---|---|
| \`plan\` | Read-only | Hard deny appended for every discovered mutating tool | None |
| \`build\` | Can modify | Resolved Build agent's wildcard and tool-specific rules projected onto every discovered tool | \`authorization: "modify"\` plus a UI confirmation |
| \`explore\` | Read-only | The same hard mutating-tool deny ceiling as Plan; its resolved agent policy is **not** trusted | None |
| \`general\` | Can modify | Resolved General agent policy projected; must cover every discovered tool | \`authorization: "modify"\` plus a UI confirmation |

Restrictions that hold for every managed launch:

- Read-only agents **reject** the \`authorization\` field; can-modify agents **require** it. The UI
  confirmation checkbox resets whenever the selected agent changes, so consent never carries over.
- The browser never authors raw permission rules. It names an agent id; all rule projection happens
  server-side against the resolved upstream agent policy.
- Metadata (\`customDcaManagedChild\`, version 2) records \`requestedAgent\`, \`authorization\`, and a
  \`policyFingerprint\` over the creation-time ruleset. The legacy \`requestedMode\` field is accepted
  as a Plan/Build alias on input only.
- Every follow-up prompt re-verifies session id, directory, agent, and policy fingerprint before
  submission. A mismatch — or managed metadata that fails validation — is a conflict, never a
  silent fallback to root prompting.
- Explore's read-only ceiling exists because project-level policy merges can weaken a resolved
  agent (see the live probes below); requested agent is provenance, the session ruleset is the
  boundary.
- Both launch surfaces read this catalogue rather than hardcoding a roster. Neither may spell out
  its own agent list or its own access class: only the catalogue knows which agents survived the
  filter and which of them can modify files, and a surface that guesses will offer an agent the
  server rejects or ask for consent the server never required. A catalogue that cannot be read
  disables launch and says why, because there is no verified agent to launch.

### Redaction boundary: derived metadata versus the submitted prompt

The child's persisted **session title** is derived from the first line of its assignment, and it
travels: session summaries, sub-agent rows, Hub titles, breadcrumbs and persisted notification
history all copy it. So recognized credential shapes (well-known token prefixes, \`Authorization\`
values, secret-named \`key=value\` assignments, URL userinfo) are stripped from the title *before*
the first line is taken and before the 80-character cap. Redacting after truncation would be
worse than useless: a cut token no longer matches any pattern, so the visible prefix survives.
The same redaction already covers the instruction audit log.

The **prompt submitted to OpenCode is never redacted**, and neither is the child's transcript. The
child must receive the exact text its human wrote, so rewriting it would silently break real work.

That asymmetry is the honest statement of what this is: mitigation for credential *shapes* leaking
into derived metadata that is copied into many surfaces at once. It is **not** a safe channel for
secrets. An assignment and a transcript preserve the submitted prompt verbatim, so anything placed
there is retained; pass credentials through the environment or a secret store instead. Filtering at
render time was rejected for the title because it would have to be correct independently in every
surface that already stores a copy.

For each browser-originated prompt, the BFF performs this sequence:

1. Validate the project directory, then resolve the directory-scoped session, agent identity, and policy.
2. Resolve and activate the requested Plan or Build policy on the addressed session.
3. Submit \`POST /session/{id}/prompt_async\` to OpenCode.
4. Return HTTP \`202\` to the browser after OpenCode accepts the prompt.
5. Let OpenCode continue the turn independently of the browser connection.
6. Observe later state through HTTP reads, with SSE events acting as refresh nudges.

The UI does not use blocking \`POST /session/{id}/message\`; that endpoint holds the request for
the entire agent turn. \`prompt_async\` returns immediately upstream and is the correct transport
for a browser that may disconnect or sleep.

## Foreground and background delegation

Foreground and background describe the relationship between the **parent turn** and a task-tool
child. They do not describe whether the browser's original prompt request blocks: browser prompts
always use \`prompt_async\`.

\`\`\`mermaid
flowchart TD
    Start[Parent invokes task]
    Kind{Execution mode}

    Start --> Kind
    Kind -->|Foreground| Wait[Parent waits]
    Wait --> ChildDone[Child turn finishes]
    ChildDone --> ParentResume[Parent resumes]

    Kind -->|Background| Launch[Launch returns task ID]
    Launch --> ParentContinues[Parent can continue]
    Launch --> ChildRuns[Child runs separately]
    ChildRuns --> Notice[Later completion hand-back]
    Notice --> ParentContinues
\`\`\`

*Figure 3. Supported foreground/background lifecycle. Background launch completion and child
completion are different events.*

The derived sub-agent ledger combines four imperfect sources:

1. \`GET /session/{id}/children\` supplies the authoritative child list but no liveness.
2. Parent task parts supply delegation intent, agent type, background metadata, and child ID.
3. \`GET /session/status\` reports children currently busy in the connected OpenCode process.
4. A child's own transcript supplies the strongest terminal evidence.

The BFF resolves state in this order: observed busy state, the child's final assistant turn, a
recognized hand-back in the parent, and finally the delegating task part. A foreground task part
marked completed is accepted as completion by the current adapter. A background task part marked
completed means only that launch returned, so it is never terminal evidence.

Background hand-backs currently need defensive recognition. The observed shape is a user-role
message in the parent without an explicit synthetic marker. The server requires both a known child
session ID and an outcome word before treating such a message as completion; the client applies an
additional delegation-word check before rendering a status row. A mere mention of a child ID
settles nothing.

These lifecycle shapes are encoded in implementation comments, deterministic mocks, and tests;
the bundled reminders prescribe the corresponding orchestration workflow. They were not
independently re-probed against a live OpenCode process for this page. In particular, contributors
should not assume every OpenCode version always emits a background hand-back. Keep unknown or
missing evidence as \`unknown\`, not \`completed\`.

## Plan, Build, and permissions

Plan/Build activation applies to the session named in each browser prompt. Policy activation and
\`prompt_async\` submission share a process-local lock keyed by \`(directory, session ID)\`, preventing
two concurrent browser prompts for that session from being submitted under each other's mode.
The lock ends after asynchronous submission; it does not cover the whole agent turn or other BFF,
TUI, or direct API processes.

\`\`\`mermaid
flowchart TD
    Prompt[Browser prompt]
    Resolve[Resolve mode + tools + rules]
    Lock[Acquire session lock]
    Valid{Policy valid?}
    Suffix{Rules already suffix?}
    Restore{Session patch needed?}
    Patch[Append session rules]
    Async[POST prompt_async]
    Child[OpenCode may create child]
    Risk[Stale child-rule risk;<br/>inheritance unverified]

    Prompt --> Lock
    Lock --> Resolve
    Resolve --> Valid
    Valid -->|No| Stop[Fail; do not prompt]
    Valid -->|Yes| Suffix
    Suffix -->|Yes| Async
    Suffix -->|No| Restore
    Restore -->|Yes| Patch
    Restore -->|No| Async
    Patch --> Async
    Async --> Child
    Child --> Risk
\`\`\`

*Figure 4. Plan/Build activation is fail-closed and suffix-idempotent. Child policy behavior is
kept outside the verified contract.*

The activation rules are:

- **Plan:** append deny rules for every discovered tool outside the read-oriented allowlist.
- **Build:** project the resolved Build agent's wildcard and tool-specific rules onto all
  discovered tools. Activation fails if the policy does not cover every tool. The BFF appends
  these rules when restoring a session with prior Plan denials; a direct Build session without
  those denials continues under its resolved agent policy without a session patch.
- **Append-only ordering:** the implementation and deterministic OpenCode mock model session
  permission patches as appended rules with last-match-wins precedence. Broad rules must precede
  specific overrides.
- **Suffix idempotence:** if the current permission list already ends with exactly the desired
  rules, activation does not append another copy.
- **Fail closed:** catalogue, session, agent-policy, identity, validation, or patch failure prevents
  \`prompt_async\` delivery.
- **No legacy \`tools\`:** prompt bodies omit the legacy \`tools\` override because non-empty overrides
  persist as session permission rules and can leave later Build turns unexpectedly denied.

Live OpenCode 1.18.22 probes established the permission boundary precisely:

- Session PATCH appends rules and evaluation is last-match-wins.
- A native task child copies parent session denies while discarding a later allow. A disposable
  parent with \`bash deny\` followed by \`bash allow\` produced a child with only the deny plus the
  normal child \`task\` deny. This is why Build -> Plan -> Build restores the parent but not new
  task children (#75).
- Direct child creation persists explicit \`parentID\`, agent, model, metadata and permission, and
  the child appears under \`/children\`. A managed Build child under a Plan parent completed a Bash
  command successfully while the parent transcript remained empty.
- The resolved Plan agent is not independently read-only after project policy is merged, so the
  BFF's session-level Plan denies remain load-bearing.

Keep the live probe disposable and version-scoped when changing this boundary. Do not infer that a
requested mode is effective policy, and do not synthesize native hand-back behavior for managed
children.

## Model selection for delegated work

Managed Children accept an explicit, validated model at launch, and the ledger shows the
requested model as provenance. The reference deployment's **forked** OpenCode binary, which
reports \`1.18.23+dca.2\`, also adds an optional \`model\` parameter to native \`task\` calls
(issue #90):

\`\`\`text
explicit task model > subagent configured model > invoking parent model
\`\`\`

Omitting \`model\` preserves the prior configured-model/parent-model behavior. The fork parses and
validates an explicit \`provider/model\` before it creates the child, so an unavailable model fails
without leaving an orphaned child. The resolved model is applied before the foreground/background
split and is preserved in task metadata, so the delegated-work panel reports the model that child
actually ran with. A \`task_id\` resume can select a model for that invocation only; it does not
change a session-wide default.

This is a **fork-only control**, not an upstream OpenCode capability. It has no separate model
override permission or budget: any agent that can invoke \`task\` can select any model configured
on the host. That is an intentional local cost-authority decision, not evidence that a requested
agent/mode has a different permission ceiling.

Upstream tracking is explicit:

- anomalyco/opencode#6651 is the open feature request for dynamic task-child model selection.
- anomalyco/opencode#34947 is the active upstream implementation. Unlike this fork, it adds a
  \`model_override\` permission that defaults to deny, so an agent cannot silently route work to an
  expensive model. It is open and unmerged as of 2026-08-26.
- Earlier raw-model implementations (anomalyco/opencode#26535 and #29447) were closed as
  superseded by #34947. Do not open a competing upstream PR from this fork.

The deployed fork exposes the raw parameter because the operator chose immediate model control
over a deny-by-default cost gate. Revisit that choice when adopting an upstream implementation;
do not claim that the fork's model parameter has landed in a stock release.

### Why the version string carries \`+dca.<n>\`

The fork build reports \`<upstream package version>+dca.<n>\`, where \`<n>\` counts the fork patch
set. That suffix is SemVer **build metadata**, deliberately not a prerelease tag:

| Form | Plugin \`engines\` ranges | Ordering vs stock | Honest about the fork |
|---|---|---|---|
| \`1.18.23\` | passes | equal | **no** |
| \`1.18.23-dca.1\` | **fails \`>=1.18.0\`** | **sorts lower** | yes |
| \`1.18.23+dca.2\` | passes | equal | yes |

A prerelease would be rejected by \`semver.satisfies\`, so any plugin declaring an \`engines.opencode\`
range would refuse to load. Build metadata is stripped before comparison, so the build behaves
exactly like the release it is based on while still naming itself honestly in \`/global/health\`,
\`--version\`, the LLM \`User-Agent\`, MCP \`clientInfo\`, and the durable per-session \`version\` field.

Rebuild with both variables set explicitly:

\`\`\`bash
OPENCODE_VERSION=1.18.23+dca.2 OPENCODE_CHANNEL=prod bun run build --single
\`\`\`

Omitting \`OPENCODE_VERSION\` stamps \`0.0.0-<branch>-<timestamp>\`, and a major of \`0\` silently
disables the plugin engine check. Omitting \`OPENCODE_CHANNEL=prod\` lets the channel be inferred,
which can change database selection and enable experimental websockets.

\`\`\`mermaid
flowchart TD
    Task[Native task call] --> Requested{Explicit model supplied?}
    Requested -->|Yes| Parse[Parse provider/model]
    Parse --> Validate{Configured model exists?}
    Validate -->|No| Fail[Fail before child creation]
    Validate -->|Yes| Explicit[Use explicit model]
    Requested -->|No| Agent{Subagent has pinned model?}
    Agent -->|Yes| Pinned[Use agent model]
    Agent -->|No| Parent[Use invoking parent model]
    Explicit --> Dispatch[Foreground or background child dispatch]
    Pinned --> Dispatch
    Parent --> Dispatch
    Dispatch --> Provenance[Emit normalized task metadata.model]
    Provenance --> Ledger[Render resolved model as provenance]
\`\`\`

*Figure 5. The deployed fork's native-task model resolution. This is fork-only: no
\`model_override\` permission or budget gate limits an agent's explicit selection.*

## Events, polling, and completion

The BFF owns one upstream \`GET /global/event\` connection. Unlike directory-scoped \`/event\`, the
global stream wraps events with their project directory. The BFF unwraps unknown event types
safely and fans events out over \`/api/events\`; project clients request a directory filter. Events
without a directory are still forwarded because they cannot be reliably assigned.

Classic SSE has no replay cursor. Event delivery is therefore a **nudge**, not the source of truth:

- An open conversation polls session state every 3 seconds and polls immediately on relevant SSE
  events. Hidden tabs skip interval ticks and refresh when visible again.
- The Hub polls its session list every 10 seconds.
- While the sub-agent tab is active, its panel polls every 10 seconds when it has \`running\` or
  \`launched\` rows; it also has a manual Refresh action.
- Both upstream and browser SSE connections retry with bounded backoff.
- Reconnection itself does not synchronously refetch in the conversation hook. The standing poll
  or a subsequent event reconciles state, so documentation and UI must not imply replay.

There is no durable background-job list. \`/session/status\` is local to the connected OpenCode
process, and absence does not mean completion. The sub-agent endpoint therefore derives a report
on each request and can return \`unknown\`. Child transcript probing is bounded to protect the BFF;
the response marks \`truncated\` when older children were not inspected.

The notification service recognizes general idle, error, permission, and question events. It does
not define a guaranteed background-child-completion notification class. A recognized parent
hand-back can update the transcript and derived ledger, while a child idle event may produce only
a generic idle notification.

## Current UI behavior and gaps

Implemented behavior:

- Task invocation remains an ordinary transcript tool row. When child metadata is present, the row
  includes an **Open sub-agent** link and is not collapsed into an action group.
- The Hub nests child summaries beneath parents, labels child sessions, and shows direct child
  counts. Visual indentation is capped so deep trees remain readable.
- Managed children are visually distinguished from native tasks, because the two lanes carry
  different authority: a human authorized one directly, an agent initiated the other. A managed
  sub-agent row gets an info-toned surface and a **Managed Child** badge beside its title plus a
  stable \`data-origin="managed-human"\`; the Hub pill and the child transcript badge read
  \`Managed Child\` instead of the neutral \`sub\`. A native row keeps its **Native task** badge.
  Both labels are driven by the server-derived \`origin\`, so a child with neither validated managed
  metadata nor a task launch stays unlabelled rather than being relabelled on a guess — the same
  reason \`unknown\` is a first-class state.
- A child conversation shows a parent breadcrumb. Follow-up prompts in that transcript remain in
  the child and do not reach the parent.
- The Details view has a dedicated delegated-work panel with derived state, evidence, agent,
  background flag, cost, transcript link, manual refresh, and eligible Stop/background controls.
- \`GET /api/sessions/{parent}/subagents\` exposes the derived ledger. There is no literal public BFF
  \`/children\` passthrough; the richer route wraps upstream child data with status evidence.
- Pending question views and mutations are session-owned. Permission requests are fetched for the
  directory and filtered to the current session in the conversation UI; the permission reply route
  itself is keyed by directory and request ID rather than a parent session path.

Known gaps and limits:

- The panel shows coarse derived state, not live child steps or aggregated child todos.
- OpenCode exposes no durable background-job registry, and a server restart can leave a child
  \`unknown\` even when the session still exists.
- Only children reported busy by the connected process can be stopped. Background promotion is
  shown only when the connected server advertises the experimental capability.
- Automatic sub-agent polling stops once no row is \`running\` or \`launched\`, and transcript/SSE
  updates do not independently restart that poll. A newly delegated or \`unknown\` row may require
  manual refresh or leaving and reopening the sub-agent tab.
- Transcript probes are capped, so older unresolved rows can remain unknown. The UI discloses
  truncation instead of implying completion.
- Parent/child links are direct relationships, not a durable job graph with retries, queues, or
  cross-process ownership.

## Choosing a parallelism model

| Need | Prefer | Why |
|---|---|---|
| Independent, read-only research within one turn | Task-tool sub-agents | They isolate context and can return concise evidence to one parent. Split by non-overlapping source or question. |
| One result is required before the parent can proceed | Foreground task | The parent waits and can consume the result immediately. |
| Independent work can finish later | Background task | The parent can continue, provided the work needs no immediate back-and-forth and completion uncertainty is acceptable. |
| Several code changes on different branches | Native Task children in separate worktrees | Git indexes, branches, and working files are isolated while OpenCode retains the parent/child relationship and hand-back behavior. This requires the guarded workflow below. |
| A checklist inside one session | Todos | Todos express progress only; they do not create concurrency. |
| A reusable slash-command classification | \`subtask\` metadata | It describes the command catalogue, not execution state or navigation. |

### Safe parallel edits

Task children can edit an allowed sibling worktree, but access permission does not move the child
session into that directory. Relative edits, default shell CWD, LSP, VCS, snapshots, configuration,
and event envelopes remain scoped to the parent instance. A mutating child must therefore treat its
assigned absolute worktree path as a hard boundary.

On a **stock** OpenCode build, use a fresh Build-only parent for mutating children. During
workflow validation, children launched from a parent that had previously activated Plan retained
terminal Bash denies even after Build made the parent's own tools available again: stock
\`deriveSubagentSessionPermission\` copies every parent-session deny while discarding the later
allows that superseded them. A fork-only patch copies only denies that are still the parent's
effective action for their exact permission and pattern; deployments running a build with that
patch verified live (the reference deployment runs
\`opencode-1.18.23-dca.2\`, built from the
\`fix/subagent-effective-deny-inheritance\` branch; the binary filename is not a branch) no longer
need the fresh-parent workaround. On a build without it, failed preflight means stop; do not
weaken policy or silently replace the native child with an independent root session.

This patch is **not upstream**. anomalyco/opencode#45064 was closed unmerged on 2026-08-26 and
\`upstream/dev\` still ships the stale-deny filter, so every stock OpenCode build — including any
future release — reproduces the bug until that changes. Treat the local pin as permanent
maintenance, not a temporary bridge, and re-apply the patch on every rebuild.

\`\`\`mermaid
flowchart LR
    ParentRules[Append-only parent rules] --> Effective[Last-match-wins effective permissions]
    Effective --> ForkPatch[Fork: copy only effective denies]
    Effective --> Stock[Stock: copy every historical deny]
    ForkPatch --> ChildOK[Build child can use later-restored Bash]
    Stock --> ChildBlocked[Stale deny blocks the child]
    Upstream45064[anomalyco #45064] --> Closed[Closed unmerged]
    Upstream34947[anomalyco #34947] --> Open[Open upstream model-override work]
\`\`\`

*Figure 6. Upstream status is split: the deny-inheritance correction remains fork-only because
#45064 closed unmerged; #34947 is an open, separate upstream task-model implementation.*

Before launching parallel mutating workers:

1. Assign explicit file ownership and do not let two workers edit the same file.
2. Give each worker an absolute worktree path, branch, objective, exclusions, and verification
   commands. Require every Bash call to set that path as \`workdir\` (or use \`git -C\`) and require
   absolute paths for every read, edit, and patch.
3. Before edits, tests, commit, and push, require \`pwd\`, \`git rev-parse --show-toplevel\`, and
   \`git status --short --branch\`. Stop without mutation unless both resolved paths equal the
   assigned worktree.
4. Identify resources that worktrees still share: fixed ports, external services, global caches,
   credentials, databases, and state outside the worktree.
5. Allow only one worker to own a fixed-port stack or shared mutable service at a time.
6. Keep commits scoped to the assigned files; review before combining branches.
7. Never treat a background launch result as permission to duplicate its work in the parent.

The [parallel research handoff reminder](../reminders/parallel-research-handoff/SKILL.md) gives a
full research-to-worktree workflow. The [background delegation reminder](../reminders/background-subagent/SKILL.md)
and [deep research reminder](../reminders/deep-research-subagents/SKILL.md) provide narrower prompt
contracts. For mutating native children, inject the
[native worktree subagents reminder](../reminders/native-worktree-subagents/SKILL.md) before
delegating.

## Contributor verification checklist

When changing child-session behavior:

1. Verify endpoint and payload assumptions against the connected OpenCode server's \`GET /doc\`.
2. Preserve child identity by session ID and coalesce resumed task parts.
3. Keep background launch completion distinct from child completion.
4. Preserve state evidence and the honest \`unknown\` result.
5. Check parent ownership before mutating or aborting a child.
6. Test nested Hub rows, breadcrumb navigation, transcript links, the delegated-work panel, and a
   mobile viewport.
7. Test concurrent opposite-mode prompts, activation failure, repeated activation, and omission
   of legacy \`tools\`.
8. Run:

   \`\`\`bash
   npm run typecheck
   npm test
   npm run test:e2e
   \`\`\`

For the broader system boundary, see [Architecture](architecture.md). For the pinned live endpoint
evidence, see the [OpenCode 1.18.21 API audit](opencode-1.18.21-api-audit.md).
`;export{e as default};
