# Local deployment and restart

This is the short, reproducible runbook for updating the locally hosted dcaleon
application. For the full operational design, failure modes, Tailscale setup, and
first-time installation, see [`deploy/README.md`](deploy/README.md).

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

## Reproducible production update

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

## Diagnose a failed production restart

Check from the inside out:

```bash
curl --fail http://127.0.0.1:3210/api/health
npm run service:status
npm run service:logs
tailscale serve status
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

```bash
cp .env.example .env
chmod 600 .env
npm ci
npm run service:install -- --port=3210
```

Configure `.env` before installation, including the existing `OPENCODE_URL`. The
BFF connects to that long-lived OpenCode process; it never creates a second one.
