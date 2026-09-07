const e=`# Architecture

custom-dca-opencode is a host-native web client for one long-lived OpenCode server. It adds a
mobile-friendly interface, notifications, local Git and forge context, and operational controls
without replacing the OpenCode CLI.

## System topology

\`\`\`mermaid
flowchart TD
  Browser[Browser: desktop or phone over Tailscale] -->|same-origin HTTP and SSE| SPA[React 19 + Vite SPA]
  SPA --> BFF[Express BFF]
  BFF --> OpenCode[opencode serve :4096]
  BFF --- Boundary[Credentials, directory validation, SSE fan-out]
  BFF --- Integrations[Local Git, GitHub/GitLab, ntfy, preview proxy]
  OpenCode --- Sessions[One process for every project; sessions use directory]
  OpenCode --- Tools[Agent tools execute on the host user]
\`\`\`

The browser never talks directly to OpenCode or a forge. The BFF is the credential and trust
boundary, and all browser-facing APIs remain same-origin.

## Conversation lifecycle

1. The client selects a project with an absolute \`directory\` query parameter.
2. The BFF canonicalizes that path beneath \`PROJECTS_DIR\` or \`OPENCODE_WORKTREE_ROOT\`.
3. The client creates or opens an OpenCode session scoped to that directory.
4. Before each prompt, the BFF activates the selected Plan or Build policy on the session.
5. The BFF sends the prompt through \`POST /session/{id}/prompt_async\` and returns immediately.
6. OpenCode continues the turn even when every browser disconnects.
7. One upstream \`GET /global/event\` stream is fanned out to browsers and demultiplexed by its
   \`directory\` field.
8. Reconnecting clients refetch session state because the classic event stream has no replay
   cursor.

The blocking \`POST /session/{id}/message\` route is never used by a UI request because it holds
the HTTP connection for the entire agent turn.

## Data boundaries

Raw OpenCode response and event shapes cross the application at two deliberate seams:

- \`server/opencode/client.ts\` is the typed fetch boundary. The live OpenCode \`GET /doc\` response
  is the contract when published documentation or SDK types disagree.
- \`client/lib/events.ts\` converts OpenCode message parts into backend-neutral
  \`TranscriptEvent\` values. Transcript rows do not consume raw OpenCode \`Part\` objects.

That separation keeps transport churn out of the UI and made the migration from the OpenHands
backend an adapter rewrite instead of a transcript rebuild.

## Per-message Plan and Build provenance

A conversation switches between Plan and Build, so "which policy produced this row?" is a
per-message question. The adapter answers it from one message's own metadata and nothing else:
mode is never inherited from a neighbouring row, a parent, or the session's current selection,
because pagination can omit the prompt that set it.

User prompts are classified from an exactly recognized \`info.agent\`. Assistant turns prefer
\`info.mode\` and fall back to that same exact agent, so a recognized mode classifies the row even
when the agent naming it is internal or a sub-agent. An unrecognized \`info.mode\` is only an
unknown label and falls through to the identity; recognized values that disagree yield nothing.
Unclassifiable rows render neutral rather than guessing.

The pill is **provenance, not a policy guarantee**. A child session can report Build while still
carrying a parent's historical Plan denies, so a Build pill never proves the turn could mutate
anything. "What could this turn actually do?" is answered by the sub-agent ledger, not here.

Only user and assistant prose carries the treatment. Thoughts, tool chips, task cards, status
separators and errors belong to the same message but are operational detail, so they stay
unmarked. Each marked row uses an accent rail plus a text pill whose accessible name states
\`Message mode: Plan\` or \`Message mode: Build\`, so the meaning never depends on colour. Message
bodies are deliberately left untinted: markdown already uses surface fills for code blocks and
tables, and a second wash underneath them flattens that hierarchy.

## Derived sub-agent state

OpenCode delegates work to child sessions but exposes no durable background-job API, so
"what are this session's sub-agents doing?" is computed rather than read.
\`server/opencode/subagents.ts\` reconciles the child list, the parent's delegating task parts,
the process-local status map, and each child's own transcript into one ledger keyed by child
session id.

Each row reports the evidence behind its state, because the strength of those sources differs
sharply. A child's own final turn is first-hand; a task part in the parent is not. A background
task part reports \`completed\` as soon as the launch call returns, which is usually long before
the child finishes, so it is never treated as terminal. When nothing settles a child — it was
cancelled, or the owning server restarted — the row is \`unknown\` and says what was checked,
rather than presenting a plausible guess as fact.

## State ownership

| State | Owner | Persistence |
|---|---|---|
| Sessions, messages, todos, sharing | OpenCode | OpenCode storage |
| Selected project and device preferences | Browser | \`localStorage\` |
| Notification history and resolution | BFF | \`.state/notification-history.json\` |
| Auto-permissions toggle | BFF | Memory only; off after restart |
| Git worktrees and repository state | Host | Local filesystem and Git |
| Global event subscriptions | BFF | Process lifetime |
| Sub-agent state | BFF | Derived per request; never stored |

## Safety boundary

OpenCode tools run directly on the host as the user running \`opencode serve\`; there is no
container boundary around the agent runtime. The primary guardrail is the permission policy
in \`opencode.jsonc\`. Permission matching is last-match-wins, so broad rules come before
specific overrides. The optional end-to-end test container described below does not change
this: it isolates test state, and it is never in the path of a real agent session.

The BFF adds narrower boundaries around browser-controlled input:

- Workspace paths are canonicalized beneath configured roots before filesystem access.
- OpenCode and forge credentials remain server-side.
- The preview proxy accepts only explicitly allowlisted localhost ports and strips sensitive
  request headers.
- Plan/Build policy activation and prompt submission are serialized per directory and session.
- Unknown event types are tolerated because the global stream contains events outside the
  typed client union.

## Extension map

| Change | Start here | Preserve |
|---|---|---|
| OpenCode endpoint or payload | \`server/opencode/client.ts\` | Directory scoping and the live \`/doc\` contract |
| Transcript rendering | \`client/lib/events.ts\` | Backend-neutral \`TranscriptEvent\` rows |
| New BFF route | \`server/routes/\` | Credential isolation and path validation |
| New page or primitive | \`client/pages/\`, \`client/ds/\` | Semantic tokens and deterministic test IDs |
| Notifications | \`server/notifications.ts\`, \`client/lib/useNotificationCenter.tsx\` | Manual-only resolution semantics |
| Sub-agent state or controls | \`server/opencode/subagents.ts\` | Evidence precedence and honest \`unknown\` rows |
| Preview behavior | \`server/preview.ts\` | Port allowlist and stripped credentials |
| Deployment | \`deploy/README.md\`, \`scripts/launchd.ts\` | One supervised BFF and one existing OpenCode server |

## Verification architecture

Vitest covers pure behavior in a Node environment. Playwright builds the production SPA and BFF,
then runs them against deterministic OpenCode, forge, and preview mocks. End-to-end tests require
no live agent, model, or credentials.

\`\`\`bash
npm run typecheck
npm test
npm run build
npm run test:e2e
\`\`\`

Those commands are host-native and remain the default. They also write machine-global state:
the \`/tmp/mock-*\` fixtures, their real \`.git\` directories, and fixed ports 3410, 4599 and 4600.
A separate worktree isolates source and dependencies but none of that, so two simultaneous
end-to-end runs can race on one Git index.

An optional container lane closes that gap by giving one Playwright invocation its own
filesystem, PID and network namespace. The fixed paths and ports are deliberately unchanged
inside the container, which is why no spec needed migrating.

\`\`\`text
host worktree
|-- npm run test:e2e            # host lane, shared /tmp + fixed ports
|-- npm run test:contract:host  # macOS-only contracts a container cannot prove
\`-- npm run test:e2e:docker
      |
      v
    scripts/e2e-docker.ts                     trusted host launcher
      |  sanitized snapshot (.dockerignore allowlist: no .git/.env/.state)
      v
    Dockerfile.e2e image                      npm ci + Chromium layers cached
      |
      v
    disposable container                      no mounts, no published ports,
      |                                       --network none, --cap-drop ALL,
      |                                       no-new-privileges, uid 1000
      |-- /tmp/mock-*        private fixtures and private .git
      |-- 3410/4599/4600     private BFF + mock OpenCode + mock forge
      \`-- /artifacts         test-results/ playwright-report/ logs/
            |
            |  docker cp from the STOPPED container, then host-side validation
            v
    docker-e2e-artifacts/<run-id>/            symlinks refused, size-bounded
\`\`\`

Three properties are load-bearing. The container receives no Docker socket, host home,
credentials, writable source or writable artifact mount, so artifacts are copied out of the
stopped container and validated on the host rather than written into it. Cleanup names one
generated container and one generated image tag, never a path derived from test output.
And the lane is a state-isolation boundary, not a security sandbox — a pull request can edit
the Dockerfile and the launcher, so untrusted code needs a trusted launcher from outside the
checkout under test.

Docker does not replace two things. Same-run cross-spec races are unaffected, because one
container still hosts one BFF and one mock for every parallel spec file; that is what
\`tests/e2e-shared-state-ownership.test.ts\` guards. And a Linux container cannot demonstrate
macOS \`/tmp\` → \`/private/tmp\` canonicalization, real symlink containment, the host \`git\`
integration or \`0600\` state-file modes, which is why \`tests/host-contract.test.ts\` stays
host-native.

See [Contributing](../CONTRIBUTING.md), the [OpenCode API audit](opencode-1.18.21-api-audit.md),
and the [architecture research](research/README.md) for the workflow and evidence behind these
boundaries.
`;export{e as default};
