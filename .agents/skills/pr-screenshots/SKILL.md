---
name: pr-screenshots
description: Select, capture, inspect, and publish Playwright screenshot evidence when creating or updating a dcaleon PR, or when asked for visual review of an existing PR.
---

# PR screenshot review

Read [the command and state schema](../../../docs/engineering-design/playwright-review.md).

When creating/updating a PR, include visual evidence within the user's authorized PR work. Read the diff and run `npm run screenshots:gallery -- --plan --base origin/main`. The mappings suggest coverage, not AI review. For nonvisual changes, run with `--pr N` to record the skip. For unknown/shared UI changes, add focused states; don't claim the baseline covers everything.

Choose the path: if every route/scenario already exists in **main's** screenshot allowlist, automatic Actions or a `screenshots` block can publish it; a new route/scenario needs the local gallery (or a precursor PR), because the privileged publisher deliberately validates with main's catalogue. Never relax that boundary.

For local evidence:

1. Work on the PR's exact, clean head with locked dependencies and Chromium installed. The runner allocates three unused ports and starts fresh mock/BFF processes; never reuse or terminate another workspace's listeners.
2. Choose IDs from `--list` or author a bounded `--states` JSON file using the documented schema. Commit reusable scenarios; put one-off state files in ignored `screenshot-output/`. Use synthetic fixtures. Click/fill into transient states instead of adding screenshot-only query parameters. LocalStorage-only states can be captured through the real controls that set them.
3. End on rendered content, an intentional empty state, or an explicit refusal/error. A container with a spinner is not settled. Target the visible pane; never use `.first()` to guess between hidden desktop/mobile copies. Prefer a focused `target` for dialogs and panels; omit it for a full page.
4. Run `npm run screenshots:gallery -- --pr N --scenarios hub-projects,planning-create` (or `--states path.json`). It produces light/dark × desktop/mobile images and a manifest, then stops before upload.
5. Open **every** image. Verify the intended state, readable text, correct theme, and framing. Fix and recapture if a spinner or clipping obscures the subject. Appearance evidence does not replace meaningful interaction assertions.
6. Publish with `npm run screenshots:gallery -- --pr N --publish --reviewed --bundle screenshot-output/gallery-…`. It verifies repository visibility, source SHA, workflow push exclusions, inventory, hashes, and every immutable raw URL before updating the actor-owned gallery.

The local publisher uses Contents API on `artifacts/pr-N-review`, never `gh-pages` or the `<!-- pr-screenshots -->` marker; those belong exclusively to the trusted default-branch publisher. Forks get read-only Actions artifacts, not automatic inline byte publication. Keep binaries outside the merge diff.

AI selection and inspection run locally with existing authentication. Actions have no AI keys and cannot invent states while the local agent is offline. Report baseline/pending coverage honestly; rerun on each updated head. Report failures instead of calling old images current. A crash may leave a lock; confirm the prior process ended before removing that exact lock file.

Assets are retained for review history. The generated comment names the branch and cleanup obligation. Pages cleanup does not remove it; deleting the branch may eventually break SHA URLs after garbage collection. Do not silently prune evidence or change another author's gallery. Finish by confirming the PR gallery and a clean source diff.
