const e=`# Contributing

Thank you for improving custom-dca-opencode. This guide covers the repository's
development workflow and the checks that pull requests must pass.

Use the self-contained [visual reading index](docs/contributing/index.html) to choose a
contributor pathway, open \`/docs\` in the running app for the architecture-focused docs center,
or continue here for the canonical workflow.

## Before you start

You need:

- Node.js 22 or newer
- npm
- A local OpenCode server at the version pinned in
  [\`server/opencode/client.ts\`](server/opencode/client.ts) for interactive development

The application runs directly on the host. Its runtime does not use Docker, and the
development script does not start OpenCode for you. Docker appears only as an optional
end-to-end test lane; nothing you need to run or deploy the application requires it.

## Set up the repository

Install the locked dependencies and create a local environment file:

\`\`\`bash
npm install
cp .env.example .env
\`\`\`

Review [\`.env.example\`](.env.example) before starting the app. At minimum,
\`OPENCODE_URL\` must point to a reachable OpenCode server. \`PROJECTS_DIR\` and
\`OPENCODE_WORKTREE_ROOT\` define the only roots from which the BFF accepts workspace
paths.

Start the BFF and Vite development server together:

\`\`\`bash
npm run dev
\`\`\`

The script checks OpenCode's \`/global/health\` endpoint and verifies that the BFF port is
available before starting either watcher. By default, OpenCode uses port 4096, the BFF
uses port 3000, and Vite uses port 5173. You can also run the watchers separately with
\`npm run dev:server\` and \`npm run dev:ui\`.

For deployment and macOS LaunchAgent instructions, see
[\`deploy/README.md\`](deploy/README.md). Those commands are not required for ordinary
development.

## Understand the boundaries

The request path is:

\`\`\`text
Browser -> React/Vite SPA -> Express BFF -> opencode serve
\`\`\`

See [docs/architecture.md](docs/architecture.md) for the detailed request and event flows,
state ownership, safety boundaries, and extension map.

- [\`client/\`](client/) contains the React SPA and design-system primitives.
- [\`server/\`](server/) contains API routes, credentials, directory validation, SSE
  fan-out, local git operations, notifications, and forge integrations.
- [\`server/opencode/client.ts\`](server/opencode/client.ts) is the typed fetch boundary for
  the OpenCode API. Treat the live OpenCode \`/doc\` response as the contract when that
  API changes.
- [\`client/lib/events.ts\`](client/lib/events.ts) maps raw OpenCode parts to the
  backend-neutral transcript model. Transcript rows should not consume raw OpenCode
  \`Part\` objects.
- [\`tests/\`](tests/) contains Vitest tests and fixtures.
- [\`tests/e2e/\`](tests/e2e/) contains Playwright tests and deterministic mock servers.

Keep browser-facing requests same-origin through the BFF. Do not expose OpenCode or
third-party credentials to the client. Preserve directory canonicalization and preview
proxy restrictions when changing routes that touch the host filesystem or local
services.

### What the MCP, skill, and command catalog can and cannot tell you

The Catalog panel and the Tools page report **what the connected OpenCode process says**.
None of it is proof that a capability ran, and the distinction matters when debugging
(issue [#55](https://github.com/leoncheng57/custom-dca-opencode/issues/55)):

| State | Means | Does **not** mean |
|---|---|---|
| configured | present in a config file | the process read it |
| connected | the MCP transport handshake succeeded | any tool on it works |
| loaded | read from disk at startup | it was invoked |
| registered | present in the tool registry, so invocable | it has been invoked in this session |

Two facts, verified against OpenCode 1.18.23, that make this unavoidable rather than a
UI shortcut:

- **\`/experimental/tool/ids\` lists built-in tools only.** A connected MCP server
  contributes nothing to it. There is no endpoint anywhere that enumerates a connected
  server's tools, so no surface can honestly show which of them work.
- **MCP state is process-local.** \`needs_auth\` and \`failed\` describe the environment of
  the running \`opencode serve\`, not your shell. A server that resolves from your terminal
  can still fail in the process when it was launched without the same environment — a
  LaunchAgent inherits a minimal \`PATH\` and no exported secrets. Restarting the service
  after changing environment is usually the fix:

\`\`\`bash
npm run service:install && npm run service:status
curl --fail http://127.0.0.1:3210/api/health
\`\`\`

Repository Playbooks commands, and external skills or commands reported by the connected
process, are read **at startup**. Restart OpenCode after installing one.

**What remains unverified by design.** Nothing in CI invokes a real MCP tool or a real
slash command: the E2E suite runs against deterministic mocks with no agent and no LLM
spend, and asserting against private services from CI is out of the question. Coverage
therefore proves the plumbing and the wording, not live capability. Confirming a specific
MCP tool actually works is still a manual step against a real instance.

## Follow repository conventions

- Keep TypeScript strict and match the surrounding module style.
- Use \`.js\` suffixes when tests import TypeScript modules, as required by the ESM build.
- Keep reusable primitives in [\`client/ds/\`](client/ds/) based on \`forwardRef\`, \`cn()\`,
  and semantic \`var(--color-*)\` tokens. Do not add raw color values.
- Add a \`data-testid\` to every interactive element so deterministic UI tests can target
  it.
- Keep every root theme token paired with a dark-mode value.
- Tolerate unknown OpenCode event types. The global event stream includes events outside
  the local typed union.
- Use the asynchronous prompt path for UI requests; the blocking message endpoint holds
  the connection for the full agent turn.
- Avoid new runtime dependencies unless the change genuinely requires one and its reason
  is recorded in [\`AGENTS.md\`](AGENTS.md).

There is no configured formatter or linter. Keep edits focused and follow the formatting
already used in the file you change.

## Add and run tests

Add focused tests with behavior changes:

- Vitest discovers \`tests/**/*.test.ts\` and runs in a Node environment.
- Playwright exercises the built SPA and real BFF against the mock OpenCode and preview
  servers in [\`tests/e2e/\`](tests/e2e/).
- End-to-end tests do not need a live agent, model credentials, or network access.

Run the same functional checks used by CI:

\`\`\`bash
npm run typecheck
npm test
npm run build
npm run test:e2e
\`\`\`

\`npm run test:e2e\` builds the production bundle automatically. A first local Playwright
run may require the Chromium binary:

\`\`\`bash
npx playwright install chromium
\`\`\`

CI installs Chromium with its operating-system dependencies before running the suite.
Failed CI runs upload the Playwright report as an artifact.

### Run end-to-end tests in isolation

The commands above write machine-global fixtures — \`/tmp/mock-project\` and its siblings,
their real \`.git\` directories, and ports \`3410\`, \`4599\`, \`4600\`. A separate worktree does
not isolate any of those, so two concurrent end-to-end runs can race on one Git index. If
you are working alongside another run, use the optional container lane instead:

\`\`\`bash
npm run test:e2e:docker
npm run test:e2e:docker -- tests/e2e/workspace-files.ui.spec.ts
\`\`\`

Each invocation builds a sanitized source snapshot into a disposable image, runs the suite
in its own filesystem, PID and network namespace, copies \`/artifacts\` out of the stopped
container into the ignored \`docker-e2e-artifacts/<run-id>/\`, and removes exactly the
container and image tag it created. The fixed paths and ports stay unchanged inside the
container, so no spec needed migrating.

If Docker is not running, the lane stops with exit \`69\` rather than quietly running on the
host: \`0\` means the tests passed, \`1\` means they failed, and \`69\` means the lane never ran.
Keeping those separate lets a script or agent tell a red suite from an absent one.

Running end-to-end tests locally without Docker is still supported as a deliberate
override — use the host lane below. It is safe when no other end-to-end run is active, which
includes a sibling worktree on a different \`PORT\`, since that still writes the same \`/tmp\`
fixtures. The launcher cannot check for that, which is why it asks you rather than guessing.

Keep using the host lane for debugging — it is faster and supports \`--headed\` and the
Playwright inspector:

\`\`\`bash
npm run test:e2e:host -- tests/e2e/workspace-files.ui.spec.ts --headed
\`\`\`

The host lane is the one that reuses a listening server, so the port check under
[Capture transient UI state locally](#capture-transient-ui-state-locally) still applies to
it. Some contracts are host-only and cannot be proven in a Linux container — macOS \`/tmp\` →
\`/private/tmp\` canonicalization, real symlink containment, the host \`git\` integration and
\`0600\` state-file modes. Those live in a separate lane:

\`\`\`bash
npm run test:contract:host
\`\`\`

Docker here is a state-isolation boundary, not a security sandbox: a pull request can edit
\`Dockerfile.e2e\` and \`scripts/e2e-docker.ts\`, so running untrusted code safely needs a
launcher and image definition from outside the checkout being tested.

## Prepare a pull request

Use Conventional Commit prefixes for changes that should affect the next release.
Before \`1.0.0\`, \`fix:\` and \`feat:\` increment the patch version while a
\`BREAKING CHANGE:\` footer or \`!\` increments the minor version. At and after \`1.0.0\`,
features increment minor and breaking changes increment major. Release Please collects
merged commits into a release pull request; merging that release PR updates
\`package.json\` and \`package-lock.json\`, writes \`CHANGELOG.md\`, and creates the release
tag. Conventional commit text alone does not change the version before that release PR
is merged.

Before opening a pull request:

1. Rebase or merge the latest \`main\` without force-pushing shared work.
2. Review \`git diff\` and \`git status\` for unrelated files and secrets.
3. Run the typecheck, unit tests, build, and end-to-end tests listed above.
4. Explain the behavior changed and list the verification performed.

Pull requests run the full verification sequence and a full-history Gitleaks scan. Do
not commit \`.env\`, credentials, local state, generated build output, Playwright reports,
or screenshot output.

Every same-repository pull request also receives a credential-free interactive simulator
that refreshes on each commit. See [Pull request previews](docs/pr-previews.md) for the
deployment flow, diagrams, BFF stub contract, trust boundaries, and troubleshooting.

### Request deterministic UI screenshots

For a UI change, add one fenced \`screenshots\` block to the pull request body with one
root-relative route per line:

\`\`\`\`markdown
\`\`\`screenshots
/?directory=/tmp/mock-project
full:/sessions/ses_mock_done?directory=/tmp/mock-project
\`\`\`
\`\`\`\`

The workflow accepts up to ten known application routes and captures dark-mode desktop
and mobile images against deterministic mocks. Prefix a route with \`full:\` to capture
its full scroll height. Reproduce the fixture request locally with:

\`\`\`bash
npm run screenshots:local
\`\`\`

Output is written to the ignored \`screenshot-output/\` directory. See the
[\`README.md\`](README.md#pr-screenshots) for route validation, fork, publication, and
troubleshooting details.

### Capture transient UI state locally

For a proposal that isn't built yet, use the composer's **"Capture a Durable Design
Prototype"** workflow instead: it publishes a durable, externally-linkable prototype
(committed to \`design/\`, embedded in a Notion page) rather than the ephemeral, gitignored
capture below.

Prefer the route-based \`screenshots\` block above. Reach for a temporary Playwright spec
only when the state worth reviewing exists solely after an interaction, such as an open
workspace drawer, a selected file, or an expanded menu. The workflow accepts a fixed list
of application routes, and some surfaces are deliberately not routes at all: a file
reference opens the workspace drawer as an overlay without changing the browser location,
so no route can reach it. \`npm run screenshots:local\` runs the same route validation and
does not help either.

Check three unused ports before running anything:

\`\`\`bash
for port in 3531 4732 4733; do lsof -nP -iTCP:"$port" -sTCP:LISTEN; done
\`\`\`

Silence means all three are free. Outside CI, Playwright reuses a server that is already
listening, so a spec left on the default \`3410\`, \`4599\`, and \`4600\` can attach to another
worktree's BFF and mock and silently screenshot that build instead of yours. Do not kill
another worktree's listeners; pick a different triple.

Write a throwaway spec in [\`tests/e2e/\`](tests/e2e/) against the read-only
\`ses_mock_files\` fixture:

\`\`\`ts
import { expect, test } from "@playwright/test";

// The mock canonicalizes its fixture directory, so macOS needs the /private
// spelling or the session resolves to a different project.
const DIR = process.platform === "darwin"
  ? "/private/tmp/mock-files-project"
  : "/tmp/mock-files-project";

test("capture the workspace drawer", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("theme", "dark"));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(\`/sessions/ses_mock_files?directory=\${encodeURIComponent(DIR)}\`);

  await page
    .getByTestId("opencode-file-reference")
    .filter({ hasText: "src/index.ts:12" })
    .click();

  // Settle on rendered content rather than on a visible container: the drawer
  // is visible while the viewer inside it is still a spinner.
  const viewer = page.getByTestId("opencode-code-viewer");
  await expect(viewer).toContainText("export const DEFAULT_PORT = 3210;");

  await page
    .getByTestId("opencode-workspace-panels")
    .screenshot({ path: "screenshot-output/workspace-drawer.png" });
});
\`\`\`

Set the viewport and the dark color scheme explicitly. The published workflow captures
dark mode at 1280x800 and 390x740, so an image that omits them will not match the rest of
the review.

Use \`locator.screenshot()\` when the subject is one component and the surrounding page is
noise; it crops to the element and stays legible inline. Use \`page.screenshot()\` when the
layout itself is the point, when the state spans several panels, or when an overlay is
anchored to the viewport rather than to its trigger. Add \`{ fullPage: true }\` only for a
surface that scrolls.

Run that one file on the ports you checked:

\`\`\`bash
PORT=3531 MOCK_OPENCODE_PORT=4732 MOCK_PREVIEW_PORT=4733 \\
  npx playwright test tests/e2e/transient-capture.spec.ts --workers=1
\`\`\`

Then clean up:

- Delete the temporary spec. It captures an image instead of asserting behavior, so it is
  not a test and must not be committed.
- Keep the PNGs in the ignored \`screenshot-output/\` directory and attach them to the pull
  request as uploads.
- Confirm \`git status --short\` reports neither the spec nor the images.

A screenshot documents appearance and is not proof that the interaction is correct, so
keep a real assertion for the behavior in a permanent spec such as
[\`tests/e2e/workspace-files.ui.spec.ts\`](tests/e2e/workspace-files.ui.spec.ts). Broader
capture and publishing automation is tracked in
[#119](https://github.com/leoncheng57/custom-dca-opencode/issues/119).

## Security-sensitive changes

OpenCode tools execute on the host as the current user. Changes involving permissions,
workspace paths, credentials, the preview proxy, session sharing, or workflow privileges
need explicit tests for their security boundaries. Keep broad permission rules before
specific overrides because OpenCode permission matching is last-match-wins.

Report a suspected vulnerability privately to the repository owner rather than opening
a public issue with exploit details.
`;export{e as default};
