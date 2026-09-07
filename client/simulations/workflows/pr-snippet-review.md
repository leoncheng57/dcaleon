---
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

```
$ gh pr view 341 --json headRefOid,title,files
  headRefOid: 9f2c1ab4d7e0c8b35a61f0d2e4c79b8a3d5e6f12
  title: Serve the reminder body from /api/reminders
  files: 6 changed
```

## assistant

Pinning every link to `9f2c1ab` so line references cannot drift when the branch
moves.

Reading order is not file order here. The change rests on one claim — that
withholding the body was never what protected it — so the review has to start
with the resolution path that makes that true, or every later snippet looks
like a straightforward information leak.

## tool — bash

```
$ gh pr diff 341 | head -40
  server/routes/reminders.ts   | +12 -4
  client/lib/api.ts            | +7  -0
  tests/e2e/smoke.api.spec.ts  | +21 -12
```

## assistant

Step 1 is `server/opencode/sessions.ts`, which is not in the diff at all: it is
where a send resolves the reminder from its id. Step 2 is the projection change.
Step 3 is the test that used to assert the opposite.

## tool — bash

```
$ gh pr comment 341 -F -
  https://github.com/leoncheng57/dcaleon/pull/341#issuecomment-...
```

## assistant

Posted as one comment, six steps.

Riskiest snippet: the projection now spreads `body` into the response. If a
future field is added to `ReminderPreset` it will ride along silently, because
the projection lists fields to include rather than to exclude.

Not verified by this change: that no other caller assumed `body` was absent.
I checked the client and the tests, not any external consumer.
