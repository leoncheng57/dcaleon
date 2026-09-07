const e=`# Repo memory for agents

A custom local coding-agent IDE built on the **OpenCode server API**. React/Vite SPA
(\`client/\`) + Express BFF (\`server/\`) talking to a long-lived \`opencode serve\` over
HTTP + SSE. Successor to \`custom-dca-ide-with-openhands\`, which is frozen.

## Architecture in one line

\`\`\`
Browser (desktop or phone via Tailscale) → client/ SPA → server/ BFF → opencode serve :4096
\`\`\`

There is **no container**. \`opencode serve\` is a single Bun binary running on the host
as your user. This is the biggest difference from the OpenHands runner and it shapes
several decisions below.

## Key facts

- **One server, all projects.** Nearly every instance-scoped route takes
  \`?directory=<abs path>\` and that is the project selector. Verified live: 32 projects
  / 2,483 sessions on one instance. \`server/opencode/client.ts\` owns this.
- **The API is much larger than the docs.** \`GET /doc\` on a live server returns
  OpenAPI 3.1 with 162 paths / 188 operations; the published docs show ~60. When in
  doubt, curl \`/doc\`, not the website.
- **The live \`GET /doc\` is the contract.** The SDK's classic query types are narrower
  than the 1.18.22 server and its event union is stale, so \`server/opencode/client.ts\`
  owns a small typed fetch seam instead of casting around the SDK.
- Tests: \`npm test\` (vitest, \`tests/*.test.ts\`, node environment, import with \`.js\`
  suffixes). \`npm run typecheck\` runs the client, server, and screenshot-tool tsconfigs.
  Note it covers \`client/\`, \`server/\` and \`scripts/\` — **no tsconfig includes
  \`tests/*.test.ts\`**, so a test file is checked only by vitest at run time.
  Playwright starts deterministic mock OpenCode and preview servers, so
  \`npm run test:e2e\` needs no live stack or keys. \`npm run test:e2e:docker\` runs the
  same suite inside a disposable container (decision 27); \`npm run test:e2e:host\` is
  the explicit host lane; \`npm run test:contract:host\` is the host-only contract lane.
- **Playwright runs spec _files_ in parallel against one BFF _and one mock_.** Tests
  inside a file are serial; files are not, and \`test.describe.serial\` orders only the
  file it is written in. So any state that is not per-request — BFF memory *or* the mock
  server's fixture objects — is shared across files, and a spec that both mutates and
  asserts it must own its key. Two flavours have shipped: auto permissions
  (directory-scoped BFF memory) and the mock's \`/test/*/reset\` endpoints, where
  \`sharing/reset\` deleted \`share\` from every session in every directory, so
  share-export.ui revoked the URL smoke.api was mid-assertion on. Hence: **a reset must
  only clear what its caller named**, and no two files may name the same key — mock
  directory, question scope or share-fixture session. \`tests/e2e-shared-state-ownership.test.ts\`
  fails the build otherwise. This class of bug passes in isolation and fails somewhere
  else on each full run, so it is diagnosed from the rule, not from a repro.
- PR screenshot requests are routes inside one fenced \`screenshots\` block in the PR
  body; the exact schema and local command are in README. Capture is an
  unprivileged fork-safe workflow. Only the default-branch publisher may validate
  its artifact, write \`gh-pages\`, or update the marker-owned bot comment. Never run
  artifact code or publish files not declared by its validated manifest.
- \`reminders/<id>/SKILL.md\` is read at runtime, not emitted by \`tsc\`. Keep the root
  catalogue beside \`dist/\` in deployments. Per-message injection accepts an ID only;
  the BFF resolves the body and appends the \`<reminder name="id">\` sentinel.
- \`agent-skills/\` is **retired** (decision 21c): its commands, simulations, parser and
  supporting docs are deleted, and only \`README.md\`, \`CREDITS.md\` and \`LICENSE\` remain
  so the third-party attribution outlives the file that carried it. \`/playbooks\` now
  renders the live workflow catalogue only. This remains separate from runtime
  reminders and \`/api/catalog\`, which reports external skills and commands loaded by
  the connected OpenCode process.

## Agent working conventions

- **PR visual review is a normal local completion step.** When creating/updating a
  PR, read \`.agents/skills/pr-screenshots/SKILL.md\` and run the gallery coverage plan.
  Capture/inspect relevant changed UI states or record the nonvisual skip. AI runs
  locally with existing authentication, never AI keys in Actions. Use
  \`npm run screenshots:gallery\` and its separate actor-owned comment marker.

- **Keep your own planning to-do list current as you work**, not just at the end. Mark
  an item \`in_progress\` before starting it and \`completed\` immediately after finishing
  it — never batch every update to the end of a multi-step task. This is about the
  agent's own session planning tool, unrelated to this app's in-product Todo API/feature
  (see the \`Todo has no id\` row below).

## Non-obvious API contracts (each one cost real debugging)

| Trap | Rule |
|---|---|
| \`POST /session/{id}/message\` **blocks for the entire agent turn** | Always use \`POST /session/{id}/prompt_async\` (returns 204) from a UI path |
| \`GET /event\` is **directory-scoped** | Subscribe to \`GET /global/event\` for a multi-project UI; demux on the \`directory\` field |
| \`server.heartbeat\` fires every 10s and is **absent from the typed event union** | Event reducers must tolerate unknown \`type\` values, never throw |
| \`GET /file/status\` returns \`[]\` unconditionally (binary stub) | Use \`GET /vcs/status\` |
| \`GET /find/symbol\` returns \`[]\` unconditionally | No symbol search; don't build on it |
| \`GET /find\` silently caps at 10 results | Narrow the query or shell out |
| No git commit/log/blame route exists anywhere | Run \`git log\` locally in the BFF |
| \`Todo\` has **no \`id\`** in 1.18.21 | Key task-list rows by index/content |
| A **background** task part flips to \`completed\` when the *launch call* returns | Never read it as "the child finished"; only a synchronous task part proves that |
| A background child reports back as a **user-role** message in the parent | Detect and re-render it, or it appears as a prompt the human never typed |
| There is **no durable background-job list** | Derive child state per request; \`/session/status\` is process-local, so absence ≠ idle |
| Permission precedence is **LAST-match-wins** | Put \`"*"\` first, specifics after — the opposite of most ACLs |
| Non-empty legacy \`prompt_async.tools\` entries persist on the session | Never enforce Plan with \`tools\`; activate mode with append-only session rules before prompting, and restore Build from the resolved \`/agent\` policy |
| \`PATCH /session/{id}\` appends \`permission\` rules | Compare the current suffix before patching so repeated same-mode prompts do not grow the ruleset |
| Mode policy and \`prompt_async\` are one critical section | Serialize them process-locally by directory + session so concurrent opposite-mode prompts cannot run under each other's policy |
| Classic SSE has no replay cursor | Refetch state on reconnect |

## Decisions

1. **Path B — custom UI on \`opencode serve\`.** Considered and declined: a plugins+cmux
   composition (cmux sidebars cannot render input controls, so a settings page is
   impossible there), and adopting OpenChamber. Research: \`docs/research/\`.
2. **No Docker in the application runtime.** The OpenHands runner needed \`agent-canvas\`
   (agent runtime) and Postgres (manager runs). Manager runs are dropped, so Postgres
   goes too. One process to supervise. This also removes the fixed-port constraint that
   limited the old repo to one running worktree at a time. Scope note: decision 27 adds
   an *optional test-only* container. Nothing needed to run, develop or deploy the app
   requires Docker, and no agent session ever executes inside one.
3. **Permissions replace the container boundary.** See \`opencode.json\`. Honest framing:
   opencode TUI sessions already ran host-side on this machine (some with \`--auto\`),
   so this makes an existing posture deliberate rather than adding new risk.
4. **Host git identity.** No bot-identity \`shell.env\` plugin. Agent commits and PRs use
   whatever credentials the host has. The old \`OPENHANDS_GIT_TOKEN\` / \`OPENHANDS_GITHUB_TOKEN\`
   split retires with the container.
5. **R2 (no auto-resume) is an accepted risk, detection-only.** OpenCode never persists
   "running" state — the \`session\` table has no status column, and \`/api/session/active\`
   is explicitly scoped to the owning process. A crash mid-turn kills the run silently.
   We do **not** auto-re-prompt (that can replay destructive work). Instead the UI flags
   a session as interrupted when it is absent from \`GET /session/status\` **and** its last
   message is an assistant turn with no \`time.completed\`, and offers a Resume that
   **prefills the composer** rather than auto-sending.
6. **Classic API surface only.** \`/api/**\` (v2) is newer, event-sourced and 401-gated;
   everything needed exists on the classic surface. Revisit if we want replayable
   per-session streams (\`/api/session/{id}/event?after=\`).
7. **Mobile is first-class.** Responsive below \`lg\`, PWA manifest, reachable over
   Tailscale. This is why the preview reverse proxy survived descoping (see #8) — from a
   phone there is no cmux pane to fall back on.
8. **Descoped from the OpenHands feature set**, because each only existed to reach
   *inside* the container, or is better served by tools already open:
   - Preview **lifecycle** (start/stop/logs/status) — dropped; the **reverse proxy** is
     kept for mobile.
   - Terminal page — dropped; the Commands panel (derived from the transcript, with
     \`.sh\` export) covers the read case.
   - Web PTY, disk usage bar, providers/models settings page — dropped.
   - Manager runs — dropped; the \`manager-children\` cmux skill covers it.
   - MCP/LSP **latency probes** — dropped; \`GET /mcp\` already reports
     \`failed{error}\` / \`needs_auth\`, which is the diagnostic that mattered.
   - Permissions **editor** — downgraded to a read-only display of effective rules.
     Authoring happens in \`opencode.jsonc\`, which has \`$schema\` autocomplete.
   - Skills toggles, condenser settings — no OpenCode equivalent; dropped.
9. **Plan/Build is activated on the session before each classic prompt.** Issue #15
   established that legacy \`tools\` overrides are converted into persistent session
   permission rules, so omitting \`tools\` on the next Build prompt does not restore
   write access. Plan now appends denies for discovered mutating tools while leaving
   \`task\` governed by the resolved Plan agent's pattern-specific permissions, so safe
   read-only delegation remains available without allowing unsafe agents. Build projects
   the resolved Build agent's wildcard and tool-specific rules onto discovered tools.
   Neither mode appends an unconditional task allow; this preserves configured asks and
   pattern-specific denies under OpenCode's last-match-wins semantics.
   Activation must succeed before \`prompt_async\`, and exact suffix checks make repeated
   same-mode prompts idempotent.
10. **Notification resolution is manual-only and server-persisted.**
    \`.state/notification-history.json\` (\`NOTIFICATION_HISTORY_FILE\`) is
    written by \`NotificationService\`, which previously discarded everything it sent. Every
    notification kind starts unresolved and contributes to the current-directory red
    counter. Upstream permission/question replies never resolve notification records; only
    the user's reversible **Resolved** checkbox may change that state. Suppressed and failed deliveries are
    still recorded — the log's job is to explain a missing ping. \`delivery.desktop\` is the
    server-backed desktop preference, never proof of render; device-local sound/speech are
    intentionally absent because the BFF cannot see them. Every unresolved record the user
    was actually pinged about is retained, plus the newest 500 in each capped category
    (resolved, and unresolved-but-suppressed). There is no bulk clear because resolved
    history is the evidence this feature exists to preserve. Persisted v1 resolution reasons
    remain readable, but all new resolution writes use \`resolvedBy: "checked"\`.
10a. **Suppressed records are a bounded audit trail, and the noise filters are
    server-side.** \`delivery.suppressed\` (\`"auto-permissions" | "subagent"\`) marks the two
    categories that are recorded but never delivered. They exist so "why was I never
    asked?" and "did my delegated child ever finish?" stay answerable — sub-agent events
    used to be dropped at ingest, which made the second question unanswerable — but they
    are noise in an inbox, so the UI hides both by **default** behind checkboxes rather
    than excluding them in code. One child event is exempt from the subagent category:
    a **permission ask** takes the delivery path regardless of lineage, because a child
    stopped on an unanswered ask is stalled work nobody else can unblock, and suppressing
    it meant a delegated task sat frozen while the inbox swore nothing needed anyone. Its
    parked escalation follows the same policy. A child ask in an auto-approved directory
    is still suppressed — as \`auto-permissions\`, since it was answered before anyone was
    blocked. A child that merely finishes stays recorded-only: it hands back to its
    parent, so telling the human is noise. Because they were never delivered they are not a
    checklist, so unlike delivered unresolved records they are capped by \`prune()\`; a busy
    auto-permissions project would otherwise grow the log without limit. The filters are
    applied in \`HistoryStore.list()\` **and** \`activeCount()\` together and driven by query
    flags, because a badge counting rows the user asked not to see just relocates the
    clutter. An absent flag means no filtering, so existing API consumers are unaffected.
    \`suppressedActive\` reports each category's unresolved total whether or not its filter
    is on, so a checkbox states its own cost.
10b. **Records snapshot the session title; they never resolve it on read.**
    \`sessionTitle\` is written at append time from titles the service already saw on
    \`session.created\`/\`session.updated\` or its parent/child lookups — it never issues a
    request of its own, and omits the field rather than inventing a placeholder. Sessions
    get renamed and deleted, so resolving later would misattribute or lose the record.
11. **Auto permissions is directory-scoped and persisted.** The BFF replies \`once\` to
    \`permission.asked\` for every session in an enabled directory. It never mutates
    policy, replies \`always\`, or answers questions; it can only approve requests that
    upstream emits as asked. It does not change the Plan/Build session-policy activation
    above. Permission and parked-permission notifications are recorded with
    \`suppressed: "auto-permissions"\` while enabled — never delivered, and hidden from
    the inbox and the badge by the default filter — because those asks were answered
    before the user saw them. The enabled flags live in
    \`.state/auto-approve.json\` (\`AUTO_APPROVE_STATE_FILE\`, mode 0600) and are restored
    on boot: the flag was memory-only at first, which read as a safety default but had
    the opposite effect — every deploy silently flipped an auto-approved directory back
    to ask mode, and the next agent turn pushed one permission ask per tool call at
    every configured phone until the user noticed and re-toggled. Persisting an
    instruction the user already gave through the authenticated UI is not an
    escalation. A corrupt state file fails closed to everything-off; an explicit toggle
    always wins over the startup load; on restore the service reconciles pending asks,
    so requests that arrived while the BFF was down are answered too.
12. **Recents are cross-project; they are the one non-directory-scoped route.**
    The Hub shows recent work before a project is chosen, so \`GET /api/recent-sessions\`
    takes a *set* of directories instead of \`?directory=\`. There is no global session
    list upstream — \`/session\` is directory-scoped — so this is a capped, concurrency-
    limited fan-out (\`listSessionsAcross\`) whose per-directory failures are swallowed:
    one renamed project must not blank a panel that is mostly about other projects.
    The candidate set is shared pins plus the browser's own history, **not** every
    discovered project, because discovery is capped at 500 directories and each costs
    two upstream calls. Consequence to accept or revisit: a project that is neither
    pinned nor previously opened in this browser stays invisible. Recents poll on
    their own 60s timer, not the 10s session poll. Invalid directories are dropped
    rather than rejected — localStorage outlives renames and moves between machines.
13. **Sub-agent state is derived, and \`unknown\` is a first-class answer.**
    OpenCode has child sessions but no durable background-job API, so
    \`server/opencode/subagents.ts\` combines four upstream facts —
    \`/session/{id}/children\`, the parent's task parts, \`/session/status\`, and the
    child's own transcript — into one ledger keyed by **child session id**, never by
    task-part id (resume emits several parts per child). Precedence is fixed:
    observed busy, then the child's own final turn, then a hand-back notice in the
    parent, then the delegating task part. A **background** task part that reports
    \`completed\` means only that the launch call returned, so it is never read as a
    finished child; a **synchronous** one blocked on the child and is. When nothing
    settles it — a cancelled child, or an agent server that restarted mid-run — the
    row is \`unknown\` and names what was checked. Three cancelled children were
    observed in the audit with no parent notification at all, so guessing here would
    print a confident falsehood. Cost is bounded: the newest parent page for intent,
    and child transcripts probed only for children that are neither running nor
    already settled, newest first, capped and concurrency-limited, with \`truncated\`
    reported rather than silently implied.
    OpenCode defaults \`subagent_depth\` to 1, which prevents nested delegation; this
    repository sets it to 3. The Settings page displays the global value read-only,
    while project-level authoring remains in \`opencode.json\`.
14. **A hand-back notice is identified by the child session id it names.**
    Background children report completion by injecting a *user-role* message into
    the parent, and nothing upstream marks it as machine-authored — left alone it
    renders as a chat bubble the human never typed. Both detectors require an
    outcome word *and* a child session id (the server additionally requires the id
    to be a known child; the client also requires a delegation word, since it
    cannot know the child set). A message that merely mentions an id settles
    nothing and is ignored: a spurious "completed" is the expensive direction to be
    wrong in. If upstream ever adds an explicit synthetic flag, prefer it and keep
    this as the fallback.
15. **Delegation controls only promise what the connected process can deliver.**
    Stop appears solely for children \`/session/status\` reports busy, because abort
    authority is process-local; background promotion is gated on
    \`/experimental/capabilities\`, never on an environment variable the BFF cannot
    read. Child endpoints verify the parent link before acting — upstream will abort
    any id, so \`/sessions/{parent}/subagents/{child}/abort\` would otherwise be a
    general-purpose abort endpoint wearing a sub-agent costume.
16. **Per-message Plan/Build provenance is classified from that message alone,
    and is provenance rather than policy.**
    A session switches modes, so the session's *current* mode says nothing about a
    row already on screen, and pagination can drop the prompt that set it — which
    rules out inheriting mode from a neighbour, a parent, or the session. Raw
    metadata is inconsistent: user messages name the primary agent in \`info.agent\`,
    some assistant messages carry \`info.mode\` and others only \`info.agent\`. For an
    assistant turn \`info.mode\` is primary and \`info.agent\` is only a fallback, so a
    recognized mode classifies the row even when the agent naming it is internal or
    a sub-agent (\`compaction\`, \`explore\`, anything added later); those identities go
    neutral only when nothing else classifies them. An unrecognized \`info.mode\` is
    an unknown *label*, says nothing about authorship, and falls through to the
    identity. Recognized values that disagree yield nothing. The live 1.18.21
    capture in \`tests/fixtures\` only ever pairs \`info.mode\` with an agreeing
    \`info.agent\`, so this ordering is a forward-compatibility choice rather than an
    observed behaviour. Consequence to accept: a Build pill never proves the turn
    could mutate anything — per #75 a child can report Build while retaining a
    parent's historical Plan denies. "What could this turn do?" belongs on the
    sub-agent ledger, not here. Only user and assistant prose is marked; thoughts,
    tools, task cards, separators and errors share the message id but are
    operational detail, and marking them costs more legibility than the provenance
    is worth. The treatment is an accent rail plus a text pill and deliberately no
    body tint: markdown already uses surface fills for code blocks and tables, and
    a wash underneath them flattens that hierarchy. Mode is part of the prose
    reconciliation fingerprints, so a row first seen without metadata is replaced —
    not frozen neutral — when an authoritative fetch classifies it.
17. **Project Planning is one fixed repository feed and issue creator.** \`/planning\` is
    about improving this application, not whichever project directory is currently
    selected, so the BFF hard-codes \`leoncheng57/dcaleon\` and accepts no
    repository or directory from the browser. GitHub issues and pull requests share
    one list and retain their type, state, labels, creation time and last-activity
    time. Label colors are deliberately dropped: GitHub supplies arbitrary hex while
    client primitives require semantic tokens, and the label name already carries
    the meaning. REST pagination is bounded at 500 records and reports \`truncated\`
    explicitly rather than silently implying the feed is complete. Creation accepts
    only a bounded title, Markdown description and names from the bounded label
    catalogue, posts with the server-only \`GITHUB_TOKEN\`, and invalidates the read
    cache only after GitHub confirms the issue. A deep-linked item dialog reads a
    bounded 20,000-character description and the first 50 conversation comments,
    with each comment bounded at 8,000 characters; externally-authored Markdown is
    always rendered as untrusted. The same fixed-repository seam replaces labels on
    issues and pull requests only after validating them against a complete repository
    label catalogue, preserves up to 100 existing labels and refuses replacement
    when the upstream item exceeds that bound, permits at most one recognized
    priority label, and updates the grouped browser snapshot only after GitHub
    succeeds. The browser still cannot select a repository or project directory.
17a. **Planning is a priority-first queue with deterministic ownership.** Exact,
    case-insensitive \`priority:high\`, \`priority:medium\`, and \`priority:low\` labels
    select the outer section; items with multiple distinct priority labels appear
    only in an expanded \`Needs triage\` section rather than being silently promoted
    or demoted. Within a priority section, the alphabetically first non-priority
    label owns the item and \`Untagged\` sorts last, while every label remains visible
    on the row. High priority and conflicts open by default; lower queues collapse
    so a large backlog does not obscure current work. Five row-density treatments
    are a device-local display preference in \`localStorage\`, not repository planning
    data; the densest treatment is the first-visit default, and row labels share the
    status line rather than consuming another vertical band.
17b. **Planning epic hierarchy is bounded, read-only and device-local.** GitHub's
    issue list exposes child counts but not parent links, so the BFF fans out only
    across a bounded, concurrency-limited set of candidate parents and applies
    results afterward in deterministic parent order. The UI promotes an epic to
    the highest priority found on its parent or visible children, nests children
    only beneath that parent, and shows closed children as progress evidence. It
    never edits hierarchy. Expanded epic numbers persist in localStorage and
    malformed or blocked storage falls back to all epics collapsed. If filtering
    removes a parent while retaining its child, the child remains top-level with
    a parent breadcrumb rather than disappearing; unresolved or truncated edges
    are reported honestly instead of blanking the feed.
18. **PWA push supplements rather than replaces ntfy.** Web Push is a third independent
    delivery channel with its own server-backed enabled flag and event matrix. Device
    subscriptions are persisted server-side with mode \`0600\`; VAPID private material is
    environment-only. The service worker handles push, notification clicks, and explicit
    user-approved updates only: it has no \`fetch\` handler and caches no application or
    agent data. Expired subscriptions are removed after provider \`404\`/\`410\` responses.
    \`web-push\` is the runtime dependency because standards-compliant payload encryption,
    VAPID signing, and browser push-service requests are cryptographic protocol work that
    should not be reimplemented locally.
    Installed-PWA app badges use the global unresolved count across every project, excluding
    auto-permission and sub-agent records because those categories were never delivered.
    Every push snapshots that authoritative global count; opening the app and resolving or
    reopening a record resynchronizes it. A change made on another device therefore reaches
    the phone on its next push or app open, not through a separate badge-only background job.
18a. **A rotated subscription heals itself; the service worker's one network write is
    re-registration.** The browser retires a push subscription on its own schedule and
    \`pushsubscriptionchange\` is the only signal it gives. Without a handler the failure is
    invisible from both ends — the push service still answers \`2xx\` for the dead endpoint, so
    server-side delivery stats report success while the device receives nothing — and the only
    recovery was a human re-opening Settings and pressing Save, which re-POSTs the subscription
    as a side effect. The worker now re-subscribes and re-registers itself. It must carry the
    **\`installationId\`** when it does: the server's endpoint-based fallback cannot match a
    record whose endpoint just changed, so without the token a rotation appends a duplicate and
    strands the dead record instead of replacing it. This is the sole exception to decision 18's
    "no \`fetch\` handler, caches nothing" posture — it is an outbound write of the worker's own
    subscription to one fixed same-origin route, never a request interception — and it fails
    closed to a \`console.warn\`, because throwing here would take down unrelated push handling
    and Settings remains the manual fallback.
    A service worker cannot read \`localStorage\`, and this event fires with no page open to ask,
    so the installation token and the VAPID key are mirrored into the IndexedDB store the badge
    state already uses. \`event.oldSubscription.options.applicationServerKey\` is specified to
    carry that key but is not reliably populated, so it is preferred when present and the
    mirrored copy is the fallback. Those coordinates are duplicated in \`client/public/sw.js\`
    and \`client/lib/webPush.ts\` — a public asset cannot import from the bundle — and are
    dual-copy-tested like the reminder and workflow splitters, because drift would silently
    disable healing rather than fail.
18b. **A device summary must be able to distinguish devices.** \`id\`/\`addedAt\` were added to
    legacy records at read time and recomputed on **every** read, so the first subsequent
    write froze whichever \`Date.now()\` that read happened to see; in production this collapsed
    four devices onto one identical millisecond and erased their real registration history.
    Generated values are now persisted the first time they are produced, and a read of a
    missing file backfills nothing — a read must not create state. Summaries additionally carry
    the push service host as a platform family (\`web.push.apple.com\` → Apple) and echo the
    \`installationId\`, reversing PR #278's decision to withhold it: the token is opaque,
    per-installation and client-authored, so returning it discloses nothing the browser did not
    mint for itself, and it is what lets a device mark its own row. Endpoint and keys are the
    delivery credential and still never leave the server. A record with no token is labelled
    \`Unlinked\` rather than guessed at — it predates installation tracking, so it can be neither
    matched to a device nor replaced automatically, and it is the shape a stranded pre-18a
    rotation leaves behind.
19. **Human-managed children are a separate privilege lane from native tasks.** Native \`task\`
    delegation remains agent-initiated and keeps OpenCode's parent-session deny ceiling, task
    parts, depth accounting and hand-back. The sub-agent panel's **Launch child** action is an
    explicit human authorization: the BFF resolves a Plan/Build policy and validated model,
    creates a child with \`parentID\`, metadata and an exact creation-time ruleset, rereads the
    session to verify every security-relevant field, then submits directly to that child. The
    browser never authors raw rules, and this route must never be registered as an agent tool.
    Managed children appear in the normal hierarchy but create no parent task part or synthetic
    hand-back; their lifecycle is derived from their own status/transcript and may remain
    \`unknown\`. They are also **visually distinct** from native tasks wherever both appear (#182):
    the sub-agent row carries an info accent, a \`Managed Child\` badge beside its title and a stable
    \`data-origin\`, and the Hub pill and child-transcript badge say \`Managed Child\` rather than the
    neutral \`sub\`. The label is driven by the server-derived \`origin\`, never by the absence of a
    task part — a child with neither validated managed metadata nor a launch stays unlabelled,
    because relabelling an \`unknown\` child as either lane would print a confident falsehood about
    who authorized it.
    The child's persisted **title** is derived metadata and is redacted with the audit log's
    \`redactInstructionText\` **before** the first line is taken and before the 80-char cap; cutting
    first leaves an unmatchable token prefix in the title. The title is the widest leak surface
    derived from an assignment — it is copied into session summaries, sub-agent rows, Hub titles,
    breadcrumbs and persisted notification history — so it is redacted at the source rather than at
    render time in five places. The **submitted prompt and the child transcript are never
    redacted**: the child must receive the exact text its human wrote. Consequence to state
    plainly: this mitigates credential *shapes* in derived metadata and is not a safe channel for
    secrets, because the assignment retains them verbatim. Live 1.18.22 probes confirmed direct creation and also confirmed #75's asymmetry:
    native derivation copies a historical parent deny but discards its later Build allow. The
    resolved Plan agent alone is not read-only after project policy merges, so session-level Plan
    enforcement remains required.
    #75's asymmetry is **not** fixed upstream. anomalyco/opencode#45064 (drop a copied deny when
    a later rule supersedes it for the exact permission+pattern) was **closed unmerged** on
    2026-08-26, and \`upstream/dev\` still ships the stale-deny filter in
    \`packages/opencode/src/agent/subagent-permissions.ts\`. The patch exists only in this fork, so
    the pin is **indefinite, not a wait for an upstream release**: there is nothing pending to
    bump to, and every rebuild must re-apply it. Returning the plist to
    \`.state/launchd/ai.opencode.serve.plist.bak-stock-binary\` reintroduces the bug.
    The reference deployment's \`ai.opencode.serve\` LaunchAgent runs a binary built from
    \`fix/subagent-effective-deny-inheritance\` in the local opencode checkout (source version
    1.18.23; \`dev\` is an ancestor ~4,145 commits behind at 1.4.7 and is not a rebuild source).
    \`~/.opencode/bin/opencode-1.18.23-dca.2\` is the currently pinned binary; the earlier
    \`opencode-1.18.23-dca-taskmodel\` and \`opencode-1.18.22-dca\` files are rollback artifacts,
    never a branch or rebuild source.
    Verified live: a parent with appended \`[bash deny, bash allow]\` spawned a task child with no
    inherited bash deny that ran bash successfully. Session-level Plan enforcement is still
    required regardless — the resolved Plan agent is not read-only after project merges.
    That branch now carries a **second** fork-only patch: an optional \`model\` parameter on the
    \`task\` tool (leoncheng57/opencode#4), giving explicit model > subagent model > parent model.
    Upstream's active implementation of the same feature, anomalyco/opencode#34947, additionally
    gates it behind a \`model_override\` permission defaulting to **deny**, so an agent cannot
    silently move work to an expensive model; earlier ungated attempts (#26535, #29447) were
    closed as superseded. This fork has no such gate, so adopting that binary accepts unbounded
    agent-chosen model cost. Do not propose the fork's version upstream as a competing PR.
    **A fork build must say so in its version string.** Build it as
    \`OPENCODE_VERSION=<upstream package version>+dca.<n> OPENCODE_CHANNEL=prod\`, where \`<n>\` counts
    the fork patch set — today \`1.18.23+dca.2\` (1: the deny fix; 2: the task \`model\` parameter).
    That string is what \`/global/health\`, \`--version\`, the LLM \`User-Agent\`, MCP \`clientInfo\` and
    the durable per-session \`version\` field all report, so a plain \`1.18.23\` would attribute
    fork-only behaviour — a \`task.model\` parameter stock 1.18.23 does not have — to upstream.
    Use SemVer **build metadata (\`+\`), never a prerelease (\`-\`)**: OpenCode gates plugin loading on
    \`semver.satisfies\`, and a prerelease sorts *below* \`1.18.23\` and fails ordinary ranges like
    \`>=1.18.0\`, while build metadata is stripped before comparison and behaves as the release does.
    Both env vars are mandatory: without \`OPENCODE_VERSION\` the build stamps \`0.0.0-<branch>-<ts>\`,
    whose major of 0 silently disables the plugin engine check, and without \`OPENCODE_CHANNEL=prod\`
    the channel is inferred and can change database and websocket behaviour. Name the executable
    after the version with \`+\`→\`-\`; the filename is a convenience label, never the source of truth.
    \`EXPECTED_SERVER_VERSION\` pins the full string including \`+dca.<n>\` and is compared exactly, so
    an accidental fallback to a stock binary — which reintroduces the #75 bug — is visible rather
    than tolerated. Bumping \`<n>\` means updating this list, the pin, and the deterministic fixtures
    together.
20. **A file reference is data the server verified, never a URL the client trusted.**
    The client contract is \`WorkspaceTarget { path, startLine?, endLine? }\`, not a route:
    following a reference must not change the browser location, because the drawer is a
    temporary overlay and the reader's place in the transcript is the thing being
    preserved. Candidates come from parsed Markdown nodes — inline code spans and explicit
    links only — so bare prose, fenced examples, absolute paths, \`~\`, \`..\`, \`file://\`,
    UNC/Windows drives, query strings and non-line fragments never become candidates at
    all. Surviving candidates are collected from the frozen \`TranscriptEvent\` list rather
    than during render, deduplicated, and validated in one batched
    \`POST /api/workspace/references\` (64 per request, rejected rather than truncated),
    because each check spawns \`git check-ignore\` and one request per rendered code span
    would be a process storm on a streaming turn. Only \`status: "file"\` becomes
    interactive, and the UI opens the server's canonical \`resolvedPath\`, never the
    candidate — a symlink alias re-resolved later could point somewhere else.
    \`server/opencode/workspace.ts\` reuses \`requireReadableWorkspacePath\`, the same
    authority the read routes use, so validation can never be a wider door than the route
    it gates. A client-side match grants nothing; an unverified candidate simply renders
    as the ordinary text it renders as today.
21. **Composer workflows are forms first, and their injectors are visible-but-trusted.**
    The Workflows picker beside Reminder (#167) started with four guided actions —
    Playwright UI review, snippet-by-snippet PR review, send an update to another
    session, launch a Managed Child.
    Choosing one only opens a form; the sole exits are Cancel, "Apply to composer"
    (fills the draft, never sends), or the explicit Send/Launch on a preview that shows
    the exact generated prompt AND the trusted injector. Injectors invert the reminder
    secrecy rule deliberately: \`GET /api/workflows\` exposes the body so it can be read
    before submission, but sends still only carry the workflow *id* — the server
    (\`server/workflows/workflows.ts\`) resolves the text again at submit time, so a
    tampered browser cannot author hidden prompt content. The injector rides the
    persisted message as a \`<workflow name="id">\` sentinel with byte-identical
    client/server splitters (dual-copy-tested like reminders); the transcript strips it
    back out of the user bubble. Session updates send in the TARGET session's own mode
    (a hardcoded Build would restore write access to a session left in Plan), and the
    dialog states that prompt_async 204/202 means accepted, not completed. The
    managed-child form reuses decision #19's route and creates no task card and no
    automatic hand-back.
21b. **Most workflows are one generic argument, not a bespoke branch.** Adding a
    workflow used to mean adding a fifth, sixth and seventh id to four separate
    ternaries in \`workflow-dialog.tsx\`, one of which ended \`: objective.trim()\` — so an
    unrecognized id was silently treated as a Managed Child launch. A \`WorkflowPreset\`
    may now declare one \`argument\` spec (label, placeholder, hint, required,
    maxLength) whose typed value **is** the visible prompt, or a fixed \`prompt\` when it
    collects nothing; the dialog renders both from the server's description. The
    dialog keeps a list of what is *special* — the five workflows with real bespoke
    fields or their own submit path — rather than a list of what is supported, so an
    id this build has never seen degrades to "generic form, sent into this session"
    instead of to "launch a child". \`maxLength\` is clamped server-side to the prompt
    route's own 100,000-character ceiling, so a preset can never advertise a field
    whose full contents the send would reject. An optional field left blank is refused
    rather than sent: the message would be the trusted injector with nothing to apply
    it to.
    The preview states **"Sent in this session's current mode"** for every workflow
    that sends into this session, and this is not decoration. The 16 procedures ported
    out of the retired command catalogue could pin their own agent in frontmatter
    (\`agent: plan\` for the read-only ones). A workflow carries no declarative mode, and
    adding one was deliberately rejected as out of scope — so the guarantee is gone,
    and the UI has to say so rather than let a reader assume it survived.
21d. **A 22-item catalogue is scanned, not read, so the picker is a tile grid.**
    Full-width rows carrying a two-to-three line description fit ~4.5 of 22 workflows
    on a desktop screen and ~4 on a phone — four screenfuls to the last item, with at
    most 1.5 group headings visible at once, so the grouping organised nothing for the
    reader. The picker now uses the **same title-only tile grid as the reminder
    picker** (\`grid grid-cols-2 sm:grid-cols-3\`, \`min-h-14\` tiles), which puts over
    half the catalogue and several headings on one screen; an E2E assertion counts
    tiles above the panel fold on both form factors so the regression is caught rather
    than re-measured. The description is not lost, it is relocated: it stays on the
    form's preview stage where it is read before sending, and remains on the tile as
    \`aria-description\` and \`title\` so a screen reader and a hover still get it.
    Two consequences follow from the tile. **Every shipped workflow needs its own
    icon**: with a two-line title as the only text, the icon rail is the primary
    scanning aid, and a shared \`Circle\` fallback for 16 of 22 would carry no
    information — \`Circle\` now means only "a workflow this build has never heard of".
    And **search covers title and id only**. Matching descriptions was harmless at six
    workflows and is not at 22: "review" is a substring of "pre*view*" and of
    "*review*ing", so it surfaced "Send an update to another session" and "Start a DCA
    session" — tiles whose visible text did not contain what was typed. Matching is
    still a plain substring (the two pickers must not diverge), so "preview" still
    matches "review"; the property gained is that every hit now contains the typed text
    in the title the tile displays, which makes the result set explicable from screen.
21e. **The injector window is sized to the longest injector, not the shortest.**
    \`max-h-48\` (192px) was chosen when the longest shipped injector was 19 lines. The
    ported procedures run to ~160, so it showed roughly 5% of
    \`system-design-artifacts\`: technically scrollable, but not the read-before-send
    that decision 21 makes the entire trust story. It is now \`max-h-[60dvh]\` — still
    bounded, because the dialog must not become one unbroken page, and in \`dvh\` so a
    mobile URL bar cannot shrink it below what it promises. The Playbooks card's
    injector disclosure is bounded at \`18rem\` for the same reason in reverse: an
    unbounded preview turned one opened card into most of the page, and the detail
    modal is where a long injector is meant to be read end to end.
21c. **The repository command catalogue is retired; its procedures are workflows.**
    23 commands under \`agent-skills/commands/\` became 16 workflows and 7 deletions.
    The 7 — \`background\`, \`build-waves\`, \`handoff\`, \`duck-mode\`, \`grill-me\`,
    \`cite-file-lines\`, \`diagram\` — were already covered by same-subject reminders, and
    a second copy of the same instructions is worse than none. The 16 were ported
    **verbatim**, with only their \`$ARGUMENTS\` sentences rewritten, because the typed
    argument now precedes the injector as the prompt.
    \`standup\` is the one that could not be ported cleanly: its three \`\` !\`…\` \`\`
    shell interpolations were its entire input dataset and a workflow injector is
    never expanded, so it now instructs the agent to run those commands itself and
    says plainly that bash may be denied in a Plan session. Pretending the data was
    pre-fetched would have produced a confident standup written from the transcript.
    The reminder picker's per-reminder documentation link follows to
    \`/playbooks/workflows/<id>\` through \`client/lib/reminderWorkflows.ts\`. That map
    covers 6 reminders, not the 12 the old command map covered, and the gap is the
    honest number: the other 6 commands were deleted precisely because the reminder
    already said what they said, so there is nothing to link to.
21a. **The PR review workflow accepts a number, never a repository.** Its only input is a
    pull request, and \`parsePullRequestNumber\` reduces \`253\`, \`#253\` and a pasted PR URL
    to the integer alone — a URL's owner, repository and host are **discarded rather than
    parsed out and used**. The repository always comes from the session's project
    directory and the injector says so in the imperative, because this workflow ends by
    *posting* a public comment: a link copied from anywhere else must not be able to
    redirect where that comment lands. It sends in **this session's current mode**, so a
    Plan session stops at the write instead of having write access quietly restored
    (decision 9), and the form says that rather than letting the run fail silently. The
    injector carries the review method itself — pin every link to the head SHA so lines
    cannot drift, order steps to build understanding rather than follow file order,
    smallest snippet that carries the idea, explain *why* for non-obvious choices, and
    close by naming the riskiest snippet and whatever the change does not verify.
    That form has **no agent roster of its own**: it reads \`GET /api/managed-child-agents\`,
    the same catalogue the dedicated launcher reads, and derives the authorization
    requirement from each agent's \`access === "can-modify"\`. It shipped with a hardcoded
    \`["plan","build"]\` pair, which hid \`explore\` and \`general\` and — worse — decided
    "needs consent" by comparing an id to \`"build"\`, so a fourth can-modify agent would
    have launched unauthorized. Only the catalogue knows which agents survived the
    server-side filter and which can modify files. The default is a read-only agent so
    the pre-selected choice is never the one still missing consent, the consent resets on
    **every** agent change (an authorization for one agent is not one for the next), and
    an unreadable catalogue disables launch with a visible reason rather than presenting a
    dead button. Its \`ModelPicker\` must pass \`portalLayer="nested"\`: the default \`z-[90]\`
    portal renders *behind* this \`z-[95]\` dialog, and "nested" is also what inerts and
    \`aria-hidden\`s the parent so focus cannot land underneath the open picker.
21b. **Starting a DCA session creates an independent root, not a Managed Child.** The
    workflow locks its project to the source session's canonical directory, defaults to
    an isolated worktree and the current composer model, and offers only Plan or explicitly
    authorized Build. It creates no \`parentID\`, task card, provenance record or automatic
    hand-back, and success leaves the source route, draft, transcript, mode and policy
    untouched. The dedicated BFF endpoint validates the source session, exact body keys,
    workflow id, model/variant, mode and authorization before mutation; the browser never
    supplies a path field or trusted injector body. Within one BFF process, each
    source-directory/session/key tuple caches one fingerprinted promise, including failures,
    so duplicate submissions share the same outcome. This is not durable idempotency across
    BFF restarts: a process can die after creating a worktree or root but before returning its
    response. The client therefore permits exactly one Start attempt per open dialog, including
    after structured or ambiguous failures; the human must inspect the Hub, session list and
    worktrees, then close and reopen the form for an explicit new attempt and fresh key.
    Failures distinguish worktree setup, session creation and opening-prompt rejection; the
    latter returns the surviving session so the UI can link to it honestly. Unlike review
    workflows this workflow has no Apply-to-composer path: previewing mutates nothing and only
    **Start session** launches it.
22. **PR previews are static simulators, never public agent servers.** GitHub Pages cannot
    host the Express BFF or \`opencode serve\`, and putting either on a public endpoint would
    require credentials and expose host-level agent authority. \`VITE_PUBLIC_SIMULATOR=true\`
    therefore builds the real client with a browser-local \`/api\` fixture adapter, hash
    routing, a visible simulator banner, and no service worker or PWA manifest. Mutations
    are tab-local and reset on reload. Same-repository PRs build on every commit, publish
    only \`gh-pages:pr-previews/pr-<number>/\`, create a transient GitHub Deployment, and
    maintain one \`<!-- pr-preview -->\` comment; forks build an artifact but never publish
    JavaScript on the repository's Pages origin. The artifact manifest is bound to PR,
    full SHA, base path, file sizes, and SHA-256 digests and is revalidated before the
    shared non-force Pages write. Preview, screenshot, and public-site writers all use the
    \`pr-screenshot-publication\` concurrency group. Close cleanup removes only that PR's
    preview and screenshot directories, deletes their marker-owned comments, and marks the
    preview deployments inactive.
23. **Notifications group by session, and a folded group must still say what is
    waiting.** A session that needs three things wrote three rows repeating its title,
    which was the clutter. Grouping is device-local presentation and, unlike the two
    noise filters, is **never sent to the server**: it hides no record and changes no
    count, so no badge can disagree with it. Identity is the **\`sessionID\`** — never
    \`sessionTitle\`, which is snapshotted at append time (decision 10b), so one session
    contributes several titles as it is renamed and two unrelated sessions can share
    one; keying on it would both split a session and merge strangers. Records with no
    session fall into one bucket that always sorts last. Groups ship **on and folded**,
    which is only safe because the header itself says whether anything inside is
    waiting on a human: with a bare count, a default-collapsed group would hide an
    unanswered permission behind a number, and that hiding is the exact failure the
    "outside this view" notices exist to prevent. That guarantee was first carried by
    an aggregate **kind chip strip** ordered blocking-first. Issue #288 replaced the
    strip with a single **\`needs you\` marker**, and the swap is a narrowing, not a
    relaxation: the strip spent a line of every folded header enumerating up to six
    kinds, but only one bit of it — is something in here blocked on me? — ever changed
    what a folded reader did next, and \`error\`/\`abort\`/\`idle\` chips restated work that
    had already stopped. The marker renders only when an **unresolved** \`permission\`,
    \`question\` or \`parked\` record is inside, so its presence is the signal; an
    indicator that is always on says nothing. \`question\` is in that set although #288
    named only permission and parked, because an unanswered question stalls a turn
    identically and the two error directions are not symmetric — a marker on a group
    that did not need you costs a glance, a missing one costs the guarantee. Resolved
    records never mark, or the Resolved section would carry a permanent "needs you" on
    every request the user already dealt with. Anything that removes the marker without
    replacing it reintroduces the original failure and must not ship folded.
    The header also carries the session's **running/idle status** and, since #288, an
    \`Open\` **button** rather than an underlined link — see decision 30 for both.
    Expansion state is **one persisted
    boolean plus in-memory per-group toggles** — session ids are unbounded and outlive
    their sessions, so a persisted set of them would grow forever and accumulate ids of
    deleted work. Grouping happens **inside** the Active/Resolved split, never across
    it: that split is the action axis and stays outermost. A group header counts the
    rows it renders, not the session's lifetime total, because the window is bounded and
    the section's existing outside-window notice is the only honest claim about the
    unwindowed log; the client window and server \`MAX_PAGE\` were raised to 1000 together
    so that count is rarely a lie, while retention is 5,000 per capped category.
    Resolution stays reversible per decision 10: every row can still be reopened.
    **Resolve all (N)** on a session header is a deliberate, bounded exception to
    one-at-a-time action: it accepts only that group's currently loaded unresolved ids,
    states that exact count, requires confirmation, and never affects another session
    or older records outside the window. It persists the batch in one write rather than
    firing N requests, then returns every changed record to the ordinary Resolved list.
    Every row keeps its own link to the session, and a
    folded header carries one too so a group is reachable without being opened first;
    grouping moved the repeated *title* out of the rows, never their ability to
    navigate. That link is built client-side from \`sessionID\` + \`directory\` rather than
    from \`record.click\`, which is the **outbound** ntfy/Web Push URL: it is absolute,
    cross-origin, and \`undefined\` whenever \`PUBLIC_APP_URL\` is unset, so reusing it
    made an outbound-delivery setting decide whether the in-app UI could navigate at
    all — and made every notification inert in the fixture-backed PR simulator.
    The Active/Resolved split lives in the **URL** (\`?state=active\`), not component
    state: "what still needs me" is the view worth bookmarking. \`all\` is the absence of
    the parameter so the canonical link stays bare, an unrecognized value degrades to
    \`all\` rather than erroring, and the pills \`replace\` rather than push so Back keeps
    meaning "the page I came from". Resolution is a **button with \`aria-pressed\`**, not
    a checkbox: it is the row's only action and a 13px target was wrong for it,
    especially in a thumb-driven popover. It stays reversible. Since #288 it is no
    longer the row's *only* action — \`Open\` is a button beside it — but the reasoning
    that made it a button is unchanged and now applies to both.
24. **The server decides who gets pinged; the browser is not allowed a second opinion.**
    \`useNotifyWatcher\` used to re-derive notification kind from raw upstream events, so
    it had no view of session lineage: every delegated child's turn produced a desktop
    popup, a sound and speech in every open tab while the server filed the same event
    as \`suppressed: "subagent"\` and hid it from the inbox and the badge. Being pinged
    for things the notification list denies ever happened is the loudest half of the
    over-notification report (#180). The browser now reacts **only** to
    \`notification.recorded\`, which carries the server's post-append verdict, and skips
    anything \`suppressed\`. Raw events are still forwarded untouched for the transcript
    and the sub-agent ledger. Consequences: the record id becomes an exact dedupe
    identity instead of a heuristic, and the server stamps one OS notification \`tag\`
    onto both the push payload and \`notification.recorded\`, used by \`new Notification\`
    and the service worker alike, so N open tabs — and a foreground PWA that also
    receives the push — collapse to one popup instead of stacking. The tag is
    **session-scoped** (record-id only for sessionless records), because Web Push
    cannot retract a shown notification and replacement via a shared tag is its only
    correction: with per-record tags, a session that asked for bash seven times left
    seven stale "Needs approval" cards piled in the OS notification center, most of
    them already answered in the app. One replaceable slot per session means a later
    ask overwrites the stale one, the parked escalation overwrites the ask it
    escalates, and the eventual idle overwrites whatever was left. Collapsing is
    presentation only: the per-record dedupe still governs sound and speech, so a
    distinct record is never silently skipped.
24a. **iOS does not honour the tag, so tag collapsing is a desktop-only mitigation
    and must never be load-bearing.** Measured directly on an installed iOS PWA:
    two pushes sent seconds apart carrying an identical \`tag\`, with
    \`renotify: false\`, produced **two** notification cards rather than one
    replacing the other. Decision 24's "one replaceable slot per session" therefore
    describes the intended contract, not observed iOS behaviour — on iPhone the
    stale-card pile it was written to prevent still accumulates, and every
    notification the server sends is a card the user must dismiss. The tag is kept:
    it costs nothing, it works where it is honoured, and iOS may honour it later.
    The real consequence is a design rule. **Anything that would be "collapsed
    anyway" must be prevented from being sent at all**, because on the platform
    that actually receives these notifications nothing is collapsed. Decision 24b
    is the first application of that rule. When judging whether a second
    notification is acceptable, assume it will be shown.
    Where a repeat cannot be prevented upstream, the worker performs the
    replacement itself: before showing, it closes any card already displaying the
    same title and body. It matches on **content, not tag** — the tag is
    session-scoped, so two distinct records share one, and a repeat of a single
    record can arrive with no tag at all. It is close-then-show rather than
    skip-if-duplicate because the subscription is \`userVisibleOnly\`: a push
    handler that resolves without showing anything invites the browser's own
    "updated in the background" notification, so suppressing our card could
    replace a useful notification with a useless one. Any failure falls through
    to showing the card, because a duplicate is a far cheaper mistake than
    silence. That close-then-show is check-then-act, so it is **serialized**
    through a promise chain like the badge queue beside it: run concurrently,
    two handlers for the same content each read the shown-notification list
    before either has shown anything, so neither closes anything and two cards
    appear anyway. This is not theoretical — on device, pushes 8s apart
    collapsed correctly while a duplicate arriving within milliseconds did not,
    which is why the first version of this fix appeared to work in testing and
    failed in use. The queue chains through rejection as well as fulfilment so
    one failed show cannot wedge every later notification.
24b. **A stopped session is not a finished one, and Stop must produce one
    notification.** Pressing Stop makes upstream emit the abort and then
    \`session.idle\` — captured 5 ms apart — and both were delivered. The second
    claimed "Finished its turn and is waiting for you", which is not what
    happened, and because the idle carries the *previous* turn's excerpt (decision
    26/29) it rendered on a phone as a verbatim duplicate of the notification
    immediately above it. An aborted session is idle by definition, so the pair is
    one occurrence described twice. \`session.idle\` arriving within 30s of an abort
    **for that same session** is therefore dropped. The window is generous because
    anything genuinely new needs a fresh prompt, which cannot land inside it; the
    key is directory + session id, so stopping one session never silences another
    that legitimately finished at the same moment. It is **dropped, not recorded as
    suppressed**: the suppression categories exist so "why was I never told?" stays
    answerable, and here the user *was* told — by the abort for that very stop — so
    a record whose only content restates its neighbour is clutter, not an audit
    trail. This matches the existing echo dedupe, which also returns without
    recording.
25. **A kind switched off in every channel is suppressed, not silently badged.**
    Preferences used to gate delivery only, so turning a kind off silenced the ping but
    still wrote a permanent unresolved record — and \`abort\` ships disabled, so every
    Stop press added an item nobody opted into. Those records now carry
    \`suppressed: "preference-off"\`, the third category in \`SUPPRESSION_REASONS\`, with
    the full decision 10a treatment: recorded so "why was I never told?" stays
    answerable, never delivered, prune-capped, filtered out of both \`list()\` and
    \`activeCount()\` by a default-on checkbox that states its own cost. A channel merely
    being *unconfigured* does not count — "I never set up ntfy" is not the instruction
    "do not tell me about this", and only the second may suppress. Relatedly, the parked
    escalation now only arms when a parked alert could actually reach someone, and the
    5-second echo dedupe runs *before* the lineage lookup rather than after, so upstream
    echoes stop burning the 4-slot concurrency budget that the sub-agent gate depends
    on — it used to fail open during exactly the bursts it exists for.
26. **Notification records carry a bounded excerpt of what the agent actually said.**
    "Finished its turn and is waiting for you" is identical every time, so three of them
    from one session said nothing about which was which — the complaint in #186, made
    obvious by grouping them under one header. \`detail\` is fetched only for a delivered
    \`idle\` (a permission already names its tool, a question carries its preview, an error
    its reason) and costs one upstream read that borrows the session lookup's exact
    discipline: hard timeout, shared concurrency budget, fail open to \`undefined\`. A
    missing excerpt costs the row specificity; a stalled one would cost the user the
    ping. ~~It is **in-app only** — never copied into the outbound ntfy/Web Push body,
    which stays deliberately lock-screen-safe~~ — see decision 29 — and bounded on both
    write and read, because \`normalizeRecord\` is the only barrier against a hand-edited
    file and this is model-authored text on a durable record. Retention rose to 5,000
    per capped category; unresolved *delivered* records remain exempt from every cap.
27. **Docker is optional test infrastructure, one container per Playwright invocation.**
    Worktrees isolate source and dependencies but not the machine-global fixtures the E2E
    suite writes: \`/tmp/mock-*\`, their real \`.git\` directories, and ports 3410/4599/4600.
    Distinct ports isolate listeners, not filesystems, so concurrent runs raced on one Git
    index. \`Dockerfile.e2e\` + \`scripts/e2e-docker.ts\` give one invocation its own
    filesystem/PID/network namespace, and the fixed paths and ports are deliberately
    UNCHANGED inside it — which is why this lane migrated zero specs. Rejected: Compose
    (a shared long-lived stack reintroduces the shared state) and per-spec containers
    (cost without benefit, since one BFF already serves all spec files).
    The runtime takes no mount of any kind: no Docker socket, host home, credentials,
    host \`/tmp\`, writable source or writable artifact destination; plus \`--network none\`,
    \`--cap-drop ALL\`, \`no-new-privileges\`, \`--init\`, private \`--shm-size\`, bounded pids,
    non-root uid 1000, and no published ports. Source reaches the image only as a
    \`.dockerignore\` **allowlist** snapshot, so \`.git\`, \`.env*\` and \`.state/\` are absent
    rather than merely unreferenced — verified, not assumed. Artifacts are exported with
    \`docker cp\` from the *stopped* container into a launcher-chosen unique directory, then
    validated host-side: symlinks are refused rather than followed, and the bundle is
    count/size-bounded. A writable artifact bind was rejected precisely because the
    container could then delete host files. Cleanup names exactly one generated container
    and, only when it built it, one generated image tag — never a path from test output.
    \`--read-only\` root is deliberately NOT set: \`/artifacts\` must live in the container
    layer for \`docker cp\` to reach it after exit, and a tmpfs or bind would defeat that.
    The container layer is discarded on \`rm\`, so this costs no host isolation.
    Two limits are permanent, not bugs to fix later. Docker does not touch same-run
    cross-spec races — one container still hosts one BFF and one mock for every parallel
    spec file, so \`tests/e2e-shared-state-ownership.test.ts\` stays. And it cannot prove
    macOS behaviour, so \`tests/host-contract.test.ts\` keeps \`/private/tmp\`
    canonicalization, real symlink containment, host \`git check-ignore\` and \`0600\` state
    modes host-native. Honest framing, stated wherever the lane is documented: this is a
    state-isolation boundary, not a hostile-code sandbox. A PR can edit \`Dockerfile.e2e\`,
    the launcher and the npm script, so \`test:e2e:docker\` is a convenience command whose
    security depends on the checkout; untrusted review needs a trusted launcher and image
    definition from outside the tested tree. In CI the ephemeral read-only-token runner is
    that boundary.
    A preflight probes the daemon before building and, when Docker is absent, exits
    **69** (\`EX_UNAVAILABLE\`) rather than 1, so "the lane never ran" is machine-
    distinguishable from Playwright's "tests failed"; \`summary.json\` is written on that
    path too, carrying \`failureKind\`. It never falls back to the host lane automatically:
    free ports do not prove exclusivity, because a sibling worktree on a different \`PORT\`
    still writes the same \`/tmp\` fixtures, so the launcher names \`npm run test:e2e:host\`
    as an operator override instead of choosing it. A build failure after a successful
    probe stays exit 1 — that is a real defect and must not be excused as an environment
    problem. No per-PR image is published to GHCR: BuildKit \`type=gha\` cache scoped
    by platform + schema (not commit SHA) keeps the \`npm ci\` and browser layers warm
    without a registry, a write token or fork restrictions.
28. **DSH Trajectory is a bounded DCA-captured projection, not DSH persistence.**
    The pinned contract is DeepSeek Harness \`dsh-v0.1.1-rc.2\` at \`b150a551\`:
    \`session.event\` carries \`type\`, native \`seq\`, epoch-millisecond \`time\`, \`data\`, and
    optional \`ignorable\`, \`sourceEventSeqs\`, and \`surfaceOp\`. The bridge captures events
    only while it is running, deduplicates native seq, and assigns a separate DCA
    observation sequence. List/export responses always report
    \`complete: false\`, \`mayContainGaps: true\`, capture bounds, and observed native gaps.
    **Why capture rather than replay, stated precisely, because the loose version of
    this claim was wrong.** The *Python SDK* exposes no session list/read/replay: its
    surface is \`start_session\`/\`run\`/\`session_prompt\`, \`start_session(id)\` constructs a
    local object without replaying, and the entire client→server request map in
    \`packages/sdk/protocol/src/types.ts\` is \`initialize\`, \`session/prompt\`, \`shutdown\`,
    so even the generic \`request()\` escape hatch has nothing to call. But DSH *as a
    whole* does expose durable history: \`@deepseek-ai/dsh-session-persistence[-jsonl]\`
    are published on npm at the same \`0.1.1-rc.2\`, and \`SessionPersistence\` offers
    \`list\`, \`listSnapshots\` (cheap change tokens), \`inspect\`, \`readRaw\` and
    \`readFrom(id, fromSeq)\` — a documented watermark replay primitive for exactly this
    kind of read model, verified working from plain Node. Adopting it still carries
    costs and hazards: every published version is a
    release candidate; the backend constructor unconditionally installs a write path and
    needs a stub \`sessions\` service on a cordis \`Context\`; \`koffi\` is a native
    transitive dependency; the operator's cordis file is sha256-pinned so persistence
    must be *detected*, not mandated; and \`load\`/\`prepare\` sit beside the read methods
    while performing cold recovery that **durably rewrites** the harness's own log, so a
    read model must never call them. DCA never parses native or compressed DSH JSONL by
    hand — the vendor package is the only acceptable reader.
28a. **Durable mode reads the harness's own log; capture is the fallback, and the
    difference is typed.** \`server/dsh/durable.ts\` constructs the vendor JSONL backend as
    a reader and exposes only \`list\`/\`listSnapshots\`/\`readFrom\`. \`load\` and \`prepare\` are
    not surfaced at all rather than left available, because they perform cold recovery
    that rewrites the harness's log. DCA already owns the root: the bridge passes
    \`session_root\`, the SDK exports it as \`DSH_SESSION_ROOT\`, the stock composition
    resolves the backend's \`root\` from it, and the seatbelt profile only grants writes
    under that same state directory — so a composition that persists persists there.
    Persistence is still **detected, never mandated**: the operator's cordis file is
    sha256-pinned and may use \`!!js\` expressions only the runtime can evaluate, so DCA
    probes for a session artifact instead of parsing YAML. The artifact *filename* names
    the encoding, which matters because a reader built for the wrong \`compression\`
    throws on every read (it never misparses) and the default when the key is omitted is
    \`zstd\`. Detection is lazy and re-probed while unavailable, since the first session on
    a fresh install creates the very artifacts being looked for.
    Coverage is a **discriminated union**, not two booleans: the capture arm keeps
    literal \`complete: false\` / \`mayContainGaps: true\`, so a bounded capture still cannot
    be typed as complete. A durable read that returns *no* events is deliberately not
    treated as durable — an empty answer must never be promoted into a completeness
    claim. Durable events are projected through the same \`nativeProjection\` and sanitizer
    as captured ones, so the metadata-only safe-row rules hold whichever source answered,
    and their ids derive from the immutable log so repeated reads are stable.
    The two sources are **merged, not swapped**: the durable log is complete for what DSH
    did but knows nothing about what DCA observed around it, so \`dca-lifecycle\` records —
    a rejected prompt, a bridge exit, a capture gap — are interleaved by time and
    duplicate captured *native* events are dropped in favour of the durable ones.
28b. **DSH Build is a separate, explicit privilege lane.** OpenCode Build and managed
    children never authorize the independent DSH runtime. Each server-authored DSH
    preset declares \`read-only\` or \`build\`; the mode is snapshotted onto the session at
    creation and every prompt rejects if the current preset fingerprint or mode differs.
    Build selection requires a browser confirmation, but the browser still cannot author
    policy or paths. The outer macOS Seatbelt profile is the authority: read-only permits
    writes only under DSH state, while Build adds exactly the canonical allowlisted
    workspace and still denies every other write, including symlink escapes. The Cordis
    \`workspace-write\` policy is a second boundary, not the grant. Build initially permits
    file edits but does not specially allow a linked worktree's Git administrative
    directory outside the workspace; committing from such a worktree may therefore fail.
    Provider credentials cross the bridge only through the fixed allowlist
    (\`DEEPSEEK_API_KEY\`, \`OPENAI_API_KEY\`, \`ANTHROPIC_API_KEY\` and the DeepSeek endpoint),
    never via browser input or Cordis values. The production OpenAI composition pins the
    direct EU endpoint \`https://eu.api.openai.com/v1\`; keys remain only in mode-0600
    deployment environment files.
    OpenCode Run Log remains a separate transcript-derived feature and is unchanged.
    Safe trajectory rows are an event-type-specific metadata projection. They never
    inspect arbitrary payload text and never derive prompt, system/context text,
    commands, paths, tool arguments/results, reasoning, compaction summaries, or model
    output. Raw captured detail is sanitized before persistence with depth/node/string/
    array/object/byte caps and credential-shape redaction. A bridge stdout frame larger
    than 1 MiB is rejected before \`JSON.parse\` and the bridge is terminated so the run
    cannot continue across an invisible observation gap.
    There is no app-level authentication yet; the deployment still depends on private
    Tailscale reachability. Therefore sensitive one-event detail defaults off and requires
    \`DSH_TRAJECTORY_SENSITIVE_ENABLED=true\`, an explicit UI reveal, and a \`POST\` response
    marked \`private, no-store, nosniff\`. Full captured-detail export needs that flag plus
    \`DSH_TRAJECTORY_FULL_EXPORT_ENABLED=true\` and a separate confirmation. Sensitive UI
    state is cleared on drawer close, document backgrounding, and session change. No
    trajectory payload enters notifications, analytics, URLs, browser storage, or the
    service worker. Projection directories/files are forced to \`0700\`/\`0600\`, with age,
    event-count, session-file-count, per-file-byte, and total-byte retention caps.
29. **The excerpt reaches the outbound ntfy/Web Push body too, superseding decision 26's
    in-app-only boundary.** Every idle push looked identical on a lock screen even
    across different turns in the same session, which was the actual user complaint —
    the in-app fix in decision 26 never reached the channel people actually look at.
    Accepted explicitly without a consent gate: this deployment is reachable only over
    a private Tailscale network, and the existing bounding/fail-open discipline from
    decision 26 (240 chars, \`undefined\` on a stalled lookup) still applies before
    truncating again to \`NTFY_BODY_LIMIT\` (140 chars) for the outbound body. Applies to
    \`idle\` only — permission/question/error/parked bodies already carry their own
    dynamic, non-agent-authored content and are unchanged.
30. **A notification says something happened; session status says whether it is still
    happening — and \`unknown\` is one of the answers.** A notification could not tell you
    whether that session was still working, so deciding "open it now or let it finish"
    meant leaving the popover for the Hub (#288, absorbing #249). Status is **joined,
    never re-fetched per row**: \`SessionSummary.running\` already exists, so the centre
    asks \`/api/recent-sessions\` — the one route that already fans out across projects,
    and already bounded at 40 directories / 50 lookup ids with limited concurrency
    (decision 12) — with \`limit=0\` so the explicit \`session=\` lookups do all the
    selecting and the "newest few" half of that route is not paid for. It polls on
    recents' 60s timer, not the 10s session poll, and re-runs only when the candidate
    *set* changes rather than on every history refresh. Candidates are taken
    **unresolved-first**: resolution is manual-only, so a large resolved archive shares
    the window with the few rows that still need action and would otherwise consume the
    id budget that matters. The join lives in \`useNotificationCenter\` for the reason
    \`isGroupExpanded\` does — the popover and the history page render the same rows, and
    two independent answers to "is it still running?" could disagree while both are
    mounted. It shows in **both** row variants, since the question is identical on the
    popover and the history page — but a **grouped row suppresses it**, because the
    header already said it once for that session. Status describes the session, not the
    record, so repeating it down every row is the same duplication grouping exists to
    remove, and it is dropped for the same reason a grouped row drops the session title.
    Three states, not two. \`/session/status\` is **process-local**, so absence is not
    proof of idle (the same reason sub-agent state has a first-class \`unknown\`,
    decision 13). The distinction is drawn by **presence in the fan-out's answer**, not
    by the flag: a session the fan-out returned reports \`running\`/\`idle\` from its own
    field; a session it never covered — past the caps, owned by nobody, or a failed
    fetch — reports \`unknown\`, styled apart from \`idle\` (dashed, unfilled) so "we do not
    know" cannot be read as "nothing is happening". Every failure path degrades to
    \`unknown\`; a confident \`idle\` on a session that is in fact mid-turn is the one
    outcome this is engineered against.
    \`Open\` is a **button**, not the underlined heading text it used to be: it is the
    row's main action and was simultaneously its least prominent control, at roughly a
    13px tap target. It stays an \`<a>\` via \`Link\` — middle-click, cmd-click and "copy
    link address" belong to the anchor, and a \`<button>\` calling \`navigate()\` silently
    takes all three away — wearing real button styling through the exported
    \`buttonClasses()\` so a link-shaped button cannot drift from a real one. It is
    \`info\` (blue), not \`primary\`: this app's primary token is **green** and is already
    spent on \`Resolve\` beside it, so two solid same-coloured buttons would have to be
    decoded. The row \`flex-wrap\`s with a floor on its text column, because a kind badge
    plus readable text plus two 44px actions does not fit a 390px line and letting the
    text absorb the deficit truncated headings to a few characters.
32. **The row actions are icon-only, and what that removes is the label, never the
    target or the name.** \`Open\` and \`Resolve\` are square 44px buttons (40px for the
    group header's \`Open\`, the design system's own coarse-pointer floor) carrying
    \`ExternalLink\` and \`Check\`. Dropping the words bought the cluster roughly 60px of
    the line, which is why the wrap rule above stays: it is a smaller deficit, not an
    eliminated one. Two things are load-bearing. The tap target is pinned on **both**
    axes — \`size-11\`, not a height with content-derived width — because a target that
    shrinks with its label is the regression icon-only invites. And every control keeps
    an \`aria-label\`, since the visible text was the accessible name; the e2e suite
    asserts the name and both dimensions together, so losing either fails rather than
    silently degrading. \`Resolve\` draws **\`Check\` in both states**, with solid-green vs
    ghost and \`aria-pressed\` carrying resolved-ness: the icon names the *action*, which
    is always "resolve", and the old empty \`Circle\` only read as "not done yet" while
    the word sat beside it — alone on a green button it said nothing about what pressing
    it would do. The group's **\`Resolve all\`** is \`Check\` + count at a **fixed \`w-16\`**,
    because it is the one control whose label embeds a number and so the only one that
    resized as the number did: a group going 9 → 10 shifted its own header, and stacked
    groups with different counts never lined up. Four tabular digits cover every count
    the 1000-row window can produce. The popover footer link is centred, gear-icon'd and
    reads **"See all notifications and settings"**; it stays pinned *below* the scroller
    rather than between the Active and Resolved sections, because it is the way out of
    the popover and a long backlog is exactly when a link that scrolled away would be
    worth reaching. Its wording is duplicated in the outside-window notice, which tells
    the reader to use it by name — change the two together or the notice points at a
    control that is not on screen.
31. **Playbooks is the live workflow catalogue, and connected-process skills remain
    a separate inventory.** The repository-owned command catalogue this decision used
    to describe is retired (decision 21c), and with it the per-project "Loaded in
    <project>" badge, the install-command copy blocks and the \`/playbooks/commands*\`
    routes. Nothing replaced those, because a workflow needs no installation: there is
    no per-directory question left to ask, so the page no longer calls \`/api/catalog\`.
    **The simulation player is the exception: it was restored.** It went out with the
    command catalogue because the examples were STORED there, not because they were
    command-shaped ideas — all eight surviving converted workflows had one, so the
    deletion silently removed working documentation for things that still existed.
    Every workflow and every reminder now has exactly one worked example under
    \`client/simulations/{workflows,reminders}/<id>.md\`, and \`tests/simulations.test.ts\`
    asserts that in BOTH directions: a shipped id with no example fails, and an example
    for something no longer shipped fails too — which is how a file describing a
    deleted capability lingers as documentation for a feature nobody can invoke.
    The two directories are separate because an id can be both: \`session-handoff\` is a
    workflow AND a reminder, and one flat directory would serve one's example for the
    other. Simulations are client-bundled markdown rather than part of
    \`GET /api/workflows\`: an example is documentation ABOUT a guided action, not part
    of the trusted contract the server re-resolves at submit time. The cost is that a
    server-added workflow ships without an example, which the coverage test converts
    from a silent gap into a build failure. Their \`trigger\` field named a slash command
    (\`/goal\`); commands are retired, so it now names the id the example belongs to and
    is asserted to match the filename.
    Workflows are read only from \`GET /api/workflows\`, including their exact trusted
    injector, and are never copied into a client catalogue. Their grouping is
    presentation-only and every shipped workflow must be placed in one of the five named
    groups; the \`Other\` bucket exists for an id a newer server ships, and a shipped
    workflow landing there is a placement bug that reads identically in the UI. A
    detail route reports absence only after a successful catalogue load, never during
    loading or after a failure.
    The five groups are **Review · Execute · Delegate · Coordinate · Document**, and
    the server catalogue is authored in that same order so one file tells the truth
    about both. Two seams were redrawn while the catalogue was briefly 22 items:
    "Coordinate" was quietly two ideas — bringing a new session into being versus
    messaging one that already exists — so **Delegate** took those that create an
    agent and Coordinate kept the two that report to something already there (one
    machine, one human). "Ship" held two whose seam with Execute was soft; verifying
    and wrapping up are the end of doing work here, not a separate act, so they
    folded into **Execute**. **Investigate** was then removed outright rather than
    kept as an empty heading when both of its members were cut. Prefer folding a
    two-item group into an adjacent one over keeping a heading that only names a
    coincidence.
    **Playbooks documents both live categories at 1:1, and reminders are documented
    on their own terms.** Every workflow AND every reminder has a card and a detail
    route; the page is the answer to "what repeatable things exist here", and a
    category present in the composer but absent from the page made that answer a lie.
    The two stay visually and textually distinct — a workflow is a guided action you
    fill in and send, a reminder attaches instructions to your next message only —
    because merging them would imply an interchangeability neither has. One filter
    searches both: a reader should not have to know which category their subject
    lives in before they can search for it.
    This **reverses the reminder projection's withholding of \`body\`**. That was
    never what protected the reminder text: a send carries the reminder ID ONLY and
    the server resolves the body again at submit time, exactly as decision 21
    established for workflow injectors. Withholding it bought nothing and denied the
    reader the same read-before-send guarantee the injector already provides — so
    \`GET /api/reminders\` now serves \`body\`, and the detail page shows it verbatim.
    It **replaces the reminder-to-workflow join** (\`client/lib/reminderWorkflows.ts\`,
    deleted). That map pointed a reminder at a workflow merely sharing its subject,
    so most reminders had no link at all once the command catalogue was cut. The
    composer's details link now always points a reminder at its own page, including
    one this build has never heard of: an unrecognized reminder groups under \`Other\`
    and its page still resolves from the live catalogue, because a newer server's
    reminder being the only undocumented thing on the page is the exact failure this
    removes. Reminder grouping lives in \`client/lib/reminderCatalogue.ts\`, shared by
    the picker and the page so the two cannot disagree about where a reminder
    belongs. Do not confuse that module with \`client/lib/reminders.ts\`, which is the
    dual-copy-tested sentinel splitter.
    A reminder's absence is reported honestly: it may be \`scope_repository\`-scoped
    and genuinely absent for the selected project, so the not-found state says that
    rather than claiming the id is invalid. Since \`/playbooks\` carries no
    \`?directory=\`, the reminder catalogue resolves the last selected project through
    the same \`resolvePaletteDirectory\` seam the palette and notification centre use,
    and an absent directory yields the general reminders rather than an error.
    The composer's workflow tile carries a detail link, matching the reminder tile.
    It deliberately did not while the detail page only restated the injector the form
    already shows before sending (decision 21) — spending tile width on a guarantee
    the next click already makes. That reasoning expired when the page gained a worked
    example: a simulation is the one thing the form cannot show, so the link now buys
    something the next click does not.
    Runtime reminders under root \`reminders/\` remain application-owned per-message
    prompt bodies, never sourced from a workflow. The runtime \`/skill\` Catalog panel
    still reports whatever external skills and commands the connected OpenCode
    process loaded; do not remove or narrow \`server/opencode/catalog.ts\`.
32. **RETIRED — the public command catalogue is gone, and \`gh-pages:agent-skills/\`
    was deleted rather than left serving a stale index.** This decision used to
    specify a dependency-free generator that reused the command parser and published
    escaped HTML to \`/dcaleon/agent-skills/\` from trusted \`main\` commits.
    It is superseded, not merely unimplemented, and the machinery
    (\`.github/workflows/publish-agent-skills.yml\`, \`scripts/agent-skills-site.ts\`,
    its two entry points, \`scripts/publish-workflow-audit.ts\`,
    \`tests/agent-skills-site.test.ts\`, the \`build:agent-skills-site\` script and the
    \`yaml\` devDependency that existed only to parse that workflow) is deleted.
    **Why it could not survive the command model.** The catalogue was
    commands-only by construction. That was never a scoping choice: workflows —
    the live, first-class Playbooks category in decision 31 — are read from
    \`GET /api/workflows\` including their trusted injector, and a static Pages site
    has no BFF to read them from. So when commands were eliminated the generator had
    nothing left it was *able* to render, and a workflows-shaped replacement is not
    available at any price short of shipping the BFF to Pages, which decision 22
    already refuses for the PR simulator and refuses here for the same reasons.
    **Why leaving it alone was not an option.** The publisher has three hard throws
    on an empty or missing command set — a missing source directory, no valid command
    Markdown, and a manifest with zero commands — so the first \`main\` push after the
    deletion would have failed red. Worse, staging clears its destination *after*
    validation, so a build that throws never reaches its own \`rmSync\`: the job would
    fail forever while \`gh-pages\` kept serving an index advertising "Browse all 23
    commands", with no automatic deletion path. Retiring the publisher therefore had
    to include deleting what it had already published.
    **The deletion, recorded exactly.** 26 blobs under \`gh-pages:agent-skills/\`
    (\`index.html\`, \`assets/site.css\`, \`commands/index.html\` and 23 per-command pages)
    were removed by a normal non-force push, following the same clone/switch pattern
    the publisher used. \`pr-previews/\` and \`pr-screenshots/\` were left byte-identical
    and verified by tree SHA before and after, which is the only check that proves
    byte-identity rather than merely plausible survival. This is irreversible from
    the live site's perspective; the content remains in \`gh-pages\` history.
    **What carries over to the surviving Pages writers.** PR previews (decision 22)
    and PR screenshots still write \`gh-pages\`, still share the
    \`pr-screenshot-publication\` lock, and still use non-force pushes, so two lessons
    from this feature outlive it. First, a staging destination must be constrained in
    code, not by the YAML that calls it: staging clears its destination before
    copying, so \`--destination ../site\` was perfectly non-overlapping and would have
    removed an entire \`gh-pages\` checkout, \`.git\` included. Second, substring
    assertions over workflow YAML are not a security check — \`git push origin
    +HEAD:gh-pages\` force-pushes while containing neither \`--force\` nor \`-f\`, and an
    added trigger or a second \`permissions:\` block is invisible to \`toContain\` — so
    a Pages writer's safety must be asserted against a parsed document. Both lessons
    were bought here; do not re-learn them in the publishers that remain.
33. **The navbar identifies the deployed app build, not the connected OpenCode
    server.** Release Please derives semantic versions from Conventional Commits and
    updates the Node package version through a release PR; ordinary merges do not each
    invent a new semantic version. Vite therefore bakes both that package version and
    the current short commit into the client. The commit keeps deployments of the same
    release distinguishable, while builds without Git metadata honestly show only the
    version. The label yields its space on narrow phones rather than overflowing primary
    controls. Playbooks moved from the bar into More to make room and remains an
    unscoped link because \`/playbooks\` is a cross-project surface.
    While the app is below \`1.0.0\`, fixes and features both bump patch and breaking
    changes bump minor; ordinary SemVer behavior begins at \`1.0.0\`. The initial
    Release Please bootstrap is pinned to the parent of the workflow's introduction,
    so enabling releases does not turn the repository's full pre-release history into
    one fabricated changelog.
34. **The Claude Code runtime is a third island that drives the unmodified \`claude\`
    binary, non-interactive by policy.** Off by default behind \`CLAUDE_RUNTIME_ENABLED\`;
    a disabled route answers 404, a misconfigured one 503 with reasons, exactly like DSH
    (decision 28b's separate-privilege-lane rule applies — an OpenCode or DSH grant never
    authorizes this lane). It exists for one reason the other two runtimes cannot serve: it
    can be driven by a Claude subscription seat. Load-bearing facts, each of which cost a
    measurement:
    - **There is no interactive approval.** A bidirectional \`claude -p --output-format
      stream-json --input-format stream-json\` emits no \`control_request\`/\`can_use_tool\`;
      a blocked tool surfaces only as a terminal \`system/permission_denied\`. So the lane
      is non-interactive by construction, not by omission. Presets therefore select a
      non-interactive Claude permission mode, never \`ask\` (\`server/claude/config.ts\`
      rejects \`ask\`), and the generated settings map a would-be ask to deny.
    - **\`claude -p\` is one-shot**, unlike DSH's long-lived bridge. The supervisor spawns a
      fresh process per prompt with \`--session-id\` (first turn) / \`--resume\` (after), and
      cancel is SIGTERM of the in-flight child (\`server/claude/supervisor.ts\`). No pool.
    - **The credential lives in the macOS Keychain, and the BFF never touches it.** The
      env allowlist forwards no credential var; \`claude\` authenticates itself. This is
      decision 3's boundary as *code discipline*: reading \`~/.claude\`/Keychain to broker a
      token is the one thing this lane must never do, because that is exactly what
      Anthropic's policy prohibits for third-party tools. **But the env must carry the user
      IDENTITY** — \`USER\`/\`LOGNAME\`/\`__CF_USER_TEXT_ENCODING\`, synthesized when a
      launchd-minimal env lacks them. Measured the hard way: without \`$USER\`, even an
      un-sandboxed \`claude\` reports "Not logged in", because macOS resolves the login
      Keychain by user. Identity is not a credential; forwarding it is not brokering auth.
    - **Seatbelt is the write authority, but not a credential boundary.** Unlike the DSH
      profile it keeps HOME real and must grant read of \`~/Library/Keychains\` plus the
      securityd family, or subscription auth breaks — so the sandbox confines workspace
      *writes* (read-only presets get none; Build adds only the allowlisted workspace) and
      deliberately does not isolate the credential store. Verified on macOS in
      \`tests/claude-seatbelt.test.ts\`, which the \`host-contract-macos\` CI job runs.
    - **The pin is enforced at runtime, DSH-style.** \`CLAUDE_CLI_VERSION\` is validated into
      \`errors[]\` and re-asserted against the \`system/init\` frame's \`claude_code_version\`;
      a mismatch fails the turn. The binary auto-updates, so this is not optional — the
      wire format is undocumented and a silent upgrade must fail closed, not mis-parse.
34a. **Real Claude sessions isolate by git worktree, and Seatbelt's one outward grant is
    the project's \`.git\`.** A Build session chooses *direct* (edits land in the project) or
    *worktree* (\`git worktree add\` on \`claude/<uuid>\` under \`CLAUDE_STATE_DIR/worktrees\`,
    never inside the project — \`server/claude/worktree.ts\`). Worktrees keep metadata and
    objects in the shared \`.git\`, so the worktree profile grants \`<project>/.git\` write; it
    is inherent to git worktrees and is the only Seatbelt write that reaches outside the
    session's own directory. Rules that cost a real test each:
    - **Merge refuses a dirty project.** A merge must never be confused with the human's
      own in-progress edits; \`mergeWorktree\` checks \`isDirty(project)\` first and also
      refuses a branch with nothing to merge. Uncommitted worktree work is committed before
      merging so nothing the agent wrote is silently dropped.
    - **Changes are read from git every time, never cached** (\`workspaceChanges\`): direct
      sessions diff against HEAD, worktree sessions against the base commit so the agent's
      own commits count; untracked files are included; output is bounded and says so.
    - **Sessions are durable** (\`CLAUDE_SESSIONS_FILE\`, atomic write, reload on boot) and a
      session that was mid-turn at shutdown is marked *Interrupted by a server restart* —
      the same "detect, never auto-resume" stance as decision 5.
    - **Discovered projects are workspaces too** (\`CLAUDE_PROJECTS_ROOT\`, default
      \`PROJECTS_DIR\`, via the app's own \`discoverProjects\`), each with a dev/inode identity
      re-verified before spawn. The static allowlist still applies; the state dir may not
      live under the projects root.

34b. **The Claude lane shares the OpenCode composer's playbooks and the app's notification
    lane by translation, not by a second implementation — and the root is no longer any
    runtime's home.**
    - **Playbooks travel as ids; bodies are resolved server-side, in the OpenCode order.**
      \`POST /claude/sessions/:id/prompt\` accepts \`reminder\` and \`workflow\` ids and
      \`server/claude/prompt.ts\` composes workflow injector first, reminder after — the same
      \`composePromptText\` order as \`server/opencode/sessions.ts\`, using the same
      \`withWorkflowTag\`/\`withReminderTag\`. The transcript keeps the human's words plus the
      chips (\`reminders\`/\`workflows\` on the user row); only the binary sees the sentinels.
      Reminders are listed from a session-scoped route (\`GET /claude/sessions/:id/reminders\`)
      because a worktree cwd lives under the state dir, outside \`requireWorkspaceDirectory\`'s
      roots, and because the browser never names a path. Workflows whose submit path is an
      OpenCode route (session update, managed child, start-DCA, both review captures) are not
      offered; the Claude form only fills the composer.
    - **A finished turn becomes the bus events the NotificationService already understands.**
      \`ClaudeSessionStore.finish()\` — the one place every run ends — emits \`finished\`;
      \`server/claude/notifications.ts\` publishes \`session.updated\` (seeding a titled root so the
      service never asks OpenCode about a \`claude-\` id) then \`session.idle\` / \`session.error\` /
      the \`MessageAbortedError\` shape for a cancel, so a Claude Stop reads like an OpenCode Stop.
      \`server/index.ts\` constructs the store itself and hands the service Claude-aware
      metadata/excerpt lookups. \`claude-\` is the id discriminator for the click route
      (\`conversationUrl\`) and the in-app row (\`sessionRoute\`): both go to \`/claude/sessions/<id>\`.
    - **\`/\` is a near-empty landing that points at the public repository; the OpenCode hub
      lives at \`/opencode\`, a navbar peer of DSH and Claude.** Every runtime is reached from
      the navbar, so the root belongs to none of them. \`/sessions/:id\` stays where it was:
      moving it would break deep links, notification click URLs and phone transfer for no gain.
35. **All runtime islands share the right tools slot through SessionShell.** OpenCode,
    Claude and DSH pass their native runtime-prefixed session IDs to the same shell-owned
    opener, visibility state, Inspector replacement, and Browser/Minichats/Terminal panel.
    Keep shared tools here rather than adding island-specific drawers. The functional
    Browser, Minichats WIP page and Terminal WIP page share one selector; the latter two make
    the information architecture visible without claiming #56 or #59 has shipped. On desktop
    the tools slot participates in the conversation flex row and replaces the persistent
    Inspector while open—there is no modal scrim and no simultaneous pair of right sidebars.
    Browser uses a fixed 42rem width; WIP destinations use 28rem. Below \`lg\` the same surface
    is full-screen and safe-area-aware. Closing restores the Inspector and opener focus.
    Hiding Browser unmounts only its MJPEG response, so \`Page.stopScreencast\` freezes the
    server-owned page while its URL, history and shared-profile login survive. The client may
    request bounded viewport/touch input and either the default or coarse stream profile; the
    server owns the bounds and actual CDP parameters. The persistent profile is refused when
    its root grants group/other access, service workers and speculative network
    activity are disabled, WebSockets pass the same private-host policy as HTTP(S), and WebRTC
    is constrained to avoid non-proxied UDP. The dated design snapshot is **Live Browser and
    Right Tools Panel — 2026-09-07**; it supersedes rather than edits the 2026-08-27 proposal.

## Client conventions (inherited from the OpenHands runner, still enforced)

- \`client/ds/\` primitives are forwardRef + \`cn()\` + semantic \`var(--color-*)\` tokens
  only. **Never raw hex.**
- Every interactive element carries a \`data-testid\`.
- No new runtime dependencies without a reason recorded here.
- \`@deepseek-ai/dsh-session-persistence-jsonl\` + \`@deepseek-ai/cordis\` are pinned exactly
  and exist only to read DSH's durable session log (decision 28a). Hand-rolling a reader
  for a compressed, versioned, append-only format the harness also writes is precisely
  the thing not to do: the vendor reader refuses a newer log version and refuses unknown
  event types rather than misparsing them. \`@deepseek-ai/cordis\` is the fork the package
  actually imports \`Service\` from — plain \`cordis\` happens to work but is not what it
  declares. \`koffi\` arrives transitively, is Windows-only (\`kernel32.dll\`, behind a
  dynamic \`import\`), and its install script is not approved here, so no native build runs
  and the module is never loaded on macOS or Linux.
- \`yaml\` was a devDependency parsing the retired command-catalogue publication workflow
  and was removed with it (decision 32). Its reasoning still stands for any future
  workflow assertion: a regex approximation of YAML is exactly how \`+HEAD:gh-pages\`
  passed a force-push check, so re-add it rather than hand-rolling a parser. It is an
  optional peer of \`vite\`, so doing so is not a new ecosystem. It is now restored as
  a devDependency for the review publisher's structural asset-branch push-trigger
  checks and tests of the screenshot workflow's permission boundary (#197/#429).
- \`mermaid\` is the lazy-loaded diagram parser and layout engine for repository-owned
  in-app docs only. It runs with Mermaid strict security, then its generated SVG is
  stripped of links, executable DOM, embedded resources and unsafe CSS before mounting.
- \`playwright-core@1.62.1\` (exact) is the live session browser's CDP client
  (issue #229): one server-side persistent Chromium context, one page per
  conversation session, streamed to the right tools panel as MJPEG. It is loaded only when
  \`LIVE_BROWSER_ENABLED=true\` and reuses the browser install the E2E suite
  already manages; hand-rolling a CDP transport is precisely the thing not to
  do. Navigation, subresources and WebSockets pass \`server/browser/policy.ts\`,
  which blocks loopback/private/link-local ranges, \`file://\` and downloads;
  service workers/speculative connections are disabled and the persistent
  credential profile must be private to the host user. Without those controls
  the panel could reach the unauthenticated OpenCode server on 127.0.0.1.
- \`qrcode-generator@2.0.4\` is the sole QR runtime dependency: it creates the
  phone-transfer matrix entirely in the browser, avoiding URL disclosure to an
  external image service. The app reads its matrix API and renders a React SVG
  path rather than injecting the package's generated markup.
- \`react-markdown\` + \`remark-gfm\` render agent prose. \`client/ds/markdown.tsx\` used to
  be a regex chain producing an HTML string for \`dangerouslySetInnerHTML\`, and its own
  header comment named these two packages as the replacement once the surface grew.
  Issue #140 grew it: a verified \`scripts/launchd.ts:222\` has to become a real button,
  and injecting controls by pattern-matching generated HTML is how a rendering bug
  becomes an injection bug. Rendering from parsed nodes also *removes*
  \`dangerouslySetInnerHTML\` from this path entirely. Consequences worth stating: raw
  HTML in the source is dropped rather than rendered (no \`rehype-raw\`, deliberately),
  \`untrusted\` still entity-escapes first so that markup survives as visible text,
  markdown images render their alt text instead of an \`<img>\` — an agent-chosen \`src\`
  is an SSRF and tracking-pixel surface — and a ~15-line local remark plugin restores
  single-newline hard breaks rather than adding \`remark-breaks\` for that alone.
- CodeMirror 6 (\`@codemirror/{state,view,language,search}\` plus the
  \`lang-{javascript,json,css,html,markdown,python}\` grammars) is the read-only file
  viewer, loaded through \`React.lazy\` so a reader who never opens a file never
  downloads a parser — it is a ~550 kB chunk that stays out of the main bundle. It was
  chosen over Monaco, which does not support mobile browsers, and over embedding
  OpenVSCode Server, Theia or the OpenCode UI, which would each add a second process,
  a second security surface and a competing notion of workspace state. Read-only is
  enforced twice, by \`EditorState.readOnly\` and \`EditorView.editable\`, because this
  surface must never imply the reader can save. The grammar list is short on purpose:
  every grammar is bytes in that chunk, and an unknown extension renders as plain text
  rather than being guessed at. \`@lezer/highlight\` is a direct dependency because the
  viewer maps grammar roles onto app-owned semantic syntax tokens; CodeMirror's fixed
  default palette contains low-contrast primary blue and purple on this app's dark
  surface. Both light and dark token sets must keep every syntax foreground at WCAG AA
  text contrast against the editor surface.
- The transcript renderer consumes a backend-neutral \`TranscriptEvent\`. Row components
  must never touch raw OpenCode \`Part\` shapes — that mapping lives in exactly one place
  (\`client/lib/events.ts\`), which is what made this migration a ~363-line adapter
  rewrite instead of a full rebuild. **Keep that seam.**

## Automated PR screenshots

Absent a request block, changed files select curated scenarios automatically.
An explicit block overrides selection; \`scenario:hub-projects\` and other IDs from
\`scripts/review-scenarios.ts\` capture interactive element states alongside routes.
The trusted publisher resolves IDs against main's catalogue, never artifact code.
Unknown/shared changes get baseline screenshots and a local-review notice. See
\`docs/engineering-design/playwright-review.md\` for the local light/dark gallery,
Contents API publishing, author overrides and retention policy.

Request deterministic screenshots with one root-relative route per line in the PR body:

\`\`\`\`md
\`\`\`screenshots
/?directory=/tmp/mock-project
full:/sessions/ses_mock_done?directory=/tmp/mock-project
\`\`\`
\`\`\`\`

Blank lines and lines beginning with \`#\` are ignored. Every route captures dark-mode
desktop (1280x800) and mobile (390x740) PNGs; \`full:\` captures the full page at both
widths. The sticky comment renders \`Route\`, \`Desktop\`, and \`Mobile\` columns. Requests are
limited to 10 known UI routes and reject whitespace, controls, schemes, hosts,
backslashes, malformed encoding, and path traversal.

**A capturable route and its wait target are one table.** \`SCREENSHOT_ROUTES\` in
\`scripts/pr-screenshots.ts\` pairs each allowlisted pattern with the testid that proves
its page rendered, and both the validator and the capture spec read it. They used to be
an allowlist here and a ternary chain in the spec, and the pair drifted twice — \`/dsh\`
(#253) and then \`/claude\` were allowlisted while the spec still fell through to a default
\`opencode-hub\`. That failure mode is expensive to read: the route validates, then the run
burns a full Playwright visibility timeout on a testid the page never renders, which
looks like a flaky capture rather than a missing map entry. So there is no default arm;
\`screenshotStableRoot()\` returns \`null\` and validation rejects the route at parse time.
Patterns must stay anchored and mutually exclusive, because an overlap would let an
earlier entry shadow a later route's stable root and reintroduce the wrong wait — a
route whose testid differs per depth needs one pattern per depth (\`/docs\` vs \`/docs/:slug\`),
not one pattern with an optional tail.

**A PR that adds a route to that table cannot screenshot the new route in its own body.**
Capture runs the PR's code, so the shot is taken and the artifact is valid; the publisher
deliberately runs the *default branch's* validator against the untrusted manifest, and
\`main\` does not know the route yet, so publication fails with \`is not a known UI route\`.
That asymmetry is the fork-safety boundary working as intended — the publisher must never
trust validation logic supplied by the branch it is publishing — so the fix is to request
the route in a follow-up PR after the table lands, never to relax the publisher.

The read-only \`pull_request\` workflow runs the production SPA and BFF against only the
fixed Playwright OpenCode and forge mocks. A separate default-branch \`workflow_run\`
publisher treats the artifact as untrusted, validates its manifest and PNGs, writes only
\`gh-pages:pr-screenshots/pr-<number>/\`, and maintains one \`<!-- pr-screenshots -->\`
comment with public raw links and an artifact fallback. The close workflow uses
\`pull_request_target\` only for trusted GitHub API cleanup; it never checks out or runs PR
code. The publisher also requires the PR head repository to equal this repository and
binds the artifact to the workflow run SHA. Fork artifacts may be linked but their bytes
are never published. Never combine write permissions with execution of a fork checkout.

Fork capture is safe but may require a maintainer to approve the read-only Actions run.
If Actions are unavailable, capture locally and attach images manually. Local capture:

\`\`\`bash
npm run screenshots:local
\`\`\`

Output is written to the ignored \`screenshot-output/\` directory.
`;export{e as default};
