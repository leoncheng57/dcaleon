---
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

```
$ git branch --show-current
main
$ git status --short
 M client/pages/Hub.tsx
```

## assistant

This parent is a fresh Build-only session, so it can delegate safely. Creating
a sibling worktree at `../dcaleon.worktrees/notification-badge` on
branch `fix/notification-badge`, then launching the child with the absolute
worktree path, exclusive ownership of the badge component, the required
`pwd; git rev-parse --show-toplevel; git status --short --branch` preflight,
and the exact verification command it must run before committing and pushing.

## note

The command itself carries the inherited Plan-deny risk, containment rules,
parallel-ownership limits, and failure handling; there is no second source to
load or drift.
