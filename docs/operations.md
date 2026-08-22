# Operations: updating the supervised BFF

This guide covers one routine task on a machine where the app runs as a macOS
LaunchAgent: pulling new code and restarting the BFF so the running service picks it
up.

[`deploy/README.md`](../deploy/README.md) covers first-time installation, Tailscale
Serve, and uninstall. This document assumes the service is already installed and
starts from the question "I pulled a change; how does the running process get it?"

## The two services

A fully set-up machine supervises two independent LaunchAgents. They are not
interchangeable, and only one of them is safe to restart casually.

| Label | What it is | Safe to restart? |
|---|---|---|
| `ai.custom-dca-opencode.bff` | This repository's Express BFF and built SPA | Yes |
| `ai.opencode.serve` | The upstream OpenCode agent runtime | **No — see below** |

The BFF is a client of the agent runtime. It holds the OpenCode credential, fans one
upstream SSE subscription out to browser clients, and serves the built SPA. It owns no
agent execution: prompts are submitted with the asynchronous prompt path and then run
entirely inside `opencode serve`. Restarting the BFF therefore does not touch a running
agent turn.

### Do not restart the agent runtime

**Restarting `ai.opencode.serve` silently kills every in-flight agent run, and nothing
resumes them.**

OpenCode never persists "running" state — this is decision 5 in
[`AGENTS.md`](../AGENTS.md). The session table has no status column, and
`/api/session/active` is scoped to the owning process, so once that process dies there
is no record that a turn was mid-flight. The work already done is lost, any partial
edits stay on disk, and there is no auto-resume: this app deliberately does not
re-prompt, because replaying a turn can repeat destructive work.

What you get instead is detection. A session is flagged interrupted in the UI when it
is absent from `GET /session/status` **and** its last message is an assistant turn with
no completion time. The Resume action prefills the composer rather than sending
anything, so a human decides whether re-running is safe.

Nothing in this document requires restarting the agent runtime. Deploying a change to
this repository never does — the runtime is upstream software this repository does not
build. Restart it only deliberately, when you have confirmed no session is running, and
after upgrading OpenCode itself.

## Confirm what is supervised

Every command in this section is read-only. Run them before anything else, because they
tell you which checkout the service actually runs from — which matters in a repository
that is normally worked in through Git worktrees.

```bash
launchctl list | grep -i opencode
launchctl print "gui/$UID/ai.custom-dca-opencode.bff"
```

`launchctl print` reports the facts the rest of this document depends on:

- `arguments` — the built entrypoint, `<repoRoot>/dist/server/index.js`.
- `working directory` — the supervised checkout. **Pull there**, not in a worktree.
- `environment` → `PORT` — the listening port, `3210` unless installed with
  `--port=`.
- `stdout path` / `stderr path` — `<repoRoot>/.state/logs/bff.launchd.{out,err}.log`.
- `properties` — includes `runatload` and `keepalive`, so the job starts at login and
  launchd restarts it if it exits.

`npm run service:status` prints the same `launchctl print` output plus the two log
paths, and exits non-zero when the job is not loaded.

## Update and restart

Run this in the supervised checkout reported above:

```bash
cd <repoRoot>
git pull
npm ci
npm run build
launchctl kickstart -k "gui/$UID/ai.custom-dca-opencode.bff"
```

Each step is load-bearing:

- **`git pull`** updates the sources only. The service does not run them.
- **`npm ci`** installs exactly the lockfile. Use it rather than `npm install` so a
  dependency change in the pull is applied and nothing else drifts; this is also what
  CI runs.
- **`npm run build`** is the step that actually matters. The plist runs
  `dist/server/index.js`, and that file serves the SPA from its sibling `dist/client`.
  Pulling without building changes nothing about the running app, and restarting
  without building just restarts the old code. Both halves are needed: `npm run build`
  runs `build:ui` and then `build:server`.
- **`launchctl kickstart -k`** stops the current process and starts a fresh one from
  the same plist. The `-k` flag is what makes it a restart rather than a no-op against
  an already-running job.

`scripts/launchd.ts` has no restart command. It exposes `install`, `status`, `logs`,
and `uninstall` (as the `service:*` npm scripts), so `launchctl kickstart -k` is
currently the way to restart in place.

### When to reinstall instead

`npm run service:install` is idempotent and does rebuild, so it also produces a running
process on new code. Prefer it only when the plist contents themselves are stale —
after moving the checkout, changing the supervised port, or switching Node versions,
since the plist hardcodes the absolute `node` path and repository root.

Note that `install` defaults back to port `3210`. If the service was installed on
another port, pass it again — `npm run service:install -- --port=3211` — or the service
silently moves.

## Verify

```bash
npm run service:status
curl -s "http://127.0.0.1:3210/api/health"
```

Adjust the port if the service was installed on a different one.

`service:status` should report `state = running` with a fresh `pid`, and an incremented
`runs` count relative to before the restart. `/api/health` needs no credentials and
answers three separate questions at once:

```json
{"healthy":true,
 "upstream":{"url":"...","reachable":true,"version":"1.18.21","versionMatches":true},
 "events":{"connected":true}}
```

- `healthy` — this BFF is up.
- `upstream.reachable` and `versionMatches` — the agent runtime named by `OPENCODE_URL`
  answered, at the version this build expects. Skew is reported rather than hidden,
  because it is the first thing to suspect when a response shape looks wrong.
- `events.connected` — the single upstream SSE subscription re-established. A restart
  that leaves this `false` means the BFF is serving pages but will not receive live
  updates.

Confirm the listener directly, and follow the logs if anything looks wrong:

```bash
/usr/sbin/lsof -nP -iTCP:3210 -sTCP:LISTEN
npm run service:logs
```

`service:logs` tails the last 100 lines of both the stdout and stderr files and keeps
following; interrupt it with Ctrl-C. A healthy start logs
`[bff] listening on :3210 -> opencode <url>`.

## What a restart costs

A restart is cheap but not free.

**Live SSE connections drop.** Every connected browser loses the stream and reconnects
on a capped 2s/4s/8s/16s/30s backoff. The stream is only a nudge channel — it carries no
transcript content — and each session view also runs a 3s poll that is the durable
source of truth, so the UI keeps updating during the gap rather than freezing. Classic
SSE has no replay cursor, so clients refetch state on reconnect instead of replaying
missed events; that refetch is what closes the gap.

**Agent turns are unaffected.** They run inside `ai.opencode.serve`, which the restart
does not touch.

**Anything the BFF held in memory is gone.** Most of that is rebuilt transparently. The
exception worth planning around is the auto-permissions toggle: it is deliberately
volatile and directory-scoped, kept in memory only, and off after every restart
(decision 11 in [`AGENTS.md`](../AGENTS.md)). If an agent asks for a permission during
or after the restart, nobody answers it automatically and the session parks. Re-enable
the toggle per project after restarting, or restart when nothing is running.

## What survives a restart

Persisted BFF state lives in `.state/` under the supervised checkout. That location is
not configurable by accident: the paths resolve from the process working directory, and
the plist sets `WorkingDirectory` to the repository root.

| File | Contents |
|---|---|
| `.state/notification-history.json` | Notification records and their resolved state |
| `.state/notification-prefs.json` | Server-backed notification preferences |
| `.state/project-pins.json` | Pinned projects |
| `.state/model-pins.json` | Pinned models |

Each is written atomically after every change — a temporary file followed by a rename —
so a restart cannot leave a half-written file behind. Each has an environment override
(`NOTIFICATION_HISTORY_FILE`, `NOTIFICATION_PREFS_FILE`, `PROJECT_PINS_FILE`,
`MODEL_PINS_FILE`); if you set one, that path is what needs preserving, not `.state/`.

`.state/` is gitignored, so `git pull` never touches it. Sessions, messages, and todos
are not BFF state at all — they belong to OpenCode and are unaffected.

Device-local settings, including the selected project, theme, and notification sound
and speech preferences, live in the browser's `localStorage` and are likewise
unaffected.

## Troubleshooting

**The service is not loaded.** `npm run service:status` prints
`ai.custom-dca-opencode.bff is not loaded.` and exits non-zero. `kickstart` cannot
start a job that is not bootstrapped; install it with `npm run service:install`. See
[`deploy/README.md`](../deploy/README.md) for the prerequisites, including a mode-0600
`.env`.

**The port is already bound.** `npm run service:install` refuses to install when
something already listens on the target port. Find the holder before assuming it is a
stale copy:

```bash
/usr/sbin/lsof -nP -iTCP:3210 -sTCP:LISTEN
```

The usual causes are the supervised job still running (expected during a reinstall —
the installer boots it out first), a manual `npm start` in another terminal, or a
second checkout installed on the same port. Port `3000` is rejected outright because
`npm run dev` uses it.

**The build failed and `dist/` is stale.** `npm run build` is two steps: `build:ui`
empties and rewrites `dist/client`, then `build:server` compiles into `dist/server`.
A failure in the second step therefore leaves a new SPA beside an old server, which
restarting turns into confusing behavior rather than a clean error. `build:server` also
never removes stale output, so a deleted or renamed server module can linger from an
earlier build. Do not restart until the build succeeds. If the state is unclear, remove
`dist/` and rebuild:

```bash
rm -rf dist
npm run build
```

The running process keeps serving the previous build for as long as you do not restart
it, so there is no pressure to restart into a broken tree.

**The service restarts repeatedly.** `KeepAlive` is true, so a process that exits
immediately is restarted in a loop; `launchctl print` shows a climbing `runs` count.
Read `.state/logs/bff.launchd.err.log` — the common causes are a missing or misconfigured
`.env` and an unreachable `OPENCODE_URL`.

**The app loads but shows no live updates.** Check `events.connected` in
`/api/health`. If it is `false`, the BFF cannot subscribe to the upstream event stream;
verify the agent runtime is reachable rather than restarting the BFF again.
