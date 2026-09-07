const e=`# custom-dca-opencode

**Status: early alpha.** The phases in the Status table below are implemented and verified,
but interfaces and behaviour can still change without notice, and there is no stability,
support, or production-readiness guarantee. Known gaps and planned work are tracked in the
[issue list](https://github.com/leoncheng57/custom-dca-opencode/issues).

A custom local coding-agent IDE built on the [OpenCode](https://opencode.ai) server API.

React/Vite SPA + Express BFF talking to a long-lived \`opencode serve\` over HTTP and SSE.
Runs entirely on the host — no Docker in the application runtime, one process to
supervise. Reachable from a phone over Tailscale. (Docker is optional *test*
infrastructure only; see [Isolated E2E](#isolated-e2e-docker).)

> Successor to \`custom-dca-ide-with-openhands\`, which is frozen as an artifact.
> The research and plan behind the migration live in [\`docs/research/\`](docs/research/).

## Why

\`opencode\` is excellent in the terminal, but a terminal UI can't give you a
notifications settings page, a merge-request panel with pipeline status, or a
glanceable view of which of your MCP servers are quietly failing. This is that layer —
a web frontend for an agent server you already run.

It is deliberately **not** a replacement for the \`opencode\` CLI. Both are clients of
the same server and can be attached at the same time, watching the same sessions.

## Playbooks

The Runner's native **Playbooks** section at \`/playbooks\` catalogs the live **composer
workflows** the server supplies over \`GET /api/workflows\`, including the exact trusted
injector each one appends. A workflow is a guided action: you fill in one form, read
the exact prompt and the exact trusted instructions, and only then send. Nothing is
installed, nothing is copied to your machine, and no restart is involved.

The repository-owned command catalogue that used to live here is retired. Sixteen of
its procedures were ported verbatim into workflows; the other seven were already
covered by runtime reminders and were simply deleted. One thing genuinely changed
rather than moved: a command could pin its own agent (\`agent: plan\`), and a workflow
cannot — it is sent in the sending session's current mode, and the preview says so.

Runtime reminders under root \`reminders/\` remain separate per-message prompt content,
and the live \`/skill\` Catalog panel remains the connected OpenCode process's inventory
of externally installed content. The former standalone catalog app is retired.

There is no public static catalogue. Playbooks is read from the running Runner, and
the retired GitHub Pages catalogue at \`/custom-dca-opencode/agent-skills/\` has been
removed from \`gh-pages\` rather than left serving a stale index (AGENTS.md decision 32).
The unrelated <https://leoncheng.dev/agent-skills/> site belongs to an archived
separate repository that this repository's token cannot modify.

## Status

The planned migration waves are implemented. The deterministic verification suite runs
against the production SPA and real BFF with only OpenCode and preview targets mocked.

| Phase | | |
|---|---|---|
| 0 | Foundation — scaffold, permission policy, launchd unit | ✅ |
| 1 | The seam — typed fetch wrapper + event adapter | ✅ |
| 2 | Session lifecycle + interrupted-run detection | ✅ |
| 3 | Panels — MR links, commands, files, changes, preview proxy | ✅ |
| 4 | Derived — task list, status bar, tools & health | ✅ |
| 5 | Settings, notifications, resilience, worktrees | ✅ |
| 6 | Mobile/PWA polish + deterministic E2E | ✅ |

## Requirements

- Node 22+
- A running \`opencode serve\` (or \`opencode web\`) — v1.18.22
- Optional: Tailscale, for phone access

## Quick start

\`\`\`bash
npm install
cp .env.example .env        # point OPENCODE_URL at your server
npm run dev
\`\`\`

For a login-persistent production BFF, use the idempotent macOS LaunchAgent tooling:

\`\`\`bash
chmod 600 .env
npm run service:install             # dedicated port 3210
npm run service:status
\`\`\`

See [\`deploy/README.md\`](deploy/README.md) for logs, uninstall, Tailscale Serve,
paths containing spaces, and the optional OpenCode unit. The BFF installer never
starts a second OpenCode server; it uses \`OPENCODE_URL\` from \`.env\`.
The baseline OpenCode 1.18.21 compatibility check is recorded in
[\`docs/opencode-1.18.21-api-audit.md\`](docs/opencode-1.18.21-api-audit.md); managed child creation
was subsequently validated live against 1.18.22 and is documented in
[\`docs/subagents.md\`](docs/subagents.md).
See [\`CONTRIBUTING.md\`](CONTRIBUTING.md) for the development and pull request workflow.
The running app exposes the architecture and canonical guides at \`/docs\`; the same contributor
material also has a standalone themed [visual reading index](docs/contributing/index.html).

### Open on a phone

Expose the app with Tailscale Serve (or another private HTTP(S) endpoint), then set its
origin in \`.env\` and restart the app:

\`\`\`bash
PUBLIC_APP_URL=https://your-device.your-tailnet.ts.net
\`\`\`

Use **Phone** in the global navigation to open a scannable QR code, copy the link, or
close the panel without leaving the current page. The QR is generated locally in the
browser; its URL is never sent to an image or QR service. \`PUBLIC_APP_URL\` must be an
HTTP(S) origin with no path, query, fragment, or credentials. If it is unset, the QR
uses the current browser origin, which is only useful when that origin is phone-reachable.

### Notifications

Browser sound profiles and optional generic status speech are stored per device. Browser,
PWA push, and ntfy event delivery toggles remain server-backed and independent. Spoken notifications
never include prompts, paths, filenames, commands, tool output, or notification bodies.

PWA push uses a notification-only service worker and does not intercept requests or cache
the application, conversations, permissions, or API responses. Generate VAPID keys once
with \`npx web-push generate-vapid-keys\`, set \`VAPID_PUBLIC_KEY\`, \`VAPID_PRIVATE_KEY\`, and
\`VAPID_SUBJECT\` in \`.env\`, restart the BFF, then enable **PWA push** in Settings. The private
key and subscription authentication material stay on the BFF. iPhone and iPad require
iOS/iPadOS 16.4 or newer, a secure HTTPS origin, and installation through **Add to Home
Screen** before permission can be granted. Android and desktop browsers require a secure
origin but generally do not require installation. \`ntfy\` remains available as an independent
fallback and is never disabled by PWA push.

Service-worker updates wait until the app displays **An app update is ready**. Choosing
**Update** activates the new worker and reloads the page; **Later** leaves the current worker
in control. There is deliberately no offline mode or runtime/API cache.

A red counter appears on the nav link and the page header with the number of unresolved
notifications in the current project. Every notification kind starts unresolved, including
\`idle\`, \`error\`, \`abort\`, and \`parked\`. Answering an agent permission or question does not
change notification state: only the user's **Resolved** checkbox does. The checkbox is
reversible and its state is persisted on the server.

The page also lists every notification the BFF classified, including ones that were never
delivered, because "why was I never asked?" is the question that log exists to answer.
\`ntfy\` and PWA push report \`sent\`, \`off\` or \`failed\`; \`desktop\` reports only whether server-backed
desktop notifications were **allowed**, since the BFF cannot observe whether a tab rendered
one. Sound and speech are device-local and therefore absent from the server log.
Auto-approved permissions appear marked \`suppressed by auto permissions\` and remain in the
unresolved checklist until the user checks them off.

Records live in \`.state/notification-history.json\` (override with
\`NOTIFICATION_HISTORY_FILE\`). Every unresolved record is retained; the newest 500 resolved
records are retained alongside them. History is not bulk-clearable because it is the
evidence used to explain missing or suppressed delivery.

Verification requires no live agent or model credentials:

\`\`\`bash
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:preview
\`\`\`

### Isolated E2E (Docker)

\`npm run test:e2e\` writes machine-global fixtures: \`/tmp/mock-project\` and its siblings,
their real \`.git\` directories, and fixed ports \`3410\`, \`4599\`, \`4600\`. Separate worktrees
isolate source and dependencies but not those, so two agents running E2E at the same time
race on one Git index. The optional Docker lane gives each Playwright invocation its own
filesystem, PID and network namespace, which makes the fixed paths and ports private per
run:

\`\`\`bash
npm run test:e2e:docker                                  # full suite, isolated
npm run test:e2e:docker -- tests/e2e/smoke.ui.spec.ts    # one spec
npm run test:e2e:host   -- tests/e2e/smoke.ui.spec.ts    # explicit host lane
\`\`\`

\`\`\`text
docker create --network none --cap-drop ALL --init  (no mounts, no published ports)
  |
  +-- /workspace     sanitized source snapshot baked into the image
  +-- /tmp           private: mock-project, mock-files-project, .git fixtures
  +-- 3410/4599/4600 private: BFF + mock OpenCode + mock forge
  \`-- /artifacts     test-results/ playwright-report/ logs/
        |
        \`-- docker cp after exit -> docker-e2e-artifacts/<run-id>/  (validated)
\`\`\`

If Docker is not running, the lane **fails rather than silently using the host**, and says
so with a dedicated exit code:

| Exit | Meaning |
|---:|---|
| \`0\` | tests passed |
| \`1\` | tests failed |
| \`69\` | the lane could not run (Docker missing or daemon down) |

\`69\` is \`EX_UNAVAILABLE\`, kept distinct from \`1\` so a script or agent can tell "the suite is
red" from "the suite never ran". A local run without Docker is still available as a
deliberate override — \`npm run test:e2e:host\` runs the same suite — but it writes the shared
\`/tmp\` fixtures and binds \`3410\`/\`4599\`/\`4600\`, so it is safe only when no other end-to-end
run is active. That includes a sibling worktree on a different \`PORT\`, which still shares
those fixtures; because the launcher cannot verify that, it never falls back on its own.

The container carries no Docker socket, no host home or credentials, no writable source or
artifact mount, and no default route; it runs as uid 1000 with all capabilities dropped.
Artifacts are copied out of the *stopped* container and validated on the host — symlinks
are refused rather than followed, and the bundle is size- and count-bounded. Each run
removes exactly the one container and image tag it created.

Two containers were verified running the full suite concurrently with byte-identical
internal paths and ports: destroying one lane's \`.git\` left the other's index and HEAD
bit-identical, killing one lane left the other to finish with exit 0, and the host worktree
was unchanged throughout (\`npm run test:e2e:docker:proof\`, 26/26 checks).

Docker is **not** a hostile-code sandbox here: a pull request can edit \`Dockerfile.e2e\` and
the launcher, so reviewing untrusted code needs a launcher and image definition from
outside the tested checkout. Linux containers also cannot prove macOS \`/tmp\` →
\`/private/tmp\` behaviour, which is why \`npm run test:contract:host\` stays host-native.

### Interactive PR previews

Every same-repository pull request receives a public, interactive simulator at
\`https://leoncheng.dev/custom-dca-opencode/pr-previews/pr-<number>/\`. The **PR preview**
workflow runs on \`opened\`, \`reopened\`, and every \`synchronize\` event, so each pushed commit
rebuilds the preview. It tests the production bundle in Chromium, publishes only that PR's
directory on \`gh-pages\`, creates a transient GitHub Deployment, and updates one
\`<!-- pr-preview -->\` comment with the current commit and URL. Closing the PR removes the
directory and comment and marks its deployment environment inactive.

The preview is the actual PR client bundle with an in-browser BFF simulator. It includes
projects, sessions, transcripts, Plan/Build controls, models, tasks, sub-agents, workspace
files and changes, tools, settings, notifications, docs, and planning fixtures. Mutating
controls update tab-local memory so reviewers can exercise flows without an OpenCode
process. Reloading restores the deterministic fixture. The simulator uses hash routing so
all client routes remain reload-safe below the PR-specific Pages path.

No \`.env\` file, OpenCode password, AI provider key, GitHub token, repository secret, host
filesystem, or live conversation enters the bundle. The simulator does not register the
production service worker or publish a PWA manifest. Forks still run the read-only build
and retain the 30-day artifact, but are not published: executing a fork's JavaScript on the
repository's Pages origin is not an acceptable convenience tradeoff.

The artifact carries a full SHA/size inventory bound to the PR number, source commit, and
base path. Publication revalidates that inventory, rejects links and unsafe paths, caps the
file count and total bytes, and writes through the same non-force \`gh-pages\` concurrency
lock as screenshots and the public website. GitHub Pages must remain configured to deploy
the \`gh-pages\` branch from \`/(root)\`.

Run the same simulator smoke test locally with:

\`\`\`bash
npx playwright install chromium
npm run test:preview
\`\`\`

### PR screenshots

Add a fenced block to a pull request description to capture mock-backed UI routes:

\`\`\`\`md
\`\`\`screenshots
/?directory=/tmp/mock-project
full:/sessions/ses_mock_done?directory=/tmp/mock-project
\`\`\`
\`\`\`\`

CI accepts up to 10 routes and captures each one in dark mode at desktop (1280x800) and
mobile (390x740) widths. The sticky PR comment shows \`Route\`, \`Desktop\`, and \`Mobile\`
columns with public full-size links; a 30-day Actions artifact contains both PNGs per
route. \`full:\` captures the full scroll height at both widths. A route may appear once on
its own and once as \`full:\`; requesting the exact same route and mode twice is rejected
when the block is parsed, before any browser starts. Blank and \`#\` comment lines
are ignored. Routes cannot contain whitespace, hosts, schemes, controls, backslashes, or
traversal. Removing the block removes that PR's published directory; closing the PR
removes the directory and comment. Capture always uses the deterministic Playwright mocks,
never a live OpenCode server or real conversations.

Fork runs remain read-only and may need maintainer approval. Fork artifacts are linked in
the sticky comment but are never copied to \`gh-pages\`: manifest validation cannot prove
that untrusted code genuinely used Playwright to produce the PNG bytes. If inline capture
is needed for a fork, attach locally reviewed images instead. Run the fixture request with:

\`\`\`bash
npm run screenshots:local
\`\`\`

Publication requires Actions to allow the workflow's declared \`contents: write\` and
\`pull-requests: write\` permissions. The trusted publisher creates \`gh-pages\` on its first
image publication; GitHub Pages itself does not need to be enabled because comments use
public \`raw.githubusercontent.com\` URLs. The \`workflow_run\` publisher must exist on the
default branch, so this bootstrap PR can prove capture via its artifact but will not
self-publish until the workflows are merged.

If capture fails, inspect the **PR screenshots** run for the rejected route or Playwright
error and reproduce with \`npm run screenshots:local\`. If capture succeeds without a
comment, inspect **Publish PR screenshots**, verify workflow write permissions, and check
that the \`gh-pages\` branch is not protected against the bot. Stale images are cache-busted
with the source SHA. GitLab MRs can reuse the parser, manifest, and validation model, but
would need GitLab artifact/Pages publication and MR-note API wiring; that second CI system
is intentionally not included.

### Share and export

The conversation header shares or exports the full transcript, and each user or readable
assistant row can export that message. Copy, Markdown download, JSON download for full
sessions, and device sharing use the normalized visible transcript. Attachment exports are
limited to filename and MIME metadata. Reminder bodies, provider metadata and signatures,
raw tool arguments and output, attachment URLs, and file paths are excluded. Device sharing
is shown only when the browser implements \`navigator.share\`.

Public OpenCode links are deliberately separate. Creating one publishes the complete raw
session to OpenCode's configured sharing service, including message parts that local
exports omit, and continues syncing future updates. Anyone with the URL can view it. The
UI requires a second explicit confirmation before publication, shows the returned URL,
and requires another explicit confirmation to revoke it. Revocation disables that URL;
it cannot recall copies already downloaded or shared by viewers. Whether sharing is
available and where data is hosted are controlled by the OpenCode server configuration.

## Architecture

\`\`\`
Browser (desktop / phone via Tailscale)
   │
   ├── client/    React 19 + Vite + Tailwind v4 SPA
   │
   └── server/    Express BFF — auth, directory scoping, SSE fan-out,
                  local git, third-party (GitLab/GitHub/ntfy)
        │
        └── opencode serve :4096   one instance, all projects
\`\`\`

The BFF exists because: it holds the server credential, fans one upstream SSE stream out
to many browser clients, threads \`?directory=\` per project, and runs the things the
OpenCode API doesn't expose (git history, forge APIs, notification transport).

### Experimental DeepSeek Harness workspace

DSH can run beside OpenCode behind a separate \`/dsh\` UI and \`/api/dsh/*\` bridge. It is
off by default and does not alter OpenCode sessions, events, permissions, or URLs. Install
one exact \`deepseek-harness-sdk\` version in a dedicated Python environment, provide an
explicit Cordis composition, and configure allowlisted presets and workspaces as shown in
\`.env.example\`. Presets are either \`read-only\` or \`build\`; Build requires an explicit UI
confirmation and may write only within the selected workspace. The BFF verifies and exposes the canonical entry-composition
file fingerprint for diagnostics; it never falls back to the SDK's writable default composition.
On the supported macOS V1 target, the bridge and every DSH child process run under a
mode-specific Seatbelt profile. Read-only denies workspace writes; Build permits the exact
canonical workspace; both deny writes everywhere except the DSH state directory and that
Build workspace. The Cordis policy remains a second, independent boundary.

The DSH subprocess inherits only a small environment allowlist (\`PATH\`, basic locale/temp
state, and explicitly named DeepSeek/OpenAI/Anthropic provider keys). GitHub, OpenCode,
notification, and unrelated DCA credentials are not forwarded. DSH remains local behind the BFF; do not expose or reverse-proxy its
native Web UI. The full dual-runtime decision and phased estimate are tracked in
[issue #225](https://github.com/leoncheng57/custom-dca-opencode/issues/225).

Each DSH conversation also has a mobile-first **DSH Trajectory** inspector. It renders
the pinned \`dsh-v0.1.1-rc.2\` \`session.event\` vocabulary (turns, steps, request metadata,
messages, tool pairs, compaction, child lineage, timing, usage, failures, and surface
replacement) without embedding or proxying DSH Web. It keeps a bounded, explicitly
incomplete **DCA-captured projection** from the moment the bridge observes an event.
Every response states that it may contain gaps and is not canonical DSH persistence.

When the composition persists sessions, DCA instead reads the harness's **own durable
log** through the vendor package (\`@deepseek-ai/dsh-session-persistence-jsonl\`), and the
inspector says *"From DSH durable log · complete"* rather than warning about gaps. That
path is read-only by construction: only \`list\`, \`listSnapshots\` and \`readFrom\` are ever
called, never \`load\`/\`prepare\`, which perform recovery that rewrites the harness's log.

Persistence is detected, not required — the bridge already points \`DSH_SESSION_ROOT\` at
DCA's own state directory, so DCA probes there for a session artifact. If nothing is
persisted the bounded capture above is used unchanged, and the two are distinguishable
in the API: only durable responses may report \`complete: true\`. DCA never hand-parses
DSH's native or compressed JSONL either way.

Safe rows and safe export contain metadata-only projections; they never derive prompt,
command, path, tool input/output, reasoning, or context text. Sensitive one-event detail
is \`POST\`-only and disabled unless \`DSH_TRAJECTORY_SENSITIVE_ENABLED=true\`. Full captured
detail export additionally requires \`DSH_TRAJECTORY_FULL_EXPORT_ENABLED=true\` and an
in-UI confirmation. Captured detail is bounded and credential-shaped values are redacted
before persistence. Projection directories use mode \`0700\`, files use \`0600\`, and age,
event-count, file-count, per-file-byte, and global-byte limits apply. DCA still has no
application-level authentication, so private Tailscale reachability remains a deployment
requirement rather than a substitute for these content controls.

See [\`docs/architecture.md\`](docs/architecture.md) for conversation and event flows, state
ownership, safety boundaries, and the extension map. See
[\`docs/subagents.md\`](docs/subagents.md) for child-session lifecycles, permissions, and safe
parallel work.

## Safety

\`opencode serve\` runs agent tools **directly on the host as your user** — there is no
container. The guardrail is the \`permission\` block in \`opencode.json\`: per-tool and
per-command-pattern \`allow\` / \`ask\` / \`deny\`, with \`~/.ssh\`, \`~/.aws\` and \`.env\` files
denied outright.

The BFF additionally canonicalizes every browser-provided workspace path beneath
\`PROJECTS_DIR\` or \`OPENCODE_WORKTREE_ROOT\`. The preview tunnel is disabled unless
\`PREVIEW_ALLOWED_PORTS\` explicitly allows a localhost port, and it never forwards
cookies, authorization, host headers or OpenCode credentials.

Note that permission precedence is **last-match-wins**, the opposite of most ACL
systems. Broad rules first, specific overrides after.

## License

MIT
`;export{e as default};
