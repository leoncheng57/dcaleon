# Retired: repository-owned OpenCode commands

This directory used to hold 23 human-invoked OpenCode slash commands, their
worked simulations, and the build-time parser that fed the Runner's
`/playbooks` catalogue. All of it has been removed.

There is no public catalogue. The former commands-only static site under
`/dcaleon/agent-skills/` and the workflow that published it are retired,
and the published directory has been removed from `gh-pages`. The only catalogue is
the Runner's own `/playbooks`, which reads this content out of the bundle it was
built from. The archived separate repository still owns
<https://leoncheng.dev/agent-skills/>; this repository's token cannot modify it.

Nothing replaced it one-for-one. Of the twenty-three, eight became workflows,
eleven were already covered by a reminder, and four were retired outright:

- **Composer workflows** (`server/workflows/workflows.ts`) carry the eight
  procedures kept for per-message invocation: `session-handoff`, `goal`, `dca`,
  `system-design-artifacts`, `docs-preview`, `mini-design-doc`,
  `leaving-now-wrap-up`, and `standup`. A workflow keeps its trusted
  instructions server-side and resolves them by id at send time, so it needs no
  installation, no restart, and no copy of the file on the reader's machine.
  The procedure text was ported verbatim.
- **Runtime reminders** (`../reminders/`) already said what eleven of them said:
  `background`, `build-waves`, `handoff`, `duck-mode`, `grill-me`,
  `cite-file-lines`, `diagram`, `deep-research`, `native-worktree-subagents`,
  `research-handoff`, and `verify`. Those were deleted rather than converted,
  because a second copy of the same instructions is worse than none.
- **Retired outright**, with no workflow and no reminder: `manager-children`,
  `red-team`, `worktree-up`, and `review-learning`. That capability has left the
  application; it was a deliberate scope decision, not an oversight.

One difference is worth stating rather than discovering. A command could pin
its own agent in frontmatter (`agent: plan`), and a workflow cannot: it is sent
in the session's current mode. The workflow preview says so before you send.

The public catalogue this directory used to publish is retired with it. See
`AGENTS.md` for the decision record.

## Licensing

[`CREDITS.md`](CREDITS.md) and [`LICENSE`](LICENSE) remain here. Attribution for
adapted third-party content outlives the file that carried it, and the derived
work is still reachable in this repository's history.
