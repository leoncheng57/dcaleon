---
title: Four nudges to the root cause
trigger: brink-nudge-learning
caveat: >-
  Compressed from a longer session. The agent's PR lookups and file reads
  between turns are omitted, and the real exchange took more turns than this.
---

# Worked example

## user

can you find that PR about fixing the bug where skill is not savable

*Reminder attached: Brink Nudge Learning*

## assistant

Found it — PR #14221, "resolve the published skill id on the chat skill banner after publish".

The one-line version: when you edit a skill that is already published, the chat message keeps pointing at a database row that publishing deletes.

That sentence has two things in it you may not have met yet — what a *draft row* is, and why publishing would delete one. Which do you want first?

## user

why does publishing delete a row at all

## assistant

Because editing a published skill does not edit it in place. It creates a second, private row to hold your edits:

```
  id: PARENT              id: DRAFT
  is_published: true      is_published: false
  (v1 contents)           (v2 edits)
```

On publish, the backend copies the draft's contents into PARENT and deletes DRAFT. One skill, so one surviving row.

Now — the chat card was stamped with an id back when the draft was created. Which of those two ids do you think it holds?

## user

DRAFT. and that's the one that just got deleted

## assistant

Exactly. That is the entire bug.

```
  skill_payload.skillId = DRAFT
          |
          v
  GET /skills/DRAFT  ->  404  ->  "This skill couldn't be loaded"
```

You got there in three steps, so here is the next layer instead of a recap: creating a brand-new skill does *not* hit this, despite using the same publish endpoint. What is different about it?

## user

is it because there's no parent, so the draft row just becomes the published one and never gets deleted?

## assistant

That is the answer, and it is the part most people miss.

Fresh create promotes the draft in place — same row, same id, nothing deleted — so the stamped id stays valid forever. Only the edit path mints an id that it later destroys.

You now have the root cause. One caveat on what I have actually checked: the two-row behaviour is what the frontend types and the PR description imply, not something I read in the backend, which lives in another repository.

The next layer down is what #14221 does about it — a draft-to-published id map held in Redux — and after that, why that fix does not survive a page refresh. Say which one.
