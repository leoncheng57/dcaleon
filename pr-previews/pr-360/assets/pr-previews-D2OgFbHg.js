const e=`# Pull request preview pipeline

Every same-repository pull request receives a public, interactive simulator at:

\`\`\`text
https://leoncheng.dev/custom-dca-opencode/pr-previews/pr-<number>/
\`\`\`

The preview refreshes for every new pull request commit. It is the pull request's real
client bundle running against deterministic browser-local BFF stubs. It does not publish
the Express BFF, an OpenCode or DeepSeek Harness process, credentials, host files, or live
conversations. The experimental DSH Lab is fixture-backed in previews just like OpenCode:
its sessions, prompts, cancellation, transcript, and preview frame mutate only that browser
tab and reset on reload.

This guide owns the contributor and reviewer contract for preview builds. For the local
production deployment, use [Deployment operations](../deploy/README.md). For static PR
images, use the [PR screenshots guide](../README.md#pr-screenshots).

## Architecture boundary

\`\`\`mermaid
flowchart LR
  subgraph Local[Private/local production runtime]
    Browser[Browser SPA] --> BFF[Express BFF]
    BFF --> OpenCode[opencode serve]
    BFF --> Host[Git + host filesystem]
    BFF --> Secrets[Provider and forge credentials]
  end

  subgraph Public[Public PR preview]
    Pages[GitHub Pages] --> PRBundle[PR client bundle]
    PRBundle --> Simulator[In-browser BFF simulator]
    Simulator --> Fixture[Deterministic tab-local fixtures]
  end

  Public -. no network path .-> BFF
  Public -. no access .-> OpenCode
  Public -. no access .-> Host
  Public -. no secrets .-> Secrets
\`\`\`

GitHub Pages can host static files only. Hosting the real BFF or \`opencode serve\` would
also turn host-level agent authority into a public service. The pipeline therefore keeps
the normal React UI and replaces only browser calls to \`/api/*\`.

The preview uses \`HashRouter\`, so nested routes remain reload-safe below the PR-specific
Pages directory. Preview builds omit the production service worker and PWA manifest; a PR
must not claim an installable application scope on the repository's public origin.

## Per-commit deployment flow

\`\`\`mermaid
sequenceDiagram
  autonumber
  participant Dev as Contributor push
  participant PR as pull_request workflow
  participant Chromium as Preview smoke test
  participant Artifact as Actions artifact
  participant Deploy as Deploy job
  participant GH as GitHub Deployments API
  participant Pages as gh-pages / Pages
  participant Comment as Sticky PR comment

  Dev->>PR: opened / reopened / synchronize
  PR->>PR: npm ci + build simulator at PR base path
  PR->>Chromium: Exercise session, send, workspace preview, planning, reload
  Chromium-->>PR: Pass with no page errors
  PR->>Artifact: Upload site + SHA-256 manifest
  Artifact->>Deploy: Download exact PR/SHA artifact
  Deploy->>Deploy: Revalidate identity, paths, bytes, digests, limits
  Deploy->>GH: Create transient pr-preview-N deployment
  Deploy->>Pages: Non-force publish pr-previews/pr-N only
  Deploy->>Pages: Wait until public URL responds
  Deploy->>GH: Mark deployment success/failure
  Deploy->>Comment: Create or update one <!-- pr-preview --> comment
\`\`\`

The build job has \`contents: read\` only. Same-repository pull requests continue into the
deploy job; forks stop after producing the downloadable Actions artifact. Publishing fork
JavaScript on the repository's Pages origin is deliberately unsupported.

## Shared publication concurrency

\`\`\`mermaid
flowchart TD
  C1[Commit A build] --> D1[Commit A deploy]
  C2[Commit B build] --> D2[Commit B deploy]
  C3[Commit C build] --> D3[Commit C deploy]

  C1 -. newer build cancels only stale build .-> C2
  C2 -. newer build cancels only stale build .-> C3

  D1 --> Lock[Shared pr-screenshot-publication lock]
  D2 --> Lock
  D3 --> Lock
  Lock --> Branch[Non-force gh-pages writes serialize]
\`\`\`

Builds are cancellable per PR. A deployment is never cancelled once it starts: interrupting
a shared-branch writer is riskier than briefly publishing an older commit before the queued
newest commit replaces it.

Preview, screenshot, and public-site publishers share the historical
\`pr-screenshot-publication\` concurrency key. Every writer uses a non-force push and owns a
disjoint subtree.

## Changed files and responsibilities

\`\`\`mermaid
flowchart TD
  Root[PR preview feature]

  Root --> Workflows[.github/workflows]
  Workflows --> PreviewWF[pr-preview.yml<br/>build, validate, deploy, Deployment API, sticky comment]
  Workflows --> CleanupWF[cleanup-pr-screenshots.yml<br/>preview + screenshot cleanup, deployment inactive]
  Workflows --> CIWF[ci.yml<br/>runs simulator smoke in ordinary CI]

  Root --> Client[client]
  Client --> Main[main.tsx + lib/runtime.ts<br/>install simulator before mount, HashRouter]
  Client --> Simulator[simulator/publicSimulator.ts<br/>tab-local BFF fixture and mutations]
  Client --> Shell[components/app-shell.tsx<br/>visible simulator disclosure]
  Client --> Workspace[components/workspace-panels.tsx<br/>public fixture iframe instead of localhost]
  Client --> PWA[index.html + vite.config.ts<br/>nested asset base, omit SW/manifest]
  Client --> Streams[useSessionStream + useNotifyWatcher<br/>no public SSE connections]

  Root --> Validation[validation and tooling]
  Validation --> Packager[scripts/pr-preview.ts<br/>bounded manifest package and validator]
  Validation --> Unit[tests/pr-preview.test.ts<br/>identity, tamper, symlink, base-path tests]
  Validation --> BrowserTest[tests/preview-e2e + playwright.preview.config.ts<br/>real built bundle at nested Pages path]
  Validation --> Scripts[package.json + tsconfig.tools.json]

  Root --> Docs[review and operations docs]
  Docs --> Guide[docs/pr-previews.md]
  Docs --> Readme[README.md]
  Docs --> Agents[AGENTS.md decision 22]
\`\`\`

Equivalent filesystem view:

\`\`\`text
.github/workflows/
|-- pr-preview.yml                  # Per-commit build/deploy pipeline
|-- cleanup-pr-screenshots.yml      # Cleanup for all PR artifacts
\`-- ci.yml                          # Simulator smoke in ordinary CI
client/
|-- simulator/
|   \`-- publicSimulator.ts          # Browser-local BFF and fixtures
|-- lib/
|   |-- runtime.ts                  # Build-mode flag
|   |-- useSessionStream.ts         # Disable SSE in public mode
|   \`-- useNotifyWatcher.ts         # Disable global SSE in public mode
|-- components/
|   |-- app-shell.tsx               # Simulator disclosure
|   \`-- workspace-panels.tsx        # Fixture preview frame
|-- main.tsx                        # Install adapter + select HashRouter
\`-- index.html                      # Base-relative public assets
scripts/
\`-- pr-preview.ts                   # Package and validate inventory
tests/
|-- pr-preview.test.ts              # Artifact boundary unit tests
\`-- preview-e2e/
    \`-- public-simulator.spec.ts     # Interactive nested-path smoke
playwright.preview.config.ts
vite.config.ts
\`\`\`

## BFF simulator request flow

\`client/simulator/publicSimulator.ts\` replaces \`globalThis.fetch\` before React mounts. It
intercepts only \`/api/*\`; documents and assets continue through native browser fetch.
Unknown API method/path pairs return an explicit JSON \`404\` rather than a guessed success.

\`\`\`mermaid
flowchart TD
  Call[Client api call] --> Adapter[Simulator fetch adapter]
  Adapter -->|not /api/*| Native[Native browser fetch]
  Adapter -->|known read| Fixture[Deterministic fixture response]
  Adapter -->|known mutation| Memory[Update tab-local memory]
  Memory --> Shape[Return normal BFF response shape]
  Adapter -->|unknown| Missing[Explicit JSON 404]
  SSE[Session and notification streams] --> Guard[PUBLIC_SIMULATOR guard]
  Guard --> Disabled[No EventSource or reconnect loop]
  LocalPreview[Workspace localhost preview] --> SrcDoc[Sandboxed fixture srcDoc]
\`\`\`

### Stubbed endpoint families

| Surface | Stubbed responses | Tab-local mutations |
| --- | --- | --- |
| Bootstrap and discovery | Health, app config, projects, project pins, model pins, model catalogue, recent sessions | Save project/model pins |
| Sessions | List/detail, messages, todos, model limit, turn diff, prompt, abort, share, delete | Create/delete sessions, append simulated turns, stop, share/unshare |
| Delegation and questions | Sub-agent ledger, managed-child creation, child abort/promotion, questions | Add managed children; reply/reject questions |
| Agent controls | Auto permissions, permission requests, reminders, workflows | Toggle auto approval; resolve permission |
| Tools and policy | MCP, catalogue, permissions, LSP | Connect/disconnect MCP entries |
| Workspace | Tree, file read, reference validation, changes, commits, worktrees | Read-only fixture; references open the real viewer |
| App preview | Production localhost proxy is replaced by sandboxed \`srcDoc\` | Reload remounts fixture; no localhost request |
| Notifications | Preferences, history, resolve/reopen, test result shapes | Save preferences; resolve/reopen records |
| Planning | Snapshot, labels, details/comments, label replacement, issue creation | Regroup labels; add fixture issues |
| Forge review | Summary, details, comments, reviews, checks, merge response | Simulated merge success only |

### Fixture coverage

- Two projects and root/child sessions covering idle, running, completed, and delegated UI.
- Transcript prose, reasoning, read/bash tools, patch metadata, usage/cost, review URL,
  todos, permission, and question.
- Anthropic/OpenAI model metadata, variants, image capability, MCP failures, LSP state,
  effective permissions, files, references, diffs, and commits.
- Planning issues and pull requests across priorities and states, item details/comments,
  and resolved/unresolved notification records.

### Deliberately not stubbed

- No Express process, OpenCode server, EventSource, filesystem, git command, shell, model
  provider, GitHub API, ntfy, Web Push, or localhost proxy call.
- No production service worker, installable PWA, offline behavior, or persistence across
  reloads.
- Simulated mutation success does not claim server authorization. Directory containment,
  permission policy, upstream contracts, SSE, and BFF failure behavior remain covered by
  the production-BFF suite using \`tests/e2e/mock-opencode.ts\` and
  \`tests/e2e/mock-preview.ts\`.

## Artifact trust boundary

\`scripts/pr-preview.ts\` packages the built site with a manifest containing:

- manifest version;
- positive PR number;
- full lowercase source SHA;
- exact \`/custom-dca-opencode/pr-previews/pr-<number>/\` base path;
- each relative path, byte size, and SHA-256 digest.

Both packaging and deployment reject symbolic links, non-files, duplicate or unsafe paths,
\`.git\`, path traversal, files above 8 MiB, more than 500 files, and bundles above 50 MiB.
The deploy job independently walks the downloaded artifact and checks every declared byte
before granting it a Pages write.

## Close cleanup flow

\`\`\`mermaid
flowchart TD
  Closed[Pull request closed] --> Target[pull_request_target cleanup]
  Target --> Tree[Read current gh-pages tree]
  Tree --> Preview[Delete only pr-previews/pr-N]
  Tree --> Shots[Delete only pr-screenshots/pr-N]
  Preview --> Commit[Create one non-force cleanup commit]
  Shots --> Commit
  Target --> Comments[Delete marker-owned bot comments]
  Target --> Deployments[Mark pr-preview-N deployments inactive]
\`\`\`

The cleanup workflow never checks out or executes pull request code. If a PR never
published a preview or screenshots, absent paths are a no-op.

## Contributor workflow

Every pushed commit triggers the preview automatically. No PR-body opt-in is needed. The
workflow posts or updates one \`<!-- pr-preview -->\` comment after the public URL responds.

Run the same browser check locally:

\`\`\`bash
npx playwright install chromium
npm run test:preview
\`\`\`

Run the artifact boundary tests with the normal unit suite:

\`\`\`bash
npm run typecheck
npm test
npm run build
npm run test:e2e
\`\`\`

For UI changes, also request deterministic screenshots in the PR body as described in
[Contributing](../CONTRIBUTING.md#request-deterministic-ui-screenshots). Interactive
previews and screenshots are complementary: the preview supports exploration, while the
screenshot comment gives reviewers stable desktop/mobile evidence.

## Review checklist

1. Confirm the build job remains read-only and fork publication remains disabled.
2. Confirm new simulator endpoints return the same safe browser-facing shape as the BFF.
3. Confirm no fixture contains credentials, host-specific private data, or live transcripts.
4. Confirm artifact validation remains duplicated across package and deploy boundaries.
5. Confirm Pages writes keep the shared lock, target only the PR directory, and never force.
6. Confirm close cleanup names only PR-owned paths, comments, and deployments.
7. Run \`npm run test:preview\` for routing or simulator changes.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Build fails | Open the \`PR preview / build\` job; run \`npm run test:preview\` locally. |
| Deployment fails before Pages | Check manifest identity/inventory validation and workflow write permissions. |
| Pages action reports no git directory | The deploy job must check out the trusted default branch before invoking the Pages action. |
| Preview URL initially returns 404 | Wait for the workflow's explicit Pages URL probe; it retries before posting success. |
| Assets return 404 | Verify \`PREVIEW_BASE_PATH\` and the Vite \`--base\` value match the PR number. |
| Nested route fails after reload | Preview mode must use \`HashRouter\`; normal mode remains \`BrowserRouter\`. |
| Localhost preview frame fails publicly | Public mode must use the sandboxed fixture \`srcDoc\`, never \`/api/preview/:port\`. |
| New endpoint returns 404 in simulator | Add an explicit bounded fixture response or document why that interaction is unavailable. |
`;export{e as default};
