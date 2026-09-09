# Claude Code local-binary runtime

**Status: experimental, off by default.** A third runtime beside OpenCode and DeepSeek
Harness that drives the unmodified local `claude` binary. It exists for one reason the
other two runtimes cannot serve: it can be driven by a Claude subscription seat, because
sign-in stays in the binary and this app never handles the credential.

This document is a point-in-time overview; `AGENTS.md` decision 34 and the code are the
source of truth.

## What it is

- `/claude` landing page and `/claude/sessions/:id` conversation, mirroring the DSH surface.
- A per-prompt supervisor that spawns `claude -p --output-format stream-json`, folds the
  stream into the frozen transcript contract, and streams changes to the browser.
- Read-only by default; a Build preset may edit files inside its allowlisted workspace only.

## Why it is shaped the way it is

Three measured facts, not assumptions, set the design (see `AGENTS.md` decision 34):

1. **No interactive approval exists** over `claude`'s headless stream-json — a blocked tool
   call arrives only as a terminal `system/permission_denied`. The lane is therefore
   non-interactive by construction. Presets select a non-interactive permission mode; a
   would-be `ask` maps to deny.
2. **`claude -p` is one-shot.** Each prompt is a fresh process (`--session-id` first,
   `--resume` after); cancel is SIGTERM. There is no long-lived bridge.
3. **The durable transcript is a file** (`~/.claude/projects/**/*.jsonl`), which is why the
   client keeps a poll rather than trusting the SSE nudge alone.

## Boundaries

- **Credential:** the BFF never reads or forwards the Claude credential. `claude`
  authenticates from its own macOS Keychain item; the supervisor env allowlist forwards no
  credential variable. Reading the credential to broker a token is precisely what
  Anthropic's policy prohibits for third-party tools, and precisely what this lane must
  never do. The allowlist does carry the user *identity* (`USER`/`LOGNAME`/
  `__CF_USER_TEXT_ENCODING`, synthesized when absent), because macOS resolves the login
  Keychain by user — without `$USER`, even an un-sandboxed `claude` reports "Not logged
  in". Identity is not a credential.
- **Filesystem: there is no OS-level boundary.** The `claude` binary is spawned directly,
  with no Seatbelt wrapper, so a session holds exactly the authority `claude` holds in a
  terminal. The generated settings file is the only confinement: a read-only preset denies
  `Write`/`Edit`/`MultiEdit`/`NotebookEdit` by name at the tool layer, and nothing behind
  that deny stops a `Bash` call from writing wherever the operator can. A session of either
  mode can also read every secret the user owns — SSH private keys, `~/.aws`, browser cookie
  stores — so a session's prompt should be treated as capable of both exfiltrating and
  overwriting host state. `SSH_AUTH_SOCK` is forwarded as host Git authority.
  The credential discipline above and `CLAUDE_APPROVALS` are the boundaries that remain.
- **Build writes:** a Build preset uses `permissionMode: "bypassPermissions"`. Headless
  `claude` denies a write that no rule pre-approves, so an ungated Build must name the
  mutation tools in its settings — and with no sandbox behind that, an ungated Build turn is
  as privileged as the operator. Set `CLAUDE_APPROVALS=true` to route each check to a human
  instead; that gate, not the filesystem, is what makes a Build turn reviewable.
- **Version:** `CLAUDE_CLI_VERSION` is pinned and re-asserted against the `system/init`
  frame; a mismatch fails the turn. The binary auto-updates and the wire format is
  undocumented, so drift must fail closed rather than mis-parse.

## Enabling it

See the `CLAUDE_*` block in `.env.example`. Enabling fails closed unless the CLI version is
pinned, the binary path is absolute, and every preset and workspace is server-allowlisted.

**Operator pre-flight (not enforceable in code):** confirm the machine's `claude` is signed
in to the intended subscription and that headless `claude -p` runs under it before enabling
the lane. Usage bills to that seat.

## Real sessions: projects, isolation, changes, durability

Beyond the read-only experiment, the lane runs real writable coding sessions:

- **Real projects.** In addition to the static allowlist, every git repository under
  `CLAUDE_PROJECTS_ROOT` (default `PROJECTS_DIR`) is offered as a workspace, discovered at
  request time via the same `discoverProjects` the rest of the app uses. Each still carries a
  dev/inode identity that is re-verified before every spawn.
- **Per-session isolation, chosen when a Build session starts.**
  - *Isolated worktree*: `git worktree add` on a `claude/<uuid>` branch off the project's HEAD,
    placed under `CLAUDE_STATE_DIR/worktrees` — never inside the project. The session's cwd is
    the worktree (worktrees keep their metadata and objects in the shared `.git`; commits from
    inside the worktree write there, which needs no grant now that no sandbox is applied).
    The project's own working tree is untouched until you **Merge** — a convention the session
    is trusted to honour, not a boundary anything enforces.
  - *Direct*: edits land in the project's working tree immediately; you review with git.
- **Changes drawer.** `GET /claude/sessions/:id/changes` reads git each time (never cached):
  direct sessions diff the working tree against HEAD; worktree sessions diff against the
  branch's base commit so the agent's own commits count. Untracked files are included.
  Bounded (512 KiB, 500 files) and says so when truncated.
- **Merge / Discard** (worktree sessions). Merge refuses if the *project* has uncommitted
  changes of your own — a merge must never be confused with a human's in-progress edits — and
  refuses a branch with nothing to merge; uncommitted worktree changes are committed first so
  nothing the agent wrote is lost. Both remove the worktree and branch; the session is then
  finished (its cwd is gone).
- **Transcript footprint.** Tool rows name what they touched (file path, or the Bash
  command), and each turn ends with a **patch row** listing the files it edited.
- **Durability.** Sessions persist to `CLAUDE_SESSIONS_FILE` (metadata + bounded transcript,
  atomic writes) and reload on boot. A session that was mid-turn when the BFF stopped is marked
  *Interrupted by a server restart* rather than spinning forever. `--resume` still works because
  `claude` keeps its own JSONL.
- **Deploy protection.** `service:install` checks the running BFF immediately before
  replacement and refuses while any Claude turn is active. An operator must wait or pass
  `--force-active-claude`, making a destructive interruption explicit.

## Playbooks and notifications

The composer offers the same **Reminders** and **Workflows** pickers as an OpenCode session,
and a finished turn rings the same bell.

- **Reminders** are listed per session from `GET /claude/sessions/:id/reminders`, scoped
  server-side by the session's own cwd (`visibleReminders`), so a repository-scoped reminder
  appears only when this session's origin matches. A dedicated route rather than
  `/api/reminders?directory=` because a worktree session's cwd lives under the state dir —
  outside the roots the workspace-directory guard accepts — and because the browser must never
  name a path.
- **Sends carry ids only.** `POST /claude/sessions/:id/prompt` accepts `reminder` and
  `workflow`; the trusted bodies are resolved on the server and composed exactly as the
  OpenCode lane does (`server/claude/prompt.ts`: workflow injector first, reminder after). The
  binary sees the sentinel blocks; the transcript keeps the human's words plus the same
  *reminder attached* / *workflow attached* chips the OpenCode transcript renders.
- **Workflows** offered are the generic-argument ones. The five whose submit path is an
  OpenCode route (session update, managed child, start a DCA session, and the two review
  capture flows) are not shown. The Claude form (`claude-workflow-dialog.tsx`) previews the
  injector and only ever fills the composer; Send is the single mutation.
- **Notifications.** The store announces every way a turn ends (`finished`), and
  `server/claude/notifications.ts` translates that onto the OpenCode event bus the
  `NotificationService` already listens to: a `session.updated` that seeds the session as a
  titled root (so the service never asks the OpenCode server about a Claude id), then
  `session.idle` / `session.error` / the abort shape for a cancel. Titles and the excerpt come
  from the Claude store via the service's injectable lookups (`server/index.ts`); the click
  URL and the in-app row route to `/claude/sessions/<id>`.

## Transcript paging and performance

The conversation initially reads at most 50 events and 128 KiB of event data.
`GET /api/claude/sessions/:id` returns `events` and `page`: opaque `before`/`after`
navigation cursors, a `cursor` for `since` refreshes, total retained event count,
and boundary/order metadata. Use only one of `before`, `after`, or `since` per request.
An unchanged `since` response has no events. Revisions include tool completion updates,
even when their original row is older. A stale cursor or more than a page of changes
returns `page.reset: true` with a new tail, never an unbounded catch-up response.

The normal view holds 50 events; reading earlier holds at most 150 events and 384 KiB
of serialized event data. This bounds transcript data, not total browser heap. Rows
are measured and virtualized. Loading earlier preserves the visible row and evicts
newer data when necessary; Load newer and Jump to latest recover that data on demand.
Large fields are previewed at no more than 8,000 characters (less when needed to keep
an event within its byte budget), with an explicit shortened-preview notice. Original
text remains in the server store and is available through explicit export.

Search history replaces “Show all for browser search.” Search (`q`, at most 200
characters) and run log (`actions=true`, optional `category`) filter original retained
events on the server and return one bounded page at a time. File links resolve when
their page is read, including search results. Markdown, JSON, and command downloads
use the explicit `/export` read and release the full response after serialization;
they do not populate conversation state. “Complete history” means the existing
server store's retained events (normally the newest 1,000), not Claude's own CLI log.

Hidden tabs close their Claude SSE connection, stop polling, and abort outstanding
transcript requests. Becoming visible performs one bounded incremental catch-up;
SSE reconnect uses a bounded recovery read. Visible fallback polling remains 3s
while running and 30s while idle. The static public simulator has no SSE connection.

Diagnostics live on `claude-history-controls` (`data-total-events`, resident event/page
counts, refresh bytes and reconciliation milliseconds), and `claude-virtual-transcript`
(rendered row and actual list-commit counts). The real-BFF performance fixture owns its
store, temporary workspace and SSE endpoint, so simultaneous tests cannot reset it.

Run the ten-minute installed-Chrome acceptance lane with unused server ports:

```sh
CI=true PORT=3446 MOCK_OPENCODE_PORT=4646 MOCK_PREVIEW_PORT=4746 \
CLAUDE_PERF_CHROME=1 CLAUDE_PERF_SOAK_MS=600000 \
npm run test:e2e:host -- tests/e2e/claude-performance.ui.spec.ts --workers=1 --retries=0
```

Without those performance environment variables the same two-page test runs for 15s
in Playwright Chromium. Each page starts with 260 mixed events; one receives live SSE
updates. The JSON attachment records browser version and measured duration, with
thresholds of less than 500ms interaction latency, 200ms longest task, 150,000 bytes
per response, 16,000 bytes per incremental response, 50ms reconciliation, 30 rendered
rows, and three resident 50-event slots. These are reproducible fixture thresholds,
not a guarantee for arbitrary Chrome profiles, extensions, hardware, or tab counts.

## Not in V1

Interactive tool approval (unavailable, not deferred), reading `claude`'s own JSONL as a
second durable transcript source, cross-project session listing parity, and native features
such as budget caps or `--json-schema` in the UI.
