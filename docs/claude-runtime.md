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
- **Filesystem:** macOS Seatbelt is the write authority. Read-only presets get no
  workspace write; Build adds only the allowlisted workspace. Because `claude` reads its
  credential from the Keychain, the profile keeps HOME real and grants Keychain read — so
  Seatbelt confines workspace writes but does not isolate the credential store. The
  write-confinement is asserted on macOS in `tests/claude-seatbelt.test.ts`.
- **Build writes:** a Build preset uses `permissionMode: "bypassPermissions"`. Headless
  `claude` denies a write that no rule pre-approves, so the permission prompt cannot be the
  gate here — Seatbelt is. Verified against the real binary: a read-only session is denied
  a workspace write; a Build session writes, and only inside the workspace.
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
    the worktree. Seatbelt grants the worktree plus the project's `.git` (worktrees keep their
    metadata and objects in the shared `.git`; commits from inside the worktree write there).
    The project's own working tree is untouched until you **Merge**.
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

## Not in V1

Interactive tool approval (unavailable, not deferred), reading `claude`'s own JSONL as a
second durable transcript source, cross-project session listing parity, and native features
such as budget caps or `--json-schema` in the UI.
