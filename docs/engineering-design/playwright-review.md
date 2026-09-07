# Playwright evidence for PR review

Every PR gets deterministic screenshot coverage selection in the existing read-only
`PR screenshots` workflow. UI/runtime changes select curated scenarios; unknown/shared
changes get a baseline and explicitly request local AI review. Documentation-only
changes skip with a reason. This is advisory evidence, not a visual-regression gate.
It implements #119, #196, #197 and #427 on the #209 foundation, coordinated by #429.

AI diff interpretation, scenario authoring, image inspection and repair run through the
locally authenticated agent. Actions use no AI keys. No local watcher or self-hosted
runner is required. A PR updated elsewhere receives deterministic CI coverage; custom
evidence waits for a local agent. The local agent's PR completion instructions invoke
the workflow, rather than a machine-wide Git hook that silently publishes on every push.

## Local workflow

```sh
npm ci
npx playwright install chromium
npm run screenshots:gallery -- --list
npm run screenshots:gallery -- --plan --base origin/main
npm run screenshots:gallery -- --pr 123 --scenarios hub-projects,planning-create
```

Capture requires a clean commit; `--pr` also checks the public repository and current
open PR head. Three freshly allocated ports and `CI=true` prevent accidentally using
another worktree's listener. A port race fails visibly; rerun, don't stop other servers.
The existing mock stack builds the production app. Browser traffic is confined to that
app origin, WebSockets are closed, and child processes inherit basic platform variables
without GitHub/AI tokens. This is not a sandbox for hostile checkout code: use reviewed
local source; forks belong in the read-only Actions lane.

Capture creates a unique `screenshot-output/gallery-*` folder. Inspect **every** PNG,
then publish the reviewed bundle:

```sh
npm run screenshots:gallery -- --pr 123 --publish --reviewed --bundle screenshot-output/gallery-EXAMPLE
```

`--reviewed` is the caller's inspection assertion, not machine proof of appearance.
The publisher verifies every immutable raw URL against the captured hash before
updating one actor-owned `<!-- local-playwright-review -->` comment. Repeated runs by
the same account replace its gallery. Another author's comment and the automated
`<!-- pr-screenshots -->` marker are never modified. A local per-PR lock rejects
concurrent publishers; API conflicts fail rather than force-pushing.

Capture with `--pr` first replaces old evidence with pending status. Capture failure
replaces pending with failure. Publication rechecks the PR head after upload. Every
completed gallery prints its source SHA; a push outside the local workflow leaves
historical evidence labelled with its old SHA. Compare with the latest CI comment
and rerun locally. A killed process may leave pending status or a lock: verify the
previous process ended before removing that exact lock and rerunning.

## Curated and custom scenarios

`scripts/review-scenarios.ts` is a data-only closed catalogue. In a PR body:

````md
```screenshots
scenario:hub-projects
scenario:planning-create
full:/settings?directory=/tmp/mock-project
```
````

A block overrides selection, including an empty/comment-only block that explicitly
skips. Unknown IDs/routes fail before Chromium starts. Element dimensions and target
identity derive from the trusted scenario, not untrusted artifact metadata. Authors
cannot send arbitrary CSS, code or interactions to the privileged publisher. Curated
elements appear alongside routes in the existing sticky comment. Existing route
requests still capture dark desktop/mobile images and honor `full:`.

Local `--states path.json` supports new UI and one-off interactive states:

```json
[
  {
    "id": "project-search-empty",
    "title": "Project picker — no matching projects",
    "route": "/opencode?directory=/tmp/mock-project",
    "steps": [
      { "testId": "opencode-project-picker-toggle", "action": "click" },
      { "testId": "opencode-project-search", "action": "fill", "value": "no-such-fixture-project" },
      { "testId": "opencode-projects-empty", "action": "text", "value": "No projects match" }
    ],
    "target": "opencode-project-picker"
  }
]
```

Allowed actions: `click`, `fill`, `text` (assert text), `visible` (assert settled UI).
Testids resolve only visible elements. End with content, empty-state or alert evidence;
missing controls fail loudly, never fall back to unrelated content. Omit `target`
for full-page capture. Don't add product URL parameters solely for screenshots.

Limits: eight local scenarios × two themes × two viewports, twenty steps each,
10 MiB/PNG, 40 MiB/gallery, 20,000px height, 26 million pixels/PNG, twelve minutes/run.
CI retains its ten-request cap. Complex interactions beyond this small schema require
reviewable curated Playwright code; don't turn the publisher into an arbitrary runner.

A new route/scenario cannot publish through its own PR's Actions request until its
catalogue entry is on main. The default-branch validator must not trust the branch
it publishes. Use the local gallery or a precursor PR. Historical #117 `/files`
captures must be adapted to today's Workspace viewer; that removed route is not
resurrected just to reproduce old screenshots.

## Supported GitHub hosting

The supported [Create or update file contents API](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents)
accepts base64 bytes, a branch and commit message (and previous file SHA for replacement)
and returns a commit SHA. Only validated PNGs are uploaded under
`pr-review/N/SOURCE_SHA/` on `artifacts/pr-N-review`, with immutable raw commit URLs.
The publisher parses default-branch workflow YAML and refuses broad push triggers
that might run CI on that branch. Binaries stay outside the feature diff.

[Issue comments](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment)
accept Markdown text, not a general attachment upload. PR conversation comments use
the same API; [review comments](https://docs.github.com/en/rest/pulls/comments#create-a-review-comment-for-a-pull-request)
likewise accept text. We don't rely on private browser upload endpoints. The supported
alternative demonstrated here is a public repository blob linked in HTML `<img>` tags.
The local `gh` identity needs contents write and issue/PR comment write access.

Private repositories are refused: anonymous raw URLs aren't a durable inline-viewing
solution there. Data URLs and expiring Actions artifact URLs aren't inline image stores.
Artifacts remain a download fallback. Release assets/LFS add machinery without improving
this bounded PNG use case. Pages publication remains available and unchanged in authority.

Fork captures remain read-only. Neither local nor trusted Actions publication automatically
publishes fork bytes. Default-branch validation never imports test code from an artifact.
Only locally reviewed same-repository code uses the local publisher's separate marker.

## Retention and failures

Asset branches intentionally retain review history across updates and PR closure.
Pages cleanup removes only its transient directories and bot comments. Every local
gallery states the exact branch and cleanup obligation. Deleting that branch is an
explicit maintenance decision: SHA URLs are immutable but unreachable commits may be
garbage-collected, so availability after deletion isn't guaranteed. Failed uploads can
leave partial branch assets but never a partial completed gallery; rerun to repair.

- **Spinner/wrong pane/theme/clipping:** strengthen the settle assertion or choose
  a focused target, then recapture and inspect both appearances.
- **Stale SHA/dirty tree:** commit and push, confirm the PR head, then recapture.
- **Missing control:** inspect actual testids/state, don't broaden the selector blindly.
- **New scenario rejected by main:** use the local gallery or precursor PR.
- **URL verification failure:** no completed gallery is posted; check availability
  and repository visibility, then retry the bounded publication.
- **Unsafe asset push triggers:** explicitly review the default-branch workflows
  before choosing another publication strategy.
- **Local agent offline:** CI labels baseline coverage; custom review remains pending.

Appearance evidence does not replace interaction tests, typechecks or security checks.
