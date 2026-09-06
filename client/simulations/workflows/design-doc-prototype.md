---
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

```
$ cat > design/2026-08-30-simulation-player/mockup.html
  (self-contained, no framework, using the app's real token values)
```

## note

Real token values rather than generic greys. A wireframe in placeholder colours
invites feedback about the colours instead of about the design.

## tool — bash

```
$ npx playwright@1.62.1 screenshot --browser=chromium \
    --viewport-size=1280,800 file://$PWD/design/.../mockup.html desktop.png
$ npx playwright@1.62.1 screenshot --browser=chromium \
    --viewport-size=390,740 file://$PWD/design/.../mockup.html mobile.png
```

## tool — bash

```
$ git push -u origin design/simulation-player
  branch published
```

## assistant

Committed the HTML and both PNGs to `design/` on a real pushed branch, so the
raw.githubusercontent.com URLs are permanent rather than pointing at a local
file that disappears.

The dated document embeds both screenshots and states plainly that this is a
proposal, not a description of current behaviour — the failure mode for design
documents is being read later as a record of what exists.

## note

Notion is the default because it's a durable, dated writeup. If the reader is
already on a tracking GitHub issue or PR instead, skip Notion and comment there
directly with `gh issue comment` (or `gh pr comment`), embedding the same
raw.githubusercontent.com URLs.
