import{f as _,r as w,j as e,h as V,C as G,M as Q,i as D,k as Y,g as K,l as X,X as Z,A as R}from"./index-DU1qK0UF.js";import{s as i,u as J,P as W,a as ee}from"./Playbooks-CRm7h5Zi.js";/**
 * @license lucide-react v1.33.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const ne=[["rect",{width:"14",height:"14",x:"8",y:"8",rx:"2",ry:"2",key:"17jyea"}],["path",{d:"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",key:"zix9uf"}]],te=_("copy",ne);/**
 * @license lucide-react v1.33.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const se=[["rect",{x:"14",y:"3",width:"5",height:"18",rx:"1",key:"kaeet6"}],["rect",{x:"5",y:"3",width:"5",height:"18",rx:"1",key:"1wsw3u"}]],ae=_("pause",se);/**
 * @license lucide-react v1.33.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const ie=[["path",{d:"M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z",key:"10ikf1"}]],oe=_("play",ie);/**
 * @license lucide-react v1.33.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const re=[["path",{d:"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8",key:"1357e3"}],["path",{d:"M3 3v5h5",key:"1xhq8a"}]],le=_("rotate-ccw",re);function M({value:n,label:s="text"}){const[t,a]=w.useState(!1),[d,c]=w.useState(!1);return e.jsxs(V,{"aria-label":`Copy ${s}`,"data-testid":"opencode-playbook-copy",onClick:()=>{navigator.clipboard.writeText(n).then(()=>{a(!0),c(!1),window.setTimeout(()=>a(!1),1500)}).catch(()=>c(!0))},size:"sm",type:"button",variant:"ghost",children:[t?e.jsx(G,{"aria-hidden":"true",size:14}):e.jsx(te,{"aria-hidden":"true",size:14}),e.jsx("span",{className:"ml-1",children:t?"Copied":d?"Copy unavailable":"Copy"})]})}const de=3e3,ce=[.5,1,2,4];function he(n){return de/n}function S(n,s){return Math.min(n+1,Math.max(s-1,0))}function ue(n){return Math.max(n-1,0)}function C(){return typeof window.matchMedia=="function"&&window.matchMedia("(prefers-reduced-motion: reduce)").matches}function F({simulation:n,sourceHref:s,sourcePath:t}){const[a,d]=w.useState(0),[c,l]=w.useState(1),[h,o]=w.useState(C),[u,m]=w.useState(()=>!C()&&n.turns.length>1);w.useEffect(()=>{var k;const r=(k=window.matchMedia)==null?void 0:k.call(window,"(prefers-reduced-motion: reduce)");if(!r)return;const p=b=>{o(b.matches),b.matches&&m(!1)};return r.addEventListener("change",p),()=>r.removeEventListener("change",p)},[]),w.useEffect(()=>{if(!u||h||a>=n.turns.length-1)return;const r=window.setTimeout(()=>{const p=S(a,n.turns.length);d(p),p>=n.turns.length-1&&m(!1)},he(c));return()=>window.clearTimeout(r)},[a,u,h,n.turns.length,c]);const g=r=>{m(!1),d(r)},v=`frame ${a+1} of ${n.turns.length}`;return e.jsxs("section",{className:i.terminal,"aria-label":"Simulation playback","data-testid":"opencode-playbook-simulation",children:[e.jsxs("div",{className:i.terminalBar,children:[e.jsx("i",{className:i.light}),e.jsx("i",{className:i.light}),e.jsx("i",{className:i.light}),e.jsx("span",{className:i.terminalPath,children:t}),e.jsx("a",{className:i.terminalSource,href:s,rel:"noreferrer",target:"_blank",children:"source"})]}),e.jsxs("div",{className:i.terminalControls,"data-testid":"opencode-playbook-simulation-controls",children:[e.jsxs("button",{"aria-label":u?"Pause simulation":"Play simulation",className:`${i.terminalButton} ${i.terminalButtonPrimary}`,"data-testid":"opencode-playbook-simulation-play",disabled:h||a>=n.turns.length-1,onClick:()=>m(r=>!r),type:"button",children:[u?e.jsx(ae,{"aria-hidden":"true",size:12}):e.jsx(oe,{"aria-hidden":"true",size:12})," ",u?"Pause":"Play"]}),e.jsxs("button",{"aria-label":"Reset simulation",className:i.terminalButton,"data-testid":"opencode-playbook-simulation-reset",disabled:a===0,onClick:()=>g(0),type:"button",children:[e.jsx(le,{"aria-hidden":"true",size:11})," Reset"]}),e.jsx("button",{"aria-label":"Previous frame",className:i.terminalButton,"data-testid":"opencode-playbook-simulation-previous",disabled:a===0,onClick:()=>g(ue(a)),type:"button",children:"‹ Previous"}),e.jsx("button",{"aria-label":"Next frame",className:i.terminalButton,"data-testid":"opencode-playbook-simulation-next",disabled:a>=n.turns.length-1,onClick:()=>g(S(a,n.turns.length)),type:"button",children:"Next ›"}),e.jsxs("label",{className:i.terminalStatus,children:["speed ",e.jsx("select",{"aria-label":"Playback speed","data-testid":"opencode-playbook-simulation-speed",onChange:r=>l(Number(r.target.value)),value:c,children:ce.map(r=>e.jsxs("option",{value:r,children:[r,"x"]},r))})]}),e.jsx("span",{"aria-live":"polite",className:i.terminalStatus,"data-testid":"opencode-playbook-simulation-status",children:h?"autoplay off":v})]}),e.jsx("progress",{"aria-label":"Simulation playback progress",className:i.progress,"data-testid":"opencode-playbook-simulation-progress",max:n.turns.length-1,value:a}),e.jsx("ol",{className:i.terminalTurns,children:n.turns.slice(0,a+1).map((r,p)=>e.jsxs("li",{className:`${i.turn} ${r.role==="assistant"?i.turnAssistant:r.role==="tool"?i.turnTool:r.role==="note"?i.turnNote:""}`,children:[e.jsxs("p",{className:i.turnRole,children:[r.role,r.label?` / ${r.label}`:""]}),e.jsx(Q,{source:r.body})]},`${r.role}-${p}`))}),e.jsxs("p",{className:i.terminalCaveat,children:[e.jsx("strong",{children:"Caveat:"})," ",n.caveat]})]})}const pe=`---
title: A root worker is launched and observed without cmux
trigger: dca
caveat: >-
  Authentication is omitted because the example deployment is explicitly a
  private unauthenticated BFF. Poll payloads are shortened to one message.
---

# Worked example

## user

**Workflow — Operate DCA sessions over the BFF API**

start a read-only root worker to inspect the export tests

## assistant

I will use the DCA BFF directly. This shell has \`DCA_BASE_URL\` set to the
deployment's private Tailscale origin; I will verify that route rather than
assuming loopback or cmux access.

## tool — bash

\`\`\`
$ curl -sS --fail-with-body "$DCA_BASE_URL/api/health" | jq .
{
  "healthy": true,
  "upstream": {"reachable": true, "versionMatches": true},
  "events": {"connected": true}
}
$ curl -sS --fail-with-body -X POST "$DCA_BASE_URL/api/sessions" \\
    -H 'Content-Type: application/json' \\
    -d '{"directory":"/srv/app","title":"Export test audit","prompt":"Inspect export tests read-only and report findings with file lines.","mode":"plan"}'
{"session":{"id":"ses_audit_42","title":"Export test audit"}}
\`\`\`

## assistant

The root session is \`ses_audit_42\`. Creation accepted its initial prompt; that
does not prove the turn finished, so I am polling its messages.

## tool — bash

\`\`\`
$ curl -sS --fail-with-body --get \\
    "$DCA_BASE_URL/api/sessions/ses_audit_42/messages" \\
    --data-urlencode 'directory=/srv/app' --data-urlencode 'limit=100' | jq .
{"messages":[{"info":{"role":"assistant","time":{"completed":1788031234000}},"parts":[{"type":"text","text":"Found two uncovered branches..."}]}],"nextCursor":null,"running":false}
\`\`\`

## assistant

The submitted turn now has a completed assistant message and the session is not
running. The audit found two uncovered branches and made no file changes. I used
a root because no parent accounting was requested; a Managed Child would be the
correct route if this work needed to appear under an existing parent.

## note

The example checks the BFF, upstream, and event stream separately, and it treats
session creation as acceptance rather than completion. cmux is absent because it
is not required for the lifecycle being demonstrated.
`,me=`---
title: An unbuilt proposal becomes a durable dated document
trigger: design-doc-prototype
caveat: >-
  The HTML mockup and the design document are abbreviated. This workflow is for
  proposals that are NOT yet built; reviewing shipped work uses the ephemeral
  recipe in CONTRIBUTING.md instead.
---

# Worked example

## user

**Workflow — Capture a Durable Design Prototype**

Sent with no argument.

## assistant

No fields to fill in. The subject is the proposal under discussion above: adding
a simulation player to each workflow's detail page.

This is not built yet, so the durable path is correct. If it were already
shipped I would use the ephemeral recipe instead and commit nothing.

## tool — bash

\`\`\`
$ cat > design/2026-08-30-simulation-player/mockup.html
  (self-contained, no framework, using the app's real token values)
\`\`\`

## note

Real token values rather than generic greys. A wireframe in placeholder colours
invites feedback about the colours instead of about the design.

## tool — bash

\`\`\`
$ npx playwright@1.62.1 screenshot --browser=chromium \\
    --viewport-size=1280,800 file://$PWD/design/.../mockup.html desktop.png
$ npx playwright@1.62.1 screenshot --browser=chromium \\
    --viewport-size=390,740 file://$PWD/design/.../mockup.html mobile.png
\`\`\`

## tool — bash

\`\`\`
$ git push -u origin design/simulation-player
  branch published
\`\`\`

## assistant

Committed the HTML and both PNGs to \`design/\` on a real pushed branch, so the
raw.githubusercontent.com URLs are permanent rather than pointing at a local
file that disappears.

The dated document embeds both screenshots and states plainly that this is a
proposal, not a description of current behaviour — the failure mode for design
documents is being read later as a record of what exists.
`,ge=`---
title: A README diagram rendered before it ships
trigger: docs-preview
caveat: >-
  The Mermaid source is shortened and parses first try. Real documentation work
  usually spends more time matching house style and iterating on render errors.
---

# Worked example

## user

**Workflow — Choose, render, and preview documentation**

add an ingest pipeline diagram to the README

## assistant

The reader opens this on GitHub, so Mermaid is the right medium: native render,
diffable source. \`docs/architecture.md\` already uses \`graph LR\` with no theme
directive, so I will match it.

## tool — mermaid renderer

\`\`\`
graph LR
  webhook --> queue --> normaliser --> warehouse
  normaliser -. retry .-> queue

render: success
\`\`\`

## tool — cmux markdown

\`\`\`
opened README.md in live preview
\`\`\`

## assistant

Rendered and checked: four nodes run left-to-right, the retry edge returns to
the queue, and the fence is a diagram rather than source text. The five-attempt
retry ceiling remains cited prose below it (\`server/queue/worker.ts:31\`) because
a number inside an image rots silently.

## note

The renderer and preview are the guard. Hand-writing Mermaid and saying "it
should render" is precisely the failure the command exists to prevent.

If this were a static docs site, the command would first prove that site's
plugin chain supports Mermaid instead of assuming GitHub behavior carries over.
`,fe=`---
title: A long objective survives an assumption and a failed check
trigger: goal
caveat: >-
  Repository discovery, several implementation edits, and broad test output are
  abbreviated. The checkpoint updates represent boundaries across a longer run.
---

# Worked example

## user

**Workflow — Complete an objective autonomously**

finish CSV export, including tests and the empty state

## assistant

I found no repository-owned plan artifact, so I created
\`/Users/you/.local/state/opencode-goals/app-csv-export.md\` and mirrored its queue
in the session todo list.
The objective is complete when export escapes cells, preserves column order,
handles zero rows, and passes focused plus full verification.

Assumption A1: an empty result should download a header-only CSV. That is
reversible, matches the existing JSON export's stable schema, and needs no
security or destructive authorization, so I recorded it and continued.

## tool — bash

\`\`\`
$ npm test -- tests/csv-export.test.ts
Tests  8 passed, 1 failed
FAIL empty export: expected "name,email\\n", received ""
\`\`\`

## assistant

The failure confirms the empty-state path bypasses the serializer. I updated the
checkpoint with the failure, fixed that path, and continued without asking for
permission to retry.

## tool — bash

\`\`\`
$ npm test -- tests/csv-export.test.ts
Tests  9 passed
$ npm run typecheck
typecheck passed
$ npm test
Tests  247 passed
$ git status --short
 M src/export/csv.ts
 M tests/csv-export.test.ts
\`\`\`

## assistant

Objective complete. The durable checkpoint is marked completed with the exact
commands above and restart state \`none\`.

- Acceptance criteria: 4/4 met
- Assumptions: A1, header-only empty export, implemented and documented
- Verification: focused 9/9, typecheck green, full suite 247/247
- Final diff: only the serializer and its focused test
- Remaining risk: spreadsheet formula interpretation is unchanged and outside
  this objective
- Local state: two modified files, not committed because no commit was requested

## note

The agent made a reversible product guess and documented it. It did not ask
"should I fix the test?" after a normal failure, and it did not confuse passing
the focused test with final completion.
`,we=`---
title: A red but recoverable run is pushed and labelled honestly
trigger: leaving-now-wrap-up
caveat: >-
  The repository inspection, secret scan, status write, and remote reread are
  compressed. The example shows one owned process and one unrelated dirty file.
---

# Worked example

## user

**Workflow — Wrap up and leave an accurate status**

post what you have to the current pull request

## assistant

I am stopping only work this run owns, then I will preserve and report the
current state. I will not include the pre-existing \`.env.local\` change.

## tool — bash

\`\`\`
$ kill 48120 && wait 48120
owned Playwright PID 48120 stopped
$ git status --short
 M .env.local
?? src/retry-policy.ts
?? tests/retry-policy.test.ts
$ npm test -- tests/retry-policy.test.ts
1 failed, 7 passed
failure: retry deadline is exceeded by 4 ms
\`\`\`

## assistant

The focused test is red, but the two owned files are useful progress and the
user authorized a push. I am staging only those files; \`.env.local\` remains
untouched.

## tool — bash

\`\`\`
$ git add src/retry-policy.ts tests/retry-policy.test.ts
$ git commit -m "wip: add bounded retry policy"
[feat/retry-policy 31b87da] wip: add bounded retry policy
$ git push -u origin feat/retry-policy
$ date -u +%Y-%m-%dT%H:%M:%SZ
2026-08-29T20:14:05Z
$ gh pr view 412 --json url,headRefName,statusCheckRollup
https://github.com/acme/app/pull/412
\`\`\`

## assistant

Posted to the current pull request and refreshed \`.agent-status.json\` at
\`2026-08-29T20:14:05Z\`.

- Branch: \`feat/retry-policy\`
- Pushed: \`31b87da\`
- Stopped: owned Playwright PID 48120; unrelated processes were not touched
- Green: 7 focused assertions
- Red: retry deadline assertion exceeds the bound by 4 ms
- Local only: pre-existing \`.env.local\`, intentionally excluded
- Human decision: none; next owner should fix the deadline accounting and rerun
  the full suite

DO NOT MERGE: required focused verification is red.

## note

The command does not equate "wrap up" with "make the tree clean." It preserves
owned progress while leaving an unrelated local file alone, and it derives the
merge verdict from the reread remote state rather than from an earlier snapshot.
`,be=`---
title: A read-only child reports back in its own transcript
trigger: managed-child
caveat: >-
  The child's own investigation is abbreviated. No task card appears in the
  parent and no hand-back message is injected; the human reads the result here.
---

# Worked example

## user

**Workflow — Launch a Managed Child**

Agent: explore (read-only). Model: inherited from the composer.

Assignment: audit how export errors are surfaced in the transcript and report
what a user actually sees when an export fails.

## note

Explore is read-only, so no authorization step appeared. Choosing an agent whose
access is \`can-modify\` resets consent and requires an explicit confirmation
before the launch button enables.

## assistant

Launched. The child has its own transcript and a policy fixed at creation time.
It is not a native task delegation: there is no task card in the parent, and no
automatic hand-back will arrive when it finishes.

## tool — bash

\`\`\`
POST /api/sessions/ses_parent/managed-children
  201  { "id": "ses_child_4a1f", "origin": "managed", "agent": "explore" }
\`\`\`

## note

The child's persisted title is derived from the assignment and is redacted
before truncation, so a credential-shaped token in the assignment cannot survive
into session summaries. The assignment text itself is delivered verbatim.

## assistant

The child finished in its own transcript. Because nothing hands back
automatically, I read it and am summarising here.

It found three paths that surface an export failure and one that does not: a
network abort during streaming clears the progress row without writing an error,
so the user sees the export simply vanish.

## note

The child stayed read-only throughout, so this is a report and not a fix. Acting
on it needs a separate Build session.
`,ye=`---
title: File-viewer mini design doc quality example
trigger: mini-design-doc
caveat: >-
  This verbatim issue-supplied quality example predates the implemented command;
  its cited paths and product choices are illustrative, not re-verified here.
---

# Worked example

## user

**Workflow — Write a mini design doc**

propose direct transcript-to-file navigation

## assistant

oday

Transcript message                  Workspace drawer
-----------------                  ----------------
"See scripts/launchd.ts:222"        Files | Changes | Preview
        |                                  |
        v                                  v
Rendered as plain inline code         Flat folder listing
                                      |
                                      v
                                      Plain <pre> file content
Result: the human must manually:
1. Open Workspace
2. Browse to scripts/
3. Select launchd.ts
4. Find line 222

Structured file attachments are slightly better, but still inert:

OpenCode file part
       |
       v
Attachment chip: [ paperclip launchd.ts ]
       |
       v
Not clickable
Proposed Experience

Transcript message
------------------
"See [scripts/launchd.ts:222]"
click
          |
          v
+--------------------------------------------------------------+
| Workspace drawer                                       Close |
| Files | Changes | Preview                                    |
+------------------------+-------------------------------------+
| Filter files...        | scripts / launchd.ts                |
|                        | [launchd.ts] [dev.sh]               |
| v scripts              |-------------------------------------|
|   - dev-preflight.ts   | 218 | ...                            |
|   - dev.sh             | 219 | ...                            |
|   - launchd.ts   M     | 220 | ...                            |
|                         | 221 | ...                            |
|                         |>222 | const DEFAULT_PORT = 3210;    |
| v client               | 223 | ...                            |
+------------------------+-------------------------------------+


The drawer opens, the file loads, and line 222 receives a
temporary highlight.

The transcript remains where it was. The drawer is still temporary, as you chose.

Click Flow

Assistant response
       |
       | contains:
       | \`scripts/launchd.ts:222\`
       v
Markdown/file-reference parser
       |
       | Is this an allowed workspace-relative path?
       v
BFF validates it
       |
       | rejects: ../secrets, .env, ignored files,
       |          symlink escapes, absolute paths
       v
Render an accessible file button
       |
       | user clicks
       v
Conversation state sets:
{ path: "scripts/launchd.ts", startLine: 222 }
       |
       v
Workspace drawer:
opens Files tab
expands scripts/
selects launchd.ts
loads content
scrolls to and highlights line 222
Reference Rules

Safe and supported
------------------
\`client/pages/Conversation.tsx:724\`
\`server/routes/workspace.ts:20-40\`
\`client/ds/markdown.tsx#L150-L176\`
[Open viewer](file:client/components/workspace-panels.tsx#L15)
Not automatically linked
-------------------------
client/pages/Conversation.tsx:724   <- ordinary prose
/etc/passwd                          <- absolute path
../../secret                         <- traversal
file:///private/key                  <- arbitrary local URL
\`something-that-is-not-a-file\`      <- fails validation

This avoids turning every code-formatted word into a misleading or unsafe link.

Viewer Choice

Option                  Mobile   Lines/Search   Size/Complexity   Decision
----------------------  -------  -------------  ----------------  --------
Plain <pre>             Yes      No             Tiny              Replace
Shiki/Refractor         Yes      Partial        Small             Not enough
Monaco / VS Code editor No       Yes            Large/workers     Reject
Theia / OpenVSCode      Mixed    Yes            Entire platform   Reject
CodeMirror 6            Yes      Yes            Modular           Use
CodeMirror 6 gives us a read-only code-reading surface:

+ syntax highlighting
+ line-number gutter
+ Cmd/Ctrl+F search
+ copy and text selection
+ programmatic jump to a line/range
+ large-file viewport rendering
+ mobile support
no need to become a text editor
Why Not Embed Another App

Current application
Browser -> React SPA -> Express BFF -> OpenCode server
Embedding Theia/OpenVSCode
Browser -> React SPA -> embedded IDE -> extra backend/process
                    \\-> Express BFF -> OpenCode server


More infrastructure, security surface, and competing workspace state.

Instead, borrow proven interaction patterns from OpenCode upstream:

OpenCode upstream concepts        This drawer
--------------------------        ----------------------------
Recursive tree                    Recursive tree
Active file row                   Active file row
Changed M/A/D markers             Changed M/A/D markers
File tabs                         File tabs
Path filter                       Path filter
Breadcrumb navigation             Breadcrumb navigation
Do not import its SolidJS UI or its whole application state.

Scope Split

Now: file inspection
--------------------
Transcript links -> file/line
Recursive tree
Tabs + breadcrumbs
Read-only CodeMirror viewer
Search/copy/line highlighting
Mobile Tree -> File flow
Later GitHub issue: change review
---------------------------------
Richer working-tree UI
Split/hunk diffs
Turn-specific change navigation
Review-oriented interactions

The core product idea is: the agent cites a file, and the workspace drawer makes that citation immediately inspectable.

## note

The response above is reproduced verbatim from issue #142 as the required
quality example. The command itself carries the reusable constraints so this
large example is not submitted on every invocation.
`,ve=`---
title: A focused pass finds one real regression and one false alarm
trigger: playwright-ui-review
caveat: >-
  Server startup and browser boot are abbreviated. The screenshot paths are
  illustrative; a real run writes them under the repository's ignored output
  directory.
---

# Worked example

## user

**Workflow — Review a UI change with Playwright**

Route \`/playbooks\`, dark mode, desktop and mobile. Check the reminder cards
render beside the workflow cards and nothing overflows on a phone.

## assistant

Scope is one route and two viewports, so I am starting the deterministic mock
stack rather than a full deployment. That is the smaller thing that answers the
question.

## tool — bash

\`\`\`
$ PORT=3531 MOCK_OPENCODE_PORT=4732 npm run dev:mock &
  ready on http://127.0.0.1:3531
\`\`\`

## tool — playwright

\`\`\`
await page.goto("http://127.0.0.1:3531/playbooks");
await expect(page.getByTestId("opencode-playbook-workflow-card")).toHaveCount(14);
await expect(page.getByTestId("opencode-playbook-reminder-card")).toHaveCount(12);
  ✓ both catalogues render

await page.setViewportSize({ width: 390, height: 740 });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth);
  → 411   ✗ expected <= 390
\`\`\`

## assistant

One real finding. At 390px the page scrolls horizontally by 21px. I narrowed it
to the card tag row rather than the grid itself: long tags do not wrap.

## tool — playwright

\`\`\`
await page.getByTestId("opencode-playbook-reminder-tags").first().evaluate(
  (n) => getComputedStyle(n).flexWrap);
  → "wrap"

await page.getByTestId("opencode-playbook-reminder-card").first().evaluate(
  (n) => n.getBoundingClientRect().width);
  → 411
\`\`\`

## note

The wrap rule is present, so the tag row is not the cause. The card itself is
wider than the viewport. I withdrew the first diagnosis rather than reporting it
and moving on.

## assistant

Corrected: the grid's \`minmax(0, 1fr)\` is applied to the outer container but the
card sets a \`min-width\` that survives it. Evidence written to
\`screenshot-output/playbooks-390.png\` and \`playbooks-1280.png\`.

Verified: 14 workflow cards, 12 reminder cards, no dark-mode contrast failures.
Failed: horizontal overflow of 21px at 390px, caused by the card min-width, not
the tag row. I did not regenerate the full screenshot set — only the two views
this scope named.
`,ke=`---
title: A review that reorders itself away from file order
trigger: pr-snippet-review
caveat: >-
  The diff reading and several intermediate snippets are abbreviated. The
  comment is posted once; this workflow never posts partial drafts.
---

# Worked example

## user

**Workflow — Post a snippet-by-snippet PR review**

341

## assistant

Only a number was supplied, which is the only input this workflow takes. The
repository comes from this session's project directory, not from the prompt.

## tool — bash

\`\`\`
$ gh pr view 341 --json headRefOid,title,files
  headRefOid: 9f2c1ab4d7e0c8b35a61f0d2e4c79b8a3d5e6f12
  title: Serve the reminder body from /api/reminders
  files: 6 changed
\`\`\`

## assistant

Pinning every link to \`9f2c1ab\` so line references cannot drift when the branch
moves.

Reading order is not file order here. The change rests on one claim — that
withholding the body was never what protected it — so the review has to start
with the resolution path that makes that true, or every later snippet looks
like a straightforward information leak.

## tool — bash

\`\`\`
$ gh pr diff 341 | head -40
  server/routes/reminders.ts   | +12 -4
  client/lib/api.ts            | +7  -0
  tests/e2e/smoke.api.spec.ts  | +21 -12
\`\`\`

## assistant

Step 1 is \`server/opencode/sessions.ts\`, which is not in the diff at all: it is
where a send resolves the reminder from its id. Step 2 is the projection change.
Step 3 is the test that used to assert the opposite.

## tool — bash

\`\`\`
$ gh pr comment 341 -F -
  https://github.com/leoncheng57/custom-dca-opencode/pull/341#issuecomment-...
\`\`\`

## assistant

Posted as one comment, six steps.

Riskiest snippet: the projection now spreads \`body\` into the response. If a
future field is added to \`ReminderPreset\` it will ride along silently, because
the projection lists fields to include rather than to exclude.

Not verified by this change: that no other caller assumed \`body\` was absent.
I checked the client and the tests, not any external consumer.
`,xe=`---
title: A Plan session launched with explicit settings
trigger: session-handoff
caveat: >-
  The process check proves requested flags, not provider acceptance. A real
  handoff also waits for the child to restate its packet before declaring success.
---

# Worked example

## user

**Workflow — Hand off to another session**

inspect the playback timer in Plan mode with GPT Sol high effort

## assistant

This is a fresh interactive session, not a fork and not a subagent. I wrote a
packet outside the worktree with the absolute path, branch, read-only objective,
owned files, forbidden edits, verification expectations, and stop condition.

Exact launch:

\`\`\`
opencode /Users/you/src/app \\
  --agent plan \\
  --model openai/gpt-5.6-sol \\
  --prompt "$(cat /Users/you/src/app.worktrees/prompts/playback-review.md)"
\`\`\`

The interactive TUI has no \`--variant\` flag, so "high effort" is marked
UNVERIFIED rather than smuggled in as prompt prose. If provider-specific effort
is required, use \`opencode run --variant high\` instead.

## tool — process check

\`\`\`
requested: --agent plan --model openai/gpt-5.6-sol
working directory: /Users/you/src/app
\`\`\`

## assistant

The child is running with the requested agent, model, and directory. I am not
reviewing those files in this parent session. I will wait for its report.

## note

Nothing was inherited. Plan mode and model came from CLI flags; context came
from the packet. The missing effort flag remains visible instead of being
claimed.

The parent stops rather than duplicating the child's review.
`,Te=`---
title: An update arrives in a session that had moved on
trigger: session-update
caveat: >-
  The target search is abbreviated to one match. Delivery is asynchronous, so a
  204 means accepted, never completed.
---

# Worked example

## user

**Workflow — Send an update to another session**

Target: "Notification centre grouping" (ses_9d4b).

Message: the badge count must exclude suppressed records — auto-permissions and
subagent both. Confirmed against \`activeCount()\`.

## assistant

Preview shows the exact target and the exact prompt before anything is sent.
Nothing has been delivered yet.

## note

The update sends in the TARGET session's current mode, not this one's. A
hardcoded Build would restore write access to a session someone deliberately
left in Plan.

## tool — bash

\`\`\`
POST /api/sessions/ses_9d4b/prompt?directory=...
  204 accepted
\`\`\`

## assistant

Accepted, not completed. 204 means the target session received the prompt; it
does not mean the work is done or that anyone is watching that transcript.

## note

The following turn is what the RECEIVING session sees.

## user

the badge count must exclude suppressed records — auto-permissions and subagent
both. Confirmed against \`activeCount()\`.

## assistant

This arrived from another session in the same project, delivered after an
explicit preview there.

Reconciling it with what I am doing: I had already filtered the list but not the
count, which is exactly the mismatch this warns about — a badge counting rows the
user asked not to see. I am applying the same filter to \`activeCount()\` before
continuing.
`,_e=`---
title: A standup with nothing invented
trigger: standup
caveat: >-
  One day of a real log, shortened. The value is in what the command refuses to
  pad, which a busier day would show less clearly.
---

# Worked example

## user

**Workflow — Write today's standup**

Sent with no argument.

## tool — bash

\`\`\`
$ git log --all --author="you@example.com" --since="24 hours ago" --pretty=format:'%h %s' --no-merges
7ed8c02 feat: add simulation playback
779d9c2 feat: add session handoff command
4699eaf feat: add human verification command
$ gh pr list --author "@me" --state open --limit 10
(no open pull requests)
\`\`\`

## assistant

**Yesterday**

- Command pages now play their worked example as a timed transcript instead of a
  wall of text — autoplay, manual stepping, and a speed control.
- Two new commands landed: writing human verification checklists, and handing a
  session off to a fresh one with its settings intact.

**Today**

- Nothing is queued. Next is likely the command catalogue, but that is a guess
  from the direction of the last three commits, not from anything committed.

**Blocked**

- Nothing blocked.

## note

Three commits became two bullets. Nobody wants a commit list read aloud, and the
template asks for themes rather than a transcription.

The "Today" bullet is marked as a guess, because the log genuinely does not
contain it. The "Blocked" section says nothing is blocked rather than
manufacturing something to fill the heading.

This command is small and self-contained. It adds no retrieval context until a
human explicitly invokes it.
`,je=`---
title: An isolated Plan root that has no link to its launcher
trigger: start-dca-session
caveat: >-
  Worktree creation and the new session's own work are abbreviated. Build in an
  existing directory requires an explicit authorization step not shown here.
---

# Worked example

## user

**Workflow — Start a DCA session**

Isolated worktree: yes. Mode: Plan. Model: from the composer.

Assignment: work out whether session status can be joined into the notification
centre without a second fan-out.

## assistant

Isolated and Plan are the defaults, so no authorization step is required. Build
in an existing directory would have demanded one, because that grants write
access to a checkout someone may be using.

## tool — bash

\`\`\`
POST /api/sessions/root
  201  { "id": "ses_root_7c2e",
         "directory": "/Users/you/Projects/app.worktrees/status-join",
         "mode": "plan" }
\`\`\`

## assistant

Created. This is a root session: it has no parent, no task card, no Managed
Child relationship, no automatic hand-back, and no provenance link back to this
session. Nothing about this conversation travels with it.

That is why the assignment has to stand alone. "Continue what we discussed"
would arrive meaningless.

## note

If the create had succeeded but the first prompt had failed, the response would
name the session that still exists and disable retry — so a half-made session is
reported rather than silently duplicated.

## assistant

Open the new session to follow it. It will not report back here.
`,Re=`---
title: Selecting a mixed-state queue review package
trigger: system-design-artifacts
caveat: >-
  The transcript shows package selection and evidence discipline, not the many
  linked files or rendered artifacts that a real requested package would contain.
---

# Worked example

## user

**Workflow — Build a system-design review package**

document the current queue and propose durable replay

## tool — grep

Searched queue ownership, event subscription, persistence, reconnect, and replay
terms in the server, client, tests, and architecture decisions.

## assistant

Mode: \`mixed\`. The current-state and target-state views will be paired, never
combined into one ambiguous diagram.

Decision: reviewers need to decide whether durable replay is justified and where
its watermark belongs.

Evidence ledger:

| Claim | Class | Evidence |
| --- | --- | --- |
| reconnect refetches state | \`code-supported\` | \`client/lib/events.ts:88-112\` |
| classic SSE has no cursor | \`observed\` | live OpenAPI probe, 2026-08-29 |
| fixture replays missed events | \`mock-only\` | \`tests/mock-server.ts:410-438\` |
| a durable watermark closes every gap | \`unknown\` | retention semantics unprobed |

Selected package:

1. System guide: explains current ownership, transport, and why refetch exists.
2. Paired current/target sequence diagrams: isolates the proposed watermark.
3. Ownership matrix: answers who persists cursor, events, and projections.
4. Failure catalogue: disconnect during write, expired cursor, duplicate replay,
   and restart between persistence and delivery.
5. ADR: compares refetch-only, bounded replay, and full event sourcing.
6. Rollout/runbook: shadow watermark, mismatch signal, rollback to refetch.

Omitted: interactive HTML and animation add no review perspective; an OpenAPI
contract is deferred until the target endpoint is chosen.

Review order: system guide -> paired sequences -> ownership matrix -> failure
catalogue -> ADR -> rollout. Every target artifact will carry a \`Proposed\`
banner and link back to the current-state source evidence.

## note

The mock claim remains explicitly mock-only even though it demonstrates the
desired UX. Artifact omissions are deliberate and reviewable rather than silent.
`,Ne=`---
title: A route change shown as a file tree
trigger: ascii-diagrams
caveat: >-
  One of three supported diagram forms. The width check is summarized rather
  than shown running, and a real change set may require several alignment passes.
---

# Worked example

## user

what files change for adding saved filters

*Reminder attached: Draw an ASCII Diagram*

## assistant

\`\`\`
app/
├── server/
│   ├── routes/savedFilters.ts              NEW   CRUD boundary, validates owner
│   └── routes/index.ts                     MOD   + mount route
├── client/issues/
│   ├── SavedFilterPicker.tsx               NEW   keyboard-selectable combobox
│   └── FilterBar.tsx                       MOD   source of truth moves upward
├── db/
│   └── 0044_saved_filters.sql              NEW   owner_id index  <- tenancy boundary
└── test/savedFilters.test.ts               NEW   API + cross-user rejection
\`\`\`

- The status column starts at one offset across the whole tree.
- \`FilterBar.tsx\` names the state-ownership change rather than saying only
  "modified".
- The migration carries the trap inline: omitting \`owner_id\` from the index
  turns a per-user feature into a cross-user leak.
- Widest line: 91 characters, under the 100-column limit.

## note

\`$ARGUMENTS\` supplied both the diagram type and the subject. The command chose
an annotated tree because the question was "what files change"; a data-flow
diagram would add arrows without answering the reviewer's first question.

The one \`<-\` annotation is the deliverable, not decoration. It marks a failure
the file structure cannot show.
`,Se=`---
title: A task refused before it can block
trigger: background-subagent
caveat: >-
  This shows the unavailable-flag branch. A successful run would additionally
  show the task call and returned task_id, then end immediately.
---

# Worked example

## user

audit token expiry in server/auth

*Reminder attached: Delegate in the Background*

## tool — shell interpolation

\`\`\`
OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS
unset
\`\`\`

## assistant

I cannot launch this in the background: the required flag is unset and OpenCode
reads it at startup.

Choose one:

- Restart OpenCode with
  \`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true\`, then run this command again.
- Run the same audit in the foreground now; it will block this session until it
  returns.

I have not started the audit either way.

## note

The guard is visible because shell interpolation ran before the model saw the
command template. Silently dropping \`background: true\` would look successful
until the foreground task blocks — exactly the failure this command prevents.
`,Ce=`---
title: A long migration made durable before wave one
trigger: build-waves
caveat: >-
  Only setup and one wave boundary are shown. A real sustained build continues
  for hours and may compact or change models before final verification.
---

# Worked example

## user

migrate reporting off the legacy schema

*Reminder attached: Build in Verified Waves*

## tool — shell interpolation

\`\`\`
background subagents: available
\`\`\`

## assistant

I wrote \`docs/reporting-migration-plan.md\` and mirrored it in \`todowrite\`:

\`\`\`
wave 0  baseline + schema map       done
wave 1  query layer                 active
wave 2  renderers                   queued
wave 3  API routes                  queued
wave 4  client                      queued
wave 5  final verification          queued
\`\`\`

Wave 5 exists before implementation starts. Each wave owns disjoint files;
shared migrations and the lockfile remain parent-owned.

While I implement wave 1, one read-only background agent is mapping wave 2's
renderer callers. I will reconcile that report at the boundary, verify wave 1,
update both durable records, and continue without asking permission.

## tool — task

\`\`\`
explore, background=true
scope: server/reports/ callers only
forbidden: server/queries/ (parent is editing it)
\`\`\`

## note

The command did not begin by editing. The plan file, queue, ownership boundaries,
and final verification wave are the restart protocol if context compacts.

The shell interpolation made background availability a fact rather than an
assumption; an unavailable flag would produce a sequential run instead of a fake
parallel one.
`,Ee=`---
title: A finding gets a verified line citation
trigger: cite-file-lines
caveat: >-
  One claim, one citation. A longer review would repeat this once per finding.
---

# Worked example

## user

why does an unknown reminder ID get rejected

*Reminder attached: Cite File Lines*

## tool — bash

\`\`\`
$ rg -n "isValidReminderId" server/routes/sessions.ts
118:  if (!isValidReminderId(reminder)) {
119:    return res.status(400).json({ error: "unknown reminder" });
\`\`\`

## assistant

The prompt route rejects an unknown reminder ID with 400 before resolving any
trusted body (\`server/routes/sessions.ts:118-119\`).

## note

The line range came from reading the file, not from guessing at the function
name. The command itself carries the citation-selection and failure rules.
`,Ae=`---
title: Four independent axes, one synthesized answer
trigger: deep-research-subagents
caveat: >-
  Agent prompts and reports are abbreviated. A real very-thorough pass spends
  most of its time reading citations and reconciling conflicting evidence.
---

# Worked example

## user

how ready is this service for multi-tenancy

*Reminder attached: Deep Research with Subagents*

## assistant

This qualifies: four independent unknowns and three unrelated source areas.

Launching concurrently:

1. Database ownership columns and query predicates — \`db/\`, \`server/queries/\`.
2. Session identity and authorization — \`server/auth/\`, no database files.
3. Queues and caches — \`server/queue/\`, \`server/cache/\`, no auth files.
4. Deployment and prior art — \`infra/\`, \`docs/\`, git history, no app source.

Every prompt is read-only, very thorough, requires \`file:line\`, asks what does
not exist, and ends with \`UNVERIFIED:\`.

## tool — task

\`\`\`
4 explore agents launched concurrently
\`\`\`

## assistant

**Answer:** identity is already tenant-aware; enforcement is not. The session
carries \`org_id\` (\`server/auth/session.ts:88\`), but 17 queries omit an
organization predicate. The highest-risk gap is outside SQL: queue and cache
clients share one Redis keyspace with no prefix.

Two reports disagreed about queue isolation. I checked their citations: job
payloads carry an org id, but Redis keys do not, so the cache report is correct.

\`\`\`
UNVERIFIED:
- production rows missing organization_id
- customers relying on cross-organization visibility
\`\`\`

## note

The output is a synthesized answer, not four reports pasted under four headings.
The disagreement was resolved from evidence, and the unverified items stay
visible because either could change the design.
`,Ie=`---
title: A diagram medium chosen for where the reader will open it
trigger: docs-and-diagram-tooling
caveat: >-
  The document itself is abbreviated. The point is the choice of medium and the
  refusal to maintain the same diagram twice.
---

# Worked example

## user

document how a notification becomes a push, for the README and for the
onboarding slides

*Reminder attached: Choose Documentation Visuals*

## assistant

Two surfaces with different rendering, so the medium is not one decision.

The shape is a pipeline with branches — record, suppress or deliver, then fan
out per channel. That is a flow, so it is a diagram rather than a table. A table
would be right for comparing the channels, which is a different question.

## note

GitHub renders Mermaid, so the README can hold the source. Slides do not, so
they need a fixed image.

## assistant

Rather than maintain the same diagram twice, I am keeping ONE Mermaid source in
the README and exporting the SVG for the slides from it. Two hand-maintained
copies drift, and the drift is invisible until someone quotes the stale one.

## tool — bash

\`\`\`
$ npx @mermaid-js/mermaid-cli -i docs/notification-flow.mmd -o docs/notification-flow.svg
  wrote docs/notification-flow.svg
\`\`\`

## assistant

Checked a neighbouring document first and matched its heading depth and its
habit of citing the implementing file under each diagram.

Cited \`server/notifications/service.ts\` for the suppression branch, and stated
the limitation plainly: the diagram shows the delivery decision, not retry or
expiry behaviour, which live elsewhere and would make it unreadable.

Rendered the SVG before claiming it works.
`,Pe=`---
title: Duck rules reasserted after a long session
trigger: duck-mode
caveat: >-
  Two turns cannot demonstrate durability. This remains model-mediated behavior;
  only an output plugin such as the one described by the command can make framing deterministic.
---

# Worked example

## user

*Reminder attached: Duck Mode*

## assistant

🦆🦆🦆

Ducks are on.

🦆🦆🦆

## user

Write the answer into NOTES.md.

## tool — write

\`\`\`
NOTES.md
--------
Ducks are on.
\`\`\`

## assistant

🦆🦆🦆

Written to \`NOTES.md\`.

🦆🦆🦆

## note

The framing appears in the conversation but not in the file. Re-firing the
command late in a long session puts the exact rules back into the current turn;
it does not prove they will survive the next compaction.
`,Oe=`---
title: A frontier of three, then silence
trigger: grill-me
caveat: >-
  Round 1 of four or five. The command routes to the plan agent, so nothing in
  this transcript could have edited a file.
---

# Worked example

## user

the command catalogue design

*Reminder attached: Grill the Design*

## assistant

Three questions on the frontier. Q4 (install instructions) depends on Q2, so it
waits for round 2.

Q1 - **Do commands get a dedicated route as well as the catalogue index?** A
single canonical route is simpler, but \`/playbooks/commands\` makes the content
type explicit in links and leaves room for later Playbook types.

-> Keep both \`/playbooks\` and \`/playbooks/commands\`, rendering one catalogue.

Q2 - **Where do command worked-examples live?** Beside the command is the
obvious answer, but \`commands/\` is a namespace: OpenCode registers every \`.md\`
in it, so a sibling file becomes a bogus slash command.

-> Separate \`command-simulations/\` directory. The alternative pollutes the
user's autocomplete.

Q3 - **Ship Claude Code variants?** Claude Code reads \`.claude/commands/\` with
a different frontmatter dialect.

-> OpenCode only, stated plainly. The catalogue's value is portability, and
pretending commands are portable when the dialects differ is the misleading
move.

## note

The whole frontier goes out in one round, numbered, each with a recommendation.
Q4 is named and deferred rather than asked, because asking a question whose
prerequisite is still open forces a hypothetical answer that settles nothing.

\`agent: plan\` in the frontmatter is what makes this safe to fire mid-session:
the plan agent has edit and bash set to ask, so a grilling cannot quietly start
implementing its own recommendations.

The turn ends here, waiting. That is the command's actual behaviour, and a
transcript that answered its own questions would misrepresent it.
`,De=`---
title: Checks run before the human is asked to look
trigger: human-verification-steps
caveat: >-
  The checklist is trimmed to four steps; a real one runs to eight or ten. This
  fixture repository uses npm, but the command discovers tooling before checks.
---

# Worked example

## user

the playback controls

*Reminder attached: Write Human Verification Steps*

## tool — bash

\`\`\`
$ npm run typecheck
$ npm test
Tests  202 passed (202)
Tests  24 passed (24)
$ npm run build
✓ built in 1.4s
$ git status --short && git diff --stat HEAD
 M src/components/SimulationPanel.tsx      | 118 ++++++--
 M src/components/simulation-panel.module.css | 96 +++++-
\`\`\`

## assistant

All three green, so this is worth a human pass.

**1. Autoplay starts unprompted.** Open \`/s/grill-me\`. The simulation section is
already expanded and frame 1 is showing. Within ~10s a second turn appears with
no interaction. *Failure signal:* nothing moves, or every turn is visible at once.

**2. Assistant text is orange, user text green.** Same page. *Failure signal:*
both the same colour, or code inside an assistant turn is unreadable.

**3. Manual navigation pauses autoplay.** Press Next. The status line reads
\`paused\`. Wait 15s — no further advance. *Failure signal:* it keeps advancing.

**4. Reduced motion does not autoplay.** System Settings → Accessibility →
Reduce motion, reload. Section still open, frame 1 visible, controls still work,
status says autoplay is off. *Failure signal:* frames advance anyway.

\`\`\`
VERIFIED    typecheck, tests, build
UNVERIFIED  everything above — I ran the commands, I did not open a browser
\`\`\`

Disposition: **Blocked on human access** for the visual steps.

## note

The assistant first inspected this repository's instructions, package manifest,
lockfile, CI, and changed tests. Those sources established npm and the three
commands shown above; the portable command did not assume them.

The automation gate remains load-bearing: a red build never reaches a human.

Note the honest split at the end. Running the commands is not the same as
looking at the page, and the report says so rather than claiming a pass.
`,We=`---
title: A child is delegated only after its worktree is ready
trigger: native-worktree-subagents
caveat: >-
  Shows the preflight and launch prompt boundary; the child's own guard output
  and final report are not shown here.
---

# Worked example

## user

fix the notification badge count

*Reminder attached: Native Worktree Subagents*

## tool — bash

\`\`\`
$ git branch --show-current
main
$ git status --short
 M client/pages/Hub.tsx
\`\`\`

## assistant

This parent is a fresh Build-only session, so it can delegate safely. Creating
a sibling worktree at \`../custom-dca-opencode.worktrees/notification-badge\` on
branch \`fix/notification-badge\`, then launching the child with the absolute
worktree path, exclusive ownership of the badge component, the required
\`pwd; git rev-parse --show-toplevel; git status --short --branch\` preflight,
and the exact verification command it must run before committing and pushing.

## note

The command itself carries the inherited Plan-deny risk, containment rules,
parallel-ownership limits, and failure handling; there is no second source to
load or drift.
`,Me=`---
title: Two researched prompts waiting at the checkpoint
trigger: parallel-research-handoff
caveat: >-
  The research reports and prompt bodies are abbreviated. The transcript ends
  before launch because the two human choices are mandatory gates.
---

# Worked example

## user

saved filters and per-project webhook secrets

*Reminder attached: Parallel Research Handoff*

## tool — task

\`\`\`
2 read-only explore agents, launched concurrently
saved filters owns client/issues/ + settings persistence
webhook secrets owns server/webhooks/ + config
\`\`\`

## assistant

Both reports are back. I wrote two prompts outside the worktrees:

\`\`\`
.../prompts/saved-filters.md
.../prompts/webhook-secrets.md
\`\`\`

Each contains \`PRE-RESEARCHED - DO NOT RE-DERIVE\`, settled scope with rationale,
\`GOTCHA:\` lines, numbered files, reasoned exclusions, exact verification, and the
same \`SHARED-RESOURCE RULE\` for ports 8010 and 3210.

Read them before I fire anything. Two decisions:

1. Should the receiving sessions present plans first, or edit immediately?
2. Should they open PRs, or stop at local commits?

## note

The command stops here deliberately. Launching before those answers would turn
a review checkpoint into a notification and advertise autonomy the workflow
explicitly withholds.

The prompt files are outside both worktrees, so neither implementation branch
starts dirty.
`,Fe=`---
title: A prompt written off-context
trigger: session-handoff
caveat: >-
  The generated prompt is abbreviated to its section headers; a real one runs to
  two or three hundred lines. It stops before launching anything.
---

# Worked example

## user

the saved-filters feature

*Reminder attached: Hand Off to a New Session*

## tool — bash

\`\`\`
$ git rev-parse --show-toplevel && git branch --show-current && git status --short
/Users/you/Documents/Projects/app
feat/saved-filters
\`\`\`

## assistant

Written to \`/Users/you/Documents/Projects/app.worktrees/prompts/saved-filters.md\`:

\`\`\`
Branch feat/saved-filters is checked out at <abs path>, deps installed,
typecheck + 214 tests green at baseline.

PRE-RESEARCHED - DO NOT RE-DERIVE:
- Filter state lives in client/issues/FilterBar.tsx:40, useState only.
- NO persistence primitive for per-user UI state exists. You are building
  the first one. Do not go looking for it.

DECIDED: per-user, not per-team. Rationale: no membership table exists yet
(db/schema.sql), so per-team would need one first.

GOTCHA: a setting key absent from server/config/settings.ts:64 is accepted
by the API and silently ignored at runtime.

OUT OF SCOPE (list as follow-ups in the PR body, do not build):
- Sharing a filter with another user - needs the team model.

SHARED-RESOURCE RULE: sibling worktree ../webhook-secrets on branch
feat/webhook-secrets. docker compose binds 8010 and 3210 and bind-mounts
./.state - only ONE worktree may run the stack. Check docker ps first.

Verify: npm run typecheck && npm test && npm run build
\`\`\`

Read it before I launch anything.

## note

\`subtask: true\` in the frontmatter is doing the heavy lifting. Compiling this
prompt means re-reading a lot of the repository, and all of that reading happened
in a subagent — the parent session got back one file path and the finished text
instead of thirty tool results.

That is the strongest argument for this command in a long session: the expensive
part runs somewhere else and never touches the context you are preserving.

The command stops before firing. Showing the prompt is the last cheap moment to
correct scope.
`,$e=/^([|>])([+-]?)(\d*)([+-]?)$/,E=/^(\s*)([A-Za-z0-9_.-]+)\s*:\s?(.*)$/,A=/^(\s*)-\s+(.*)$/;function x(n){return n.length-n.trimStart().length}function T(n,s){if(n.length<2||!n.startsWith(s)||!n.endsWith(s))return!1;const t=n.slice(1,-1);if(s==="'"){for(let a=0;a<t.length;a+=1)if(t[a]==="'"){if(t[a+1]==="'"){a+=1;continue}return!1}return!0}for(let a=0;a<t.length;a+=1){if(t[a]==="\\"){a+=1;continue}if(t[a]==='"')return!1}return!0}function $(n){return T(n,'"')?n.slice(1,-1).replace(/\\(["\\])/g,"$1"):T(n,"'")?n.slice(1,-1).replace(/''/g,"'"):n}function q(n){if(n.startsWith('"')||n.startsWith("'"))return n;const s=n.search(/(^|\s)#/);return s===-1?n:n.slice(0,s)}function I(n){const s=q(n.trim()).trim();return $(s)}function qe(n){const s=q(n.trim()).trim();if(T(s,'"')||T(s,"'"))return $(s);if(s==="true")return!0;if(s==="false")return!1;if(s!==""){const t=Number(s);if(!Number.isNaN(t))return t}return s}function Be(n){let s="",t=0;for(const a of n){if(a===""){t+=1;continue}s===""?s=a:(s+=t>0?`
`.repeat(t):" ",s+=a),t=0}return s}function Le(n,s,t){return t==="strip"?n:t==="keep"?n+`
`.repeat(s+1):n===""?"":`${n}
`}function Ue(n,s,t,a,d){const c=[];let l=s;for(;l+1<n.length;){const r=n[l+1];if(r.trim()===""){c.push(""),l+=1;continue}if(x(r)<=t)break;c.push(r),l+=1}let h=c.length-1;for(;h>=0&&c[h]==="";)h-=1;const o=c.length-1-h,u=c.slice(0,h+1),m=u.reduce((r,p)=>p===""?r:Math.min(r,x(p)),Number.MAX_SAFE_INTEGER),g=u.map(r=>r===""?"":r.slice(Math.min(m,x(r)))),v=a==="|"?g.join(`
`):Be(g);return{value:Le(v,o,d),endIndex:l}}function ze(n){const s=n[2]||n[4];return s==="-"?"strip":s==="+"?"keep":"clip"}function He(n,s){for(let t=s+1;t<n.length;t+=1){const a=n[t];if(!(a.trim()===""||a.trimStart().startsWith("#")))return a}}function Ve(n){return n.replace(/^\uFEFF/,"").replace(/\r\n?/g,`
`)}function Ge(n){const s=Ve(n);if(!/^---[ \t]*(\n|$)/.test(s))return{data:{},content:s};const t=s.split(`
`);let a=-1;for(let u=1;u<t.length;u+=1){const m=t[u];if(m==="---"||m==="..."||/^(---|\.\.\.)[ \t]+$/.test(m)){a=u;break}}if(a===-1)return{data:{},content:s};const d=t.slice(1,a),c=t.slice(a+1).join(`
`),l={};let h=null,o=null;for(let u=0;u<d.length;u+=1){const m=d[u];if(m.trim()===""||m.trimStart().startsWith("#"))continue;const g=m.match(A);if(g&&h){const f=l[h];Array.isArray(f)&&f.push(I(g[2]));continue}const v=m.match(E);if(!v){h=null,o=null;continue}const[,r,p,k]=v,b=r.length>0;if(b&&!o)continue;b||(o=null,h=null);const N=k.trim(),j=N.match($e);if(j){const{value:f,endIndex:H}=Ue(d,u,r.length,j[1],ze(j));u=H,b&&o?l[o][p]=f:l[p]=f;continue}if(N===""){const f=He(d,u);if(f&&A.test(f)&&x(f)>=r.length){l[p]=[],h=p,o=null;continue}if(f&&x(f)>r.length&&E.test(f)){l[p]={},o=p,h=null;continue}b&&o?l[o][p]="":l[p]="";continue}if(b&&o){l[o][p]=I(k);continue}l[p]=qe(k),h=null}return{data:l,content:c}}function Qe(n){return n.replace(/^\s*#\s+.+?(\n+|$)/,"")}const Ye=["user","assistant","tool","note"],Ke=/^##[ \t]+([a-z]+)(?:[ \t]+—[ \t]*(.*))?[ \t]*$/,Xe=/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;function Ze(n){return Ye.includes(n)}function Je(n){const s=[];let t=null,a=null;for(const d of n.split(`
`)){const c=d.match(Xe);if(c){const[,h,o]=c;a===null?a=h:h[0]===a[0]&&h.length>=a.length&&o.trim()===""&&(a=null),t==null||t.lines.push(d);continue}const l=a===null?d.match(Ke):null;if(l){const[,h,o]=l;if(!Ze(h))return null;t={role:h,label:(o==null?void 0:o.trim())||void 0,lines:[]},s.push(t);continue}if(t){t.lines.push(d);continue}if(d.trim()!=="")return null}return s}function en(n){const{data:s,content:t}=Ge(n),a=(s.title??"").trim(),d=(s.trigger??"").trim(),c=(s.caveat??"").trim();if(a===""||d===""||c==="")return null;const l=Je(Qe(t));if(l===null||l.length===0||l[0].role!=="user")return null;const h=l.map(o=>({...o,body:o.lines.join(`
`).trim()})).filter(o=>o.body!=="").map(({role:o,label:u,body:m})=>u===void 0?{role:o,body:m}:{role:o,label:u,body:m});return h.length===0?null:{title:a,trigger:d,caveat:c,turns:h}}function B(n){const s=new Map;for(const[t,a]of Object.entries(n)){const d=t.split("/").filter(Boolean),c=d.length>1?d.at(-2)??"":"",l=c===""?null:en(a);l&&s.set(c,l)}return s}const nn=Object.assign({"../simulations/workflows/dca.md":pe,"../simulations/workflows/design-doc-prototype.md":me,"../simulations/workflows/docs-preview.md":ge,"../simulations/workflows/goal.md":fe,"../simulations/workflows/leaving-now-wrap-up.md":we,"../simulations/workflows/managed-child.md":be,"../simulations/workflows/mini-design-doc.md":ye,"../simulations/workflows/playwright-ui-review.md":ve,"../simulations/workflows/pr-snippet-review.md":ke,"../simulations/workflows/session-handoff.md":xe,"../simulations/workflows/session-update.md":Te,"../simulations/workflows/standup.md":_e,"../simulations/workflows/start-dca-session.md":je,"../simulations/workflows/system-design-artifacts.md":Re}),tn=Object.assign({"../simulations/reminders/ascii-diagrams.md":Ne,"../simulations/reminders/background-subagent.md":Se,"../simulations/reminders/build-waves.md":Ce,"../simulations/reminders/cite-file-lines.md":Ee,"../simulations/reminders/deep-research-subagents.md":Ae,"../simulations/reminders/docs-and-diagram-tooling.md":Ie,"../simulations/reminders/duck-mode.md":Pe,"../simulations/reminders/grill-me.md":Oe,"../simulations/reminders/human-verification-steps.md":De,"../simulations/reminders/native-worktree-subagents.md":We,"../simulations/reminders/parallel-research-handoff.md":Me,"../simulations/reminders/session-handoff.md":Fe});function L(n){return Object.fromEntries(Object.entries(n).map(([s,t])=>{var d;return[`${((d=s.split("/").pop())==null?void 0:d.replace(/\.md$/u,""))??""}/SIMULATION.md`,t]}))}const sn=B(L(nn)),an=B(L(tn));function on(n){return sn.get(n)}function rn(n){return an.get(n)}const P="https://github.com/leoncheng57/custom-dca-opencode",O="main",U={workflow:n=>`${P}/blob/${O}/client/simulations/workflows/${n}.md`,reminder:n=>`${P}/blob/${O}/client/simulations/reminders/${n}.md`},z={workflow:n=>`client/simulations/workflows/${n}.md`,reminder:n=>`client/simulations/reminders/${n}.md`};function y({children:n,returnTo:s="/playbooks",title:t}){const a=w.useRef(null),d=w.useRef(null),c=w.useRef(null),l=X();w.useEffect(()=>{var g;const o=a.current,u=document.activeElement;c.current=u instanceof HTMLElement&&u!==document.body?u:null,o&&!o.open&&o.showModal(),(g=d.current)==null||g.focus();const m=document.body.style.overflow;return document.body.style.overflow="hidden",()=>{o!=null&&o.open&&o.close(),document.body.style.overflow=m}},[]);const h=()=>{const o=c.current;if(o!=null&&o.isConnected){l(s),requestAnimationFrame(()=>{o.isConnected&&o.focus()});return}l(s,{state:{focusCatalog:!0}})};return e.jsx("dialog",{"aria-label":t,className:i.dialog,"data-testid":"opencode-playbook-dialog",onCancel:o=>{o.preventDefault(),h()},onClick:o=>{o.target===o.currentTarget&&h()},ref:a,children:e.jsxs("div",{className:i.dialogBody,children:[e.jsx("button",{"aria-label":"Close playbook",className:i.close,"data-testid":"opencode-playbook-close",onClick:h,ref:d,type:"button",children:e.jsx(Z,{"aria-hidden":"true",size:18})}),e.jsx(R,{className:i.wipWarning,"data-testid":"opencode-playbooks-wip-warning",variant:"warning",children:"Playbooks is still work in progress and its UI/UX may contain bugs."}),n]})})}function cn(){const{id:n=""}=D(),s=J(),t=s.reminders.find(d=>d.id===n);let a;if(s.status==="loading")a=e.jsx(y,{returnTo:"/playbooks/reminders",title:"Loading reminder",children:e.jsx("p",{className:i.empty,"data-testid":"opencode-playbook-reminder-loading",children:"Loading reminder..."})});else if(s.status==="error")a=e.jsx(y,{returnTo:"/playbooks/reminders",title:"Reminder unavailable",children:e.jsx(R,{"data-testid":"opencode-playbook-reminder-error",variant:"danger",children:"This reminder could not be loaded. Try again after the catalogue is available."})});else if(!t)a=e.jsx(y,{returnTo:"/playbooks/reminders",title:"Reminder not found",children:e.jsxs("section",{className:i.notFound,"data-testid":"opencode-playbook-reminder-not-found",children:[e.jsx("div",{className:i.eyebrow,children:"Not found"}),e.jsxs("h1",{className:i.modalTitle,children:['No reminder called "',n,'"']}),e.jsx("p",{className:i.modalDescription,children:"The reminder catalogue loaded successfully, but it does not contain this id for the currently selected project. A reminder scoped to a different repository is not listed here."})]})});else{const d=Y(s.reminders,t.id);a=e.jsxs(y,{returnTo:"/playbooks/reminders",title:t.title,children:[e.jsxs("header",{className:i.modalHead,children:[e.jsxs("div",{className:i.eyebrow,children:["Reminder - ",d]}),e.jsx("h1",{className:i.modalTitle,children:t.title}),e.jsx("p",{className:i.modalDescription,children:t.description}),e.jsxs("div",{className:i.route,children:["/playbooks/reminders/",t.id]})]}),e.jsxs("section",{className:i.descriptionPanel,"data-testid":"opencode-playbook-reminder-input",children:[e.jsx("div",{className:i.descriptionBar,children:e.jsx("span",{children:"when to attach it"})}),e.jsxs("div",{className:i.descriptionBody,children:[t.triggers.length>0?e.jsxs(e.Fragment,{children:["Attach it when: ",t.triggers.join("; "),"."]}):e.jsx(e.Fragment,{children:"Its author named no specific trigger. Attach it whenever the instructions below are what you want applied."}),t.scopeRepository?e.jsxs(e.Fragment,{children:[" This reminder is scoped to ",e.jsx("code",{children:t.scopeRepository})," and is only listed for a project whose git origin matches."]}):null]})]}),e.jsxs("section",{className:i.injectorDetail,"data-testid":"opencode-playbook-reminder-body",children:[e.jsxs("div",{className:i.descriptionBar,children:[e.jsx("span",{children:"Exact instructions appended"}),e.jsx(M,{label:"reminder instructions",value:t.body})]}),e.jsx("pre",{children:e.jsx("code",{children:t.body})})]}),(()=>{const c=rn(t.id);return c?e.jsx(F,{simulation:c,sourceHref:U.reminder(t.id),sourcePath:z.reminder(t.id)}):null})(),e.jsx("p",{className:i.scopeNote,"data-testid":"opencode-playbook-scope-note",children:"This reminder is supplied by the live server catalogue. Viewing or copying it does not attach, run, or install anything. Attaching it in the composer applies it to your next message only, and the send carries the reminder's id alone — the server resolves this text again at submit time, so what you read here is what is appended."})]})}return e.jsx(W,{detail:a,reminderState:s})}function hn(){var d;const{id:n=""}=D(),s=ee(),t=s.workflows.find(c=>c.id===n);let a;if(s.status==="loading")a=e.jsx(y,{returnTo:"/playbooks/workflows",title:"Loading workflow",children:e.jsx("p",{className:i.empty,"data-testid":"opencode-playbook-workflow-loading",children:"Loading workflow..."})});else if(s.status==="error")a=e.jsx(y,{returnTo:"/playbooks/workflows",title:"Workflow unavailable",children:e.jsx(R,{"data-testid":"opencode-playbook-workflow-error",variant:"danger",children:"This workflow could not be loaded. Try again after the catalogue is available."})});else if(!t)a=e.jsx(y,{returnTo:"/playbooks/workflows",title:"Workflow not found",children:e.jsxs("section",{className:i.notFound,"data-testid":"opencode-playbook-workflow-not-found",children:[e.jsx("div",{className:i.eyebrow,children:"Not found"}),e.jsxs("h1",{className:i.modalTitle,children:['No workflow called "',n,'"']}),e.jsx("p",{className:i.modalDescription,children:"The live workflow catalogue loaded successfully, but it does not contain this id."})]})});else{const c=((d=K(s.workflows).find(({workflows:l})=>l.some(h=>h.id===t.id)))==null?void 0:d.label)??"Other";a=e.jsxs(y,{returnTo:"/playbooks/workflows",title:t.title,children:[e.jsxs("header",{className:i.modalHead,children:[e.jsxs("div",{className:i.eyebrow,children:["Workflow - ",c]}),e.jsx("h1",{className:i.modalTitle,children:t.title}),e.jsx("p",{className:i.modalDescription,children:t.description}),e.jsxs("div",{className:i.route,children:["/playbooks/workflows/",t.id]})]}),e.jsxs("section",{className:i.descriptionPanel,"data-testid":"opencode-playbook-workflow-input",children:[e.jsx("div",{className:i.descriptionBar,children:e.jsx("span",{children:"what it asks for"})}),e.jsx("div",{className:i.descriptionBody,children:t.argument?e.jsxs(e.Fragment,{children:["Collects one field, ",e.jsx("strong",{children:t.argument.label})," (",t.argument.required?"required":"optional",", up to ",t.argument.maxLength.toLocaleString()," characters). What you type becomes the prompt.",t.argument.hint?` ${t.argument.hint}`:""]}):t.prompt?e.jsxs(e.Fragment,{children:['Collects nothing. It sends this fixed prompt: "',t.prompt,'"']}):e.jsx(e.Fragment,{children:"Collects nothing here — this workflow supplies its own form in the composer."})})]}),e.jsxs("section",{className:i.injectorDetail,"data-testid":"opencode-playbook-workflow-injector",children:[e.jsxs("div",{className:i.descriptionBar,children:[e.jsx("span",{children:"Exact trusted injector"}),e.jsx(M,{label:"trusted injector",value:t.injector})]}),e.jsx("pre",{children:e.jsx("code",{children:t.injector})})]}),(()=>{const l=on(t.id);return l?e.jsx(F,{simulation:l,sourceHref:U.workflow(t.id),sourcePath:z.workflow(t.id)}):null})(),e.jsx("p",{className:i.scopeNote,"data-testid":"opencode-playbook-scope-note",children:"This guided action is supplied by the live server catalogue. Viewing or copying its injector does not run, attach, or install anything. It is sent in the sending session's current mode: a workflow carries no declarative Plan or Build setting of its own."})]})}return e.jsx(W,{detail:a,workflowState:s})}export{cn as ReminderPlaybookPage,hn as WorkflowPlaybookPage};
