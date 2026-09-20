# Deployment operations

The production deployment is deliberately split so app upgrades do not interrupt
agent turns:

```text
Phone or browser
      |
      v
Tailscale HTTPS
      |
      v
launchd: UI + BFF (:3210) ----> OpenCode (:4097)
      |                                |
      +-- rebuilt on app upgrade        +-- left running
```

The supervised unit is `ai.dcaleon.bff`. It serves the built SPA and
production BFF on port `3210` by default, with logs under `.state/logs/`. OpenCode
is a separate, long-lived process named by `OPENCODE_URL` in `.env`.

## Why the app is supervised

Production has one Node process for both the UI and BFF: Express serves the built
React files as well as `/api` routes. A browser refresh cannot replace that process's
already-loaded server code. It must be restarted after a new server build.

Something has to own that one process: start it, keep it alive if it exits, give
it a fixed working directory and environment, and write stable logs. Otherwise
the phone-accessible app is tied to an open terminal, `nohup`, or a background
process somebody maintains by hand.

Which supervisor does that follows the platform, decided by `chooseBackend()` in
`scripts/supervisor.ts`:

| Host | Supervisor | Unit | Restarts on crash | Restarts on host boot |
|---|---|---|---|---|
| macOS | launchd | `~/Library/LaunchAgents/ai.dcaleon.bff.plist` | `KeepAlive` | `RunAtLoad` |
| Linux | tmux | detached session `ai-dcaleon-bff` | `while true` loop, 5s delay | **No** |

**Why tmux and not systemd on Linux.** The Linux host is a Coder workspace: a
single Kubernetes pod with `restart_policy = "Never"`, no init system the
workspace user can bootstrap into, and therefore no `systemd --user` to install
a unit with. A detached tmux session survives the SSH connection that created
it, and it is already how that workspace image supervises its own agent.

The honest gap is the last column. On macOS launchd brings the BFF back after a
reboot; on Linux a stopped pod comes back with no tmux sessions and nothing
restarts dcaleon. Rerun `npm run service:install -- --port=3210` after a pod
restart. `service:status` exits non-zero when the session is gone, so it is a
usable liveness check.

`--force-active-claude` has no counterpart on the tmux backend: it does not poll
for running Claude sessions before replacing the process. Passing it there warns
and continues rather than pretending to honour it.

## What changes during an app upgrade

`npm run service:install -- --port=3210` has this lifecycle:

```text
existing BFF keeps serving :3210
          |
          +--> build UI assets into dist/client
          +--> compile BFF into dist/server
          |
          v
launchd stops the old BFF and starts the new BFF
          |
          +--> browser reconnects briefly
          +--> Tailscale retries the same :3210 target
          +--> OpenCode continues its active turns
```

| Component | During `service:install` |
|---|---|
| Built UI and BFF | Rebuilt, then served by the new BFF process. |
| LaunchAgent | Replaced and restarted for `ai.dcaleon.bff` only. |
| Browser or phone | May briefly reconnect while `:3210` has no BFF listener. |
| Tailscale Serve | Stays configured and continues proxying to `:3210` after the BFF returns. |
| OpenCode | Not started, stopped, or restarted. Active agent turns continue. |
| Claude Island | The install refuses to replace the BFF while a Claude turn is active. Wait for it to finish, or pass `--force-active-claude` to interrupt it explicitly. |

## Upgrade after GitHub changes

Run these commands from the repository root:

```bash
git pull --ff-only
npm ci
npm run service:install -- --port=3210
```

`service:install` rebuilds the SPA and BFF, replaces the matching LaunchAgent, and
starts the new BFF process. A connected browser briefly reconnects. OpenCode is not
restarted, so active OpenCode turns continue. Claude turns are BFF child processes;
the installer checks them immediately before replacement and refuses while any are
active. `--force-active-claude` is the explicit escape hatch when interruption is
intentional. The check also fails closed when the running BFF cannot report Claude
status; use the same flag when replacing a known-wedged or pre-Claude deployment.

> `npm ci` is separate from `service:install`. Run it after a pull when the lockfile
> may have changed; the installer builds with the dependencies already on disk.

### Verify the upgrade

```bash
curl --fail http://127.0.0.1:3210/api/health
npm run service:status
tailscale serve status
```

When Tailscale Serve is configured, also load the HTTPS origin shown by
`tailscale serve status`. A successful `/api/health` response reports whether the
BFF can reach OpenCode and whether their expected versions match.

> Do not restart OpenCode during an active turn. An OpenCode restart interrupts
> that turn; its session history remains, but the turn is not resumed automatically.

## Failure modes and recovery

`launchd` makes the BFF recoverable, not infallible. These outcomes determine
whether the phone-accessible app is temporarily unavailable:

| Failure point | What remains available | Recovery |
|---|---|---|
| UI or BFF build fails | The existing BFF remains serving because the installer builds before replacing the supervised unit. | Fix the build error, then rerun the upgrade commands. |
| Replacing the unit fails after the old BFF stops | The app can be down because no BFF is listening on `:3210`. OpenCode remains running. | Run `npm run service:status` and `npm run service:logs`, fix the reported issue, then rerun `npm run service:install -- --port=3210`. |
| The new BFF exits after launch | The app is down until the service can stay running. Both supervisors retry — launchd via `KeepAlive`, tmux via the restart loop. | Inspect `npm run service:logs`; common causes are invalid `.env` values, a missing dependency, or an upstream configuration problem. |
| The Linux pod is stopped and started | Nothing. The tmux session is gone with the pod, and no dcaleon process exists. | Rerun `npm run service:install -- --port=3210`. This is expected, not a fault. |
| Tailscale or its Serve configuration is unavailable (macOS) | The local BFF can still be healthy, but the phone HTTPS origin is unreachable. | Check `tailscale status` and `tailscale serve status`, then bring Tailscale up or recreate the Serve route if needed. |
| The Coder workspace is stopped (Linux) | Nothing is reachable; the port URL 404s. | Start the workspace, then rerun `service:install`. |

Start diagnosis from the inside out: BFF health, supervisor state and logs, then
whatever fronts it. Do not restart OpenCode merely to recover the UI/BFF.

## First-time setup

```bash
cp .env.example .env
chmod 600 .env
npm ci
npm run service:install -- --port=3210
```

Use `npm run service:install -- --port=3211` to choose another supervised port.
Port `3000` is rejected because `npm run dev` uses it by default. Installation is
idempotent on both hosts: it rebuilds the app, then replaces exactly one thing —
on macOS `~/Library/LaunchAgents/ai.dcaleon.bff.plist`, bootstrapping only the
matching `gui/$UID/ai.dcaleon.bff` job; on Linux the `ai-dcaleon-bff` tmux
session, killed and recreated. Uninstall does not use `pkill`, does not touch
OpenCode, and preserves logs under `.state/logs/` either way.

On a Coder workspace, do not supervise on port `3000` or `1370`. Both are
declared `share = "public"` by named `coder_app` entries in the workspace
template, which means no authentication at all in front of them. Any other port
is owner-private.

## Operations checklist

- Check service state: `npm run service:status`
- Follow BFF logs: `npm run service:logs`
- Remove the BFF service: `npm run service:uninstall`
- Keep `.env` mode `0600`; it contains credentials and is never copied to the plist.

Keep credentials such as `OPENCODE_SERVER_PASSWORD`, forge tokens, and notification
tokens in the repo-root `.env`, never in a plist. Keep that file mode `0600`.
`launchd` does not load `.zshrc`, `.zprofile`, or other shell profiles. The BFF still
loads `.env` with dotenv because its plist sets `WorkingDirectory` to the repository
root before starting `dist/server/index.js`.

## OpenCode connection

The BFF never starts OpenCode. It connects to the one server named by `OPENCODE_URL`
in `.env`. Verify that server first rather than starting another:

```bash
curl --fail --user "${OPENCODE_SERVER_USERNAME:-opencode}:$OPENCODE_SERVER_PASSWORD" \
  "$OPENCODE_URL/global/health"
```

## Remote access

Two shapes, depending on the host.

### Coder workspace (Linux)

Nothing to configure. Every listening port is reachable at an owner-private URL:

```
https://<port>--<agent>--<workspace>--<owner>.coder.cloud.hebbia.ai
```

so `:3210` on workspace `leon-experiment` owned by `leoncheng57` with the
default `main` agent is
`https://3210--main--leon-experiment--leoncheng57.coder.cloud.hebbia.ai`.
This needs no template change and no edit to the workspace's `coder_app`
entries. Set it as `PUBLIC_APP_URL` in `.env` so Web Push notifications address
the right origin, then rerun `service:install`.

Do not change an app's sharing to `authenticated` or `public` to make this
easier. `public` means unauthenticated, and the Claude island runs with the
Unix user's full authority and no OS-level write boundary.

Reaching the pod directly over the tailnet does **not** work: workspace pods do
not appear in a personal device's netmap, whatever the workspace's own
`tailscale status` reports.

### Tailscale Serve (macOS)

Proxy the dedicated supervised port and inspect the resulting Serve configuration:

```bash
tailscale serve --bg http://127.0.0.1:3210
tailscale serve status
```

Set `PUBLIC_APP_URL` in `.env` to the HTTPS origin shown by Tailscale, then rerun
`npm run service:install -- --port=3210` so the BFF reads the new value.

Tailscale is not restarted by an app upgrade. Its Serve configuration keeps the same
local destination, so the only interruption is the short period while the supervisor
replaces the BFF. A request in that window can receive a transient connection error or `502`;
reload after the BFF health check succeeds. Run `tailscale up` or recreate Serve only
if Tailscale itself stopped or its Serve configuration was removed.

## Optional OpenCode Unit

`ai.opencode.serve.plist` remains a manual template for users who do not already
supervise OpenCode. Do not install it when `OPENCODE_URL/global/health` is already
reachable, and never overwrite an installed plist automatically.

The template invokes the OpenCode binary directly. It never relies on `node`,
`/usr/bin/env`, nvm, or shell-profile PATH setup. It also deliberately does not load
`.env` and contains no password: use it only for an unsecured server bound to
`127.0.0.1`. If OpenCode requires authentication, keep it under its existing
supervisor and put only the matching URL and credentials in the BFF's mode-0600
`.env`.

Before first use, make a working copy and replace every `REPLACE_WITH_*` value:

- `REPLACE_WITH_ABSOLUTE_OPENCODE_BINARY`: the absolute result of `command -v opencode`
- `REPLACE_WITH_OPENCODE_PORT`: the port from `OPENCODE_URL` in `.env`
- `REPLACE_WITH_HOME_DIRECTORY`: the absolute home directory
- `REPLACE_WITH_LAUNCHD_PATH`: an explicit PATH containing tools agents may invoke
- `REPLACE_WITH_LOG_DIRECTORY`: an existing absolute log directory

Paths containing spaces are valid plist strings and must not be shell-escaped. Escape
XML-sensitive characters if a path contains them. Validate that no placeholder remains
before installing under the distinct label:

```bash
cp deploy/ai.opencode.serve.plist /tmp/ai.opencode.serve.plist
# Edit /tmp/ai.opencode.serve.plist, then:
! grep -q 'REPLACE_WITH_' /tmp/ai.opencode.serve.plist
plutil -lint /tmp/ai.opencode.serve.plist
test ! -e ~/Library/LaunchAgents/ai.opencode.serve.plist
cp /tmp/ai.opencode.serve.plist ~/Library/LaunchAgents/ai.opencode.serve.plist
launchctl bootstrap "gui/$UID" ~/Library/LaunchAgents/ai.opencode.serve.plist
launchctl print "gui/$UID/ai.opencode.serve"
```

The jobs and logs are intentionally unambiguous: `ai.opencode.serve` uses
`opencode.launchd.*.log`; `ai.dcaleon.bff` uses `bff.launchd.*.log`.
