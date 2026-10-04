---
name: session-wrap-up
title: Session Wrap-Up
description: Close a session with a short, quick-scan handoff of what was produced, where things stand, and what comes next. Use when the session is wrapping up or the user asks for a wrap-up.
tags: docs, planning
---

Finish with a wrap-up a person can scan in under a minute. It is a summary, not a report: short bullets, no narrative of how the session went, and nothing restated that a link already shows.

Use these headings, in this order, and omit a section only when it is genuinely empty by writing "None":

- **Artifacts created** — one bullet per PR, issue, commit, document, or file changed, each a hyperlink or a `file_path` someone can open. Group small file edits under the commit or PR that carries them.
- **Current state** — one or two lines on where things stand, such as "PR open, CI passing" or "blocked on X". State what is committed and pushed versus only local, and mark anything you did not verify as unverified rather than implying it passed.
- **Suggested next actions** — concrete steps someone could pick up in a follow-up session, each with the command, file, or owner it starts from.
- **Open questions / decisions needed** — anything unresolved that needs a human, phrased as a question that can be answered directly.
- **Relevant context** — links to the issues, docs, or threads that informed the work.

Only report what you observed in this session. Do not invent links, and do not take new actions to make the summary look better.
