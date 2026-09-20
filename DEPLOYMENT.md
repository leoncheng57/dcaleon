# Deployment and restart

This is the short, reproducible runbook for updating a supervised dcaleon
deployment, on either supported host. For the full operational design, failure
modes, remote access, and first-time installation, see
[`deploy/README.md`](deploy/README.md).

## Two hosts, one runbook

Every command below is the same on both. `npm run service:*` and
`scripts/deploy.sh` dispatch on `process.platform` / `uname -s`, so the only
thing that changes is what is doing the supervising underneath.

| Host | Supervisor | What holds the process | Survives a host restart? |
|---|---|---|---|
| macOS | launchd | `ai.dcaleon.bff` LaunchAgent, `KeepAlive` | **Yes** — `RunAtLoad` brings it back |
| Linux | tmux | detached session `ai-dcaleon-bff` running a `while true` loop | **No** — rerun `service:install` |

The backend follows the platform and cannot be chosen with an environment
variable. This is the same rule the runtime islands follow: what a host *can*
do is a property of the host, not an operator preference.

The Linux target is a hosted workspace container: a restart policy that does
not bring the workload back, and no init system the workspace user can bootstrap
into, so systemd is not available to supervise with. A detached tmux session is
what such an image already uses for its own agent, and it outlives the SSH
connection that started it. The cost is stated plainly in the table: a stopped
workspace comes back with no sessions and nothing restarts dcaleon for you.

## Know which server you are using

dcaleon has two local startup modes. They are separate processes and normally use
different ports.

| Mode | Start command | Typical URL | Intended use |
|---|---|---|---|
| Development | `npm run dev` | Vite on `http://localhost:5173` (or the next free port, such as `5174`) | Editing with hot reload |
| Supervised production | `npm run service:install -- --port=3210` | `http://localhost:3210` | Stable, login-persistent local service |

The development URL is not evidence that the supervised production service was
updated, and updating the production service does not restart a development server.
The version label in the application navigation shows the commit baked into the
served client bundle.

### Port map

There are three independent layers, and seeing one port respond does not prove
that the others were restarted or updated:

| Process | Development default | Supervised/reference default | Restart owner |
|---|---:|---:|---|
| Vite React UI | `5173` (then `5174`, etc. if occupied) | Not used | Terminal running `npm run dev` |
| dcaleon Express BFF | `3000` | `3210` | Development terminal, the `ai.dcaleon.bff` LaunchAgent (macOS), or the `ai-dcaleon-bff` tmux session (Linux) |
| OpenCode server | `4096` unless `.env` says otherwise | Reference deployment may use `4097` | Separate OpenCode supervisor |

Claude has no listening port. A Claude-island turn is a `claude` CLI child process
launched and supervised by the dcaleon BFF. DSH (DeepSeek Harness) sessions use a
long-lived Python bridge process also spawned by the BFF. The browser always talks
to the BFF; it never connects directly to OpenCode, Claude, or DSH.

## Island independence during restarts

The three runtime islands have different relationships to the BFF process:

| Island | Relationship to BFF | Survives BFF restart? |
|---|---|---|
| OpenCode | Independent process (`ai.opencode.serve` LaunchAgent, macOS only) | **Yes** — separate process continues, BFF reconnects via SSE |
| Claude | Child process (`claude -p` spawned by BFF supervisor) | **No** — child killed on SIGTERM; session marked interrupted |
| DSH | Child process (Python bridge spawned by BFF) | **No** — child killed with parent; session marked interrupted |

**There is no way to restart one island without restarting the others** inside the
BFF. They share one Express process. An OpenCode restart is independent because it
is a separate LaunchAgent, but Claude and DSH always go down together with the BFF.

**There is no single-runner bottleneck in production.** In development, `npm run dev`
runs Vite and the BFF as two background jobs that start and stop together. In
production, Vite is not involved at runtime: the SPA is pre-built into `dist/client/`
and served as static files by Express. `service:install` builds once and starts a
plain Node process; no Vite process runs in the supervised deployment.

**No island can trigger a BFF restart.** There is no API route, agent tool, or code
path that allows a running session to restart the BFF. The only restart paths are:
external `service:install`, an external SIGTERM/SIGINT signal, or the supervisor
recovering from a crash — launchd's `KeepAlive` on macOS, the `while true` loop
on Linux.

On a Linux host the islands table usually has one live row. DSH cannot run there
at all (its bridge needs macOS Seatbelt), and OpenCode is normally left out of
`DCALEON_ISLANDS`, so a BFF restart takes down the Claude island and nothing
else. See AGENTS.md decision 36 for how a host reports that.

## Reproducible production update

```bash
npm run deploy                 # asks which port; Enter accepts 3210
npm run deploy -- --port=3211  # answer it up front instead
```

`scripts/deploy.sh` performs the whole sequence below, refuses a dirty checkout,
runs `npm ci` only when the update actually changes the dependency tree, and
polls `/api/health` afterwards so a bootstrap that loads but never serves is
reported as a failure instead of a success. It works from the repository root and
from a worktree; `--help` lists the options.

The supervised port is asked for rather than assumed, because deploying onto the
wrong one either collides with the running service or quietly starts a second
one beside it. `3210` is offered as the default and a bare Enter accepts it. A
rejected answer is asked again, three times, before the script gives up rather
than guess. Callers with no answer to give — cron, CI, anything piping stdin —
get the default; pass `--port` to be explicit there.

### The same update by hand

Run these commands from the repository root. Do not deploy from a checkout with
uncommitted changes: the build would include them even though they are not on the
selected Git commit.

```bash
git status --short
git switch main
git pull --ff-only
npm ci
npm run service:install -- --port=3210
```

Expected result:

1. `git status --short` prints nothing.
2. `git pull --ff-only` updates `main` without creating a merge commit.
3. `npm ci` installs exactly the dependency versions in `package-lock.json`.
4. `service:install` builds the SPA and BFF before replacing and restarting only
   the `ai.dcaleon.bff` LaunchAgent.

The last command is idempotent. It does not start, stop, or restart OpenCode, so
active OpenCode turns continue during an application update.

If the checkout is dirty, preserve that work first. Commit it on its own branch or
use a separate clean worktree; do not stash, discard, or deploy it accidentally.

### The by-hand sequence fails silently in a worktree

Git allows a branch in only one worktree at a time, so `git switch main` aborts
with `fatal: 'main' is already checked out at ...` whenever another worktree holds
it. Pasting the block as a whole is what makes this dangerous: the two `git`
commands fail, then `npm ci` and `service:install` succeed anyway and deploy
whichever commit was already on disk. The deploy looks like it worked, and the
version label shows a commit nobody selected.

Deploy the ref detached rather than switching to the branch:

```bash
git fetch origin
git checkout --detach origin/main
```

`npm run deploy` does this unconditionally, and names the worktree holding the
branch when there is one. Confirm which worktree holds what with
`git worktree list`.

### Do not run `npm ci` while the BFF serves from the same checkout

`npm ci` deletes `node_modules` before reinstalling. If the supervised BFF is
running from that directory, its already-loaded `require()` and dynamic `import()`
calls resolve into a directory that no longer exists, causing missing-module crashes
or silent freezes. This is the most common deployment mistake; it was rediscovered
in a live Codex debugging session.

**If deploying from the checkout the BFF currently serves**, stop the BFF first:

```bash
launchctl bootout gui/$(id -u)/ai.dcaleon.bff
# Wait for the port to release
for attempt in 1 2 3 4 5; do
  lsof -nP -iTCP:3210 -sTCP:LISTEN >/dev/null 2>&1 || break
  sleep 1
done
npm ci
npm run service:install -- --port=3210
```

This is **not** needed when `service:install` is the only command that touches
`node_modules`, because it builds first and replaces the LaunchAgent afterward. The
trap fires when `npm ci` is run as a separate manual step before `service:install`
in the same checkout the BFF is serving.

A separate deployment worktree avoids the problem entirely because the BFF never
serves from it until `service:install` switches the LaunchAgent.

### When the normal checkout contains work in progress

`service:install` builds whatever is on disk, including uncommitted files. Do not
run it from a dirty feature branch just because the desired change has already
merged into GitHub. Either finish and commit that work first, or maintain a clean
deployment worktree:

```bash
git fetch origin main
git worktree add ../dcaleon-deploy origin/main
cd ../dcaleon-deploy
npm ci
npm run service:install -- --port=3210
```

For later updates in that deployment worktree:

```bash
cd ../dcaleon-deploy
git fetch origin main
git checkout --detach origin/main
npm ci
npm run service:install -- --port=3210
```

The detached checkout is deliberate: it makes the deployed commit exactly equal to
`origin/main` without moving, merging, stashing, or overwriting the development
checkout. `git status --short` should still print nothing before every deployment.

## Verify the production update

```bash
curl --fail http://127.0.0.1:3210/api/health
npm run service:status
git rev-parse --short HEAD
```

Then open `http://localhost:3210` and compare the commit suffix in the application
version label with `git rev-parse --short HEAD`. Refresh the page if an older client
bundle remains open in the tab.

If Tailscale Serve fronts the application, also run:

```bash
tailscale serve status
```

Load the HTTPS origin reported there only after the direct `127.0.0.1:3210` health
check succeeds.

## Restart the development server

The Vite development server is terminal-owned rather than launchd-owned. In the
terminal running `npm run dev`, press `Ctrl-C`, then start it again from the desired
checkout:

```bash
git status --short
npm run dev
```

Vite requests port `5173` and automatically selects a later free port when it is
occupied. Use the exact UI URL printed by the command. The BFF development port is
`3000` unless `PORT` is set.

To update the development instance after `main` changes, stop the existing
`npm run dev` with `Ctrl-C`, then run:

```bash
git status --short
git switch main
git pull --ff-only
npm ci
npm run dev
```

If `git status --short` is not empty, preserve those changes on their own branch or
start the updated development server from a clean worktree. Do not force-switch or
discard files merely to update the server.

`npm run dev` owns both Vite and the development BFF. Stopping it therefore stops
both `5173`/`5174` and `3000`, but it does not stop the separate OpenCode server.

## What each restart interrupts

| Action | UI/BFF impact | OpenCode-island turns | Claude-island turns | DSH-island turns |
|---|---|---|---|---|
| Restart Vite only | Browser UI reconnects | Continue | Continue while the BFF remains alive | Continue while the BFF remains alive |
| Stop/restart `npm run dev` | Development UI and BFF stop | Continue in the separate OpenCode process | BFF supervision is interrupted; session marked interrupted on reload | Bridge killed; session marked interrupted on reload |
| Run `service:install` | Production UI and BFF briefly restart | Continue in the separate OpenCode process | Installer refuses while active; `--force-active-claude` interrupts explicitly | Active bridge killed; session marked interrupted |
| Restart OpenCode | No UI rebuild | Active turns are interrupted and are not automatically replayed | No direct effect while the BFF remains alive | No direct effect while the BFF remains alive |

OpenCode owns its turns after the BFF submits them asynchronously, so a dcaleon BFF
restart can reconnect and refetch their state. Claude and DSH turns instead run as
child processes owned by the BFF. Their transcripts and session IDs remain durable
(persisted to `.state/` with mode `0600`), but an interrupted turn is not silently
replayed; resume it explicitly after the BFF returns.

Before a planned BFF deployment, let active Claude and DSH turns finish or cancel
them deliberately. The installer checks for active Claude sessions and refuses when
any are running (there is no equivalent safety gate for DSH). There is no reason to
restart OpenCode as part of a dcaleon application upgrade.

## Durability on a headless host

Three things go wrong quietly when nobody is sitting in front of the box.

**Credentials.** `/api/health` reports `claude.credentials` as one of `ok`,
`stale`, `missing` or `unchecked`. Only `missing` is a problem:

| State | Meaning | Action |
|---|---|---|
| `ok` | The store is readable and the access token has not lapsed. | None. |
| `stale` | Readable, but `expiresAt` has passed. | **None.** Normal on an idle host — the CLI refreshes lazily, when a turn next needs it. |
| `missing` | Unreadable, unparseable, or no access token. | Every turn will fail. Run `claude` on the host and sign in. |
| `unchecked` | The Claude island is unavailable here. | None. |

Do not alert on expiry itself. The access token lives about eight hours, so any
threshold measured in days is tripped permanently, and a lapsed `expiresAt` on a
quiet box means only that nothing has asked for a token yet. The BFF pushes a
Web Push notification when the state *enters* `missing`, and again when it
recovers — once per transition, not once per probe, so a box that stays broken
does not push hourly until you mute it. Without VAPID keys or a subscribed
device the alert still reaches the log.

**Logs.** The Linux supervisor rotates `.state/logs/bff.tmux.log` past 32 MiB,
keeping one previous generation, between runs of the server rather than on a
timer. That is forced, not lazy: `tee -a` holds the file open, so renaming it
mid-run leaves tee writing to the moved inode and truncating it leaves tee
appending at its old offset. The only safe moment is when no tee owns the file —
each loop iteration, and every `service:install`. A crash loop therefore rotates;
a healthy process that never exits does not, so the practical bound is one
deploy's worth of logs.

**State.** Everything durable lives under the home volume, which on a hosted
workspace is the persistent volume that survives a stop/start: `.state/` in the
checkout for sessions, history and push subscriptions, and `CLAUDE_STATE_DIR`
for Claude's own worktrees and ledger. Nothing durable belongs in `/tmp`, which
does not survive the container. Platforms also reap workspaces left stopped long
enough, deleting the volume with them — that is the one loss no amount of care
inside the box prevents.

## Diagnose a failed production restart

Check from the inside out. The first three are identical on both hosts:

```bash
curl --fail http://127.0.0.1:3210/api/health
npm run service:status
npm run service:logs
```

Then, for the layer in front of it — `tailscale serve status` on macOS, or on a
hosted workspace, open the owner-private port URL the platform publishes for
`:3210`.

When `service:status` reports nothing on Linux, the usual cause is a workspace
that was stopped and started again: tmux sessions do not survive it. Rerun
`service:install`. To watch the process directly rather than through the log:

```bash
tmux attach -t ai-dcaleon-bff
```

- If the build fails, the installer leaves the existing BFF serving the previous
  build. Fix the build error and rerun `service:install`.
- If no process is listening, inspect `service:status` and `service:logs`, then rerun
  `service:install` after correcting the reported problem.
- If localhost works but the private HTTPS URL does not, diagnose Tailscale rather
  than restarting dcaleon or OpenCode.
- Do not restart OpenCode to repair the UI or BFF. A restart interrupts active turns,
  and they are not resumed automatically.

## First-time supervised installation

Identical on both hosts:

```bash
cp .env.example .env
chmod 600 .env
npm ci
npm run service:install -- --port=3210
```

Configure `.env` before installation. On macOS that includes the existing
`OPENCODE_URL`: the BFF connects to that long-lived OpenCode process and never
creates a second one.

On Linux there is usually no OpenCode server to point at, so set
`DCALEON_ISLANDS=claude` instead. The BFF then starts without an event bus and
answers every OpenCode route with a 503 that names the reason, rather than
failing connections at an upstream that was never there. Claude needs
`CLAUDE_RUNTIME_ENABLED=true`, an absolute `CLAUDE_BINARY`, and an exact
`CLAUDE_CLI_VERSION`; its credentials are read from
`~/.claude/.credentials.json` — written by running `claude` and signing in on
that host once. Do not set `CLAUDE_CODE_OAUTH_TOKEN`: the supervisor's
`SAFE_ENV` allowlist strips it, by design.
