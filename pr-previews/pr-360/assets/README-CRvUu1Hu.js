const e=`# Deployment operations

The production deployment is deliberately split so app upgrades do not interrupt
agent turns:

\`\`\`text
Phone or browser
      |
      v
Tailscale HTTPS
      |
      v
launchd: UI + BFF (:3210) ----> OpenCode (:4097)
      |                                |
      +-- rebuilt on app upgrade        +-- left running
\`\`\`

The supervised unit is \`ai.custom-dca-opencode.bff\`. It serves the built SPA and
production BFF on port \`3210\` by default, with logs under \`.state/logs/\`. OpenCode
is a separate, long-lived process named by \`OPENCODE_URL\` in \`.env\`.

## Why launchd supervises the app

Production has one Node process for both the UI and BFF: Express serves the built
React files as well as \`/api\` routes. A browser refresh cannot replace that process's
already-loaded server code. It must be restarted after a new server build.

\`launchd\` is the supervisor for that one process. It starts the BFF after login,
keeps it alive if it exits, gives it a fixed working directory and environment, and
writes stable logs. This avoids tying the phone-accessible app to an open terminal,
\`nohup\`, or a manually maintained background process.

## What changes during an app upgrade

\`npm run service:install -- --port=3210\` has this lifecycle:

\`\`\`text
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
\`\`\`

| Component | During \`service:install\` |
|---|---|
| Built UI and BFF | Rebuilt, then served by the new BFF process. |
| LaunchAgent | Replaced and restarted for \`ai.custom-dca-opencode.bff\` only. |
| Browser or phone | May briefly reconnect while \`:3210\` has no BFF listener. |
| Tailscale Serve | Stays configured and continues proxying to \`:3210\` after the BFF returns. |
| OpenCode | Not started, stopped, or restarted. Active agent turns continue. |

## Upgrade after GitHub changes

Run these commands from the repository root:

\`\`\`bash
git pull --ff-only
npm ci
npm run service:install -- --port=3210
\`\`\`

\`service:install\` rebuilds the SPA and BFF, replaces the matching LaunchAgent, and
starts the new BFF process. A connected browser briefly reconnects. OpenCode is not
restarted, so active agent turns continue.

> \`npm ci\` is separate from \`service:install\`. Run it after a pull when the lockfile
> may have changed; the installer builds with the dependencies already on disk.

### Verify the upgrade

\`\`\`bash
curl --fail http://127.0.0.1:3210/api/health
npm run service:status
tailscale serve status
\`\`\`

When Tailscale Serve is configured, also load the HTTPS origin shown by
\`tailscale serve status\`. A successful \`/api/health\` response reports whether the
BFF can reach OpenCode and whether their expected versions match.

> Do not restart OpenCode during an active turn. An OpenCode restart interrupts
> that turn; its session history remains, but the turn is not resumed automatically.

## Failure modes and recovery

\`launchd\` makes the BFF recoverable, not infallible. These outcomes determine
whether the phone-accessible app is temporarily unavailable:

| Failure point | What remains available | Recovery |
|---|---|---|
| UI or BFF build fails | The existing BFF remains serving because the installer builds before replacing the LaunchAgent. | Fix the build error, then rerun the upgrade commands. |
| Replacing the LaunchAgent fails after the old BFF stops | The app can be down because no BFF is listening on \`:3210\`. OpenCode remains running. | Run \`npm run service:status\` and \`npm run service:logs\`, fix the reported issue, then rerun \`npm run service:install -- --port=3210\`. |
| The new BFF exits after launch | The app is down until the service can stay running. launchd attempts to keep the BFF alive. | Inspect \`npm run service:logs\`; common causes are invalid \`.env\` values, a missing dependency, or an upstream configuration problem. |
| Tailscale or its Serve configuration is unavailable | The local BFF can still be healthy, but the phone HTTPS origin is unreachable. | Check \`tailscale status\` and \`tailscale serve status\`, then bring Tailscale up or recreate the Serve route if needed. |

Start diagnosis from the inside out: BFF health, LaunchAgent state and logs, then
Tailscale. Do not restart OpenCode merely to recover the UI/BFF.

## First-time setup

\`\`\`bash
cp .env.example .env
chmod 600 .env
npm ci
npm run service:install -- --port=3210
\`\`\`

Use \`npm run service:install -- --port=3211\` to choose another supervised port.
Port \`3000\` is rejected because \`npm run dev\` uses it by default. Installation is
idempotent: it rebuilds the app, replaces only
\`~/Library/LaunchAgents/ai.custom-dca-opencode.bff.plist\`, and bootstraps only the
matching \`gui/$UID/ai.custom-dca-opencode.bff\` job. Uninstall does not use \`pkill\`,
does not touch OpenCode, and preserves logs.

## Operations checklist

- Check service state: \`npm run service:status\`
- Follow BFF logs: \`npm run service:logs\`
- Remove the BFF service: \`npm run service:uninstall\`
- Keep \`.env\` mode \`0600\`; it contains credentials and is never copied to the plist.

Keep credentials such as \`OPENCODE_SERVER_PASSWORD\`, forge tokens, and notification
tokens in the repo-root \`.env\`, never in a plist. Keep that file mode \`0600\`.
\`launchd\` does not load \`.zshrc\`, \`.zprofile\`, or other shell profiles. The BFF still
loads \`.env\` with dotenv because its plist sets \`WorkingDirectory\` to the repository
root before starting \`dist/server/index.js\`.

## OpenCode connection

The BFF never starts OpenCode. It connects to the one server named by \`OPENCODE_URL\`
in \`.env\`. Verify that server first rather than starting another:

\`\`\`bash
curl --fail --user "\${OPENCODE_SERVER_USERNAME:-opencode}:$OPENCODE_SERVER_PASSWORD" \\
  "$OPENCODE_URL/global/health"
\`\`\`

## Tailscale access

Proxy the dedicated supervised port and inspect the resulting Serve configuration:

\`\`\`bash
tailscale serve --bg http://127.0.0.1:3210
tailscale serve status
\`\`\`

Set \`PUBLIC_APP_URL\` in \`.env\` to the HTTPS origin shown by Tailscale, then rerun
\`npm run service:install -- --port=3210\` so the BFF reads the new value.

Tailscale is not restarted by an app upgrade. Its Serve configuration keeps the same
local destination, so the only interruption is the short period while launchd replaces
the BFF. A request in that window can receive a transient connection error or \`502\`;
reload after the BFF health check succeeds. Run \`tailscale up\` or recreate Serve only
if Tailscale itself stopped or its Serve configuration was removed.

## Optional OpenCode Unit

\`ai.opencode.serve.plist\` remains a manual template for users who do not already
supervise OpenCode. Do not install it when \`OPENCODE_URL/global/health\` is already
reachable, and never overwrite an installed plist automatically.

The template invokes the OpenCode binary directly. It never relies on \`node\`,
\`/usr/bin/env\`, nvm, or shell-profile PATH setup. It also deliberately does not load
\`.env\` and contains no password: use it only for an unsecured server bound to
\`127.0.0.1\`. If OpenCode requires authentication, keep it under its existing
supervisor and put only the matching URL and credentials in the BFF's mode-0600
\`.env\`.

Before first use, make a working copy and replace every \`REPLACE_WITH_*\` value:

- \`REPLACE_WITH_ABSOLUTE_OPENCODE_BINARY\`: the absolute result of \`command -v opencode\`
- \`REPLACE_WITH_OPENCODE_PORT\`: the port from \`OPENCODE_URL\` in \`.env\`
- \`REPLACE_WITH_HOME_DIRECTORY\`: the absolute home directory
- \`REPLACE_WITH_LAUNCHD_PATH\`: an explicit PATH containing tools agents may invoke
- \`REPLACE_WITH_LOG_DIRECTORY\`: an existing absolute log directory

Paths containing spaces are valid plist strings and must not be shell-escaped. Escape
XML-sensitive characters if a path contains them. Validate that no placeholder remains
before installing under the distinct label:

\`\`\`bash
cp deploy/ai.opencode.serve.plist /tmp/ai.opencode.serve.plist
# Edit /tmp/ai.opencode.serve.plist, then:
! grep -q 'REPLACE_WITH_' /tmp/ai.opencode.serve.plist
plutil -lint /tmp/ai.opencode.serve.plist
test ! -e ~/Library/LaunchAgents/ai.opencode.serve.plist
cp /tmp/ai.opencode.serve.plist ~/Library/LaunchAgents/ai.opencode.serve.plist
launchctl bootstrap "gui/$UID" ~/Library/LaunchAgents/ai.opencode.serve.plist
launchctl print "gui/$UID/ai.opencode.serve"
\`\`\`

The jobs and logs are intentionally unambiguous: \`ai.opencode.serve\` uses
\`opencode.launchd.*.log\`; \`ai.custom-dca-opencode.bff\` uses \`bff.launchd.*.log\`.
`;export{e as default};
