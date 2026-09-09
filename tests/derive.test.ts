import { describe, expect, it } from "vitest";

import {
  collapseActionGroups,
  extractCommands,
  extractMrUrls,
  extractSessionLinks,
  formatDurationMs,
  formatRelative,
  mergeEvents,
  runningActivity,
  serializeCommands,
} from "../client/lib/derive.js";
import type { MessageMode, PatchEvent, ToolEvent, TranscriptEvent, UserEvent } from "../client/lib/transcript.js";

const at = (n: number) => new Date(1787000000000 + n * 1000).toISOString();

function tool(id: string, over: Partial<ToolEvent> = {}): ToolEvent {
  return {
    kind: "tool",
    id,
    messageId: "m1",
    timestamp: at(1),
    status: "completed",
    name: "bash",
    attachments: [],
    ...over,
  };
}

function patch(id: string, over: Partial<PatchEvent> = {}): PatchEvent {
  return {
    kind: "patch",
    id,
    messageId: "m1",
    timestamp: at(1),
    files: ["src/a.ts"],
    fileCount: 1,
    filesTruncated: false,
    userMessageId: "u1",
    ...over,
  };
}

function agent(id: string, text: string, ts = at(1)): TranscriptEvent {
  return { kind: "agent", id, messageId: "m1", timestamp: ts, text };
}

function user(id: string, text: string, mode?: MessageMode): UserEvent {
  return {
    kind: "user",
    id,
    messageId: "m1",
    timestamp: at(1),
    text,
    reminders: [],
    workflows: [],
    attachments: [],
    ...(mode ? { mode } : {}),
  };
}

describe("mergeEvents", () => {
  it("returns the same reference when nothing changed, so memos hold", () => {
    const prev = [agent("a", "hello")];
    expect(mergeEvents(prev, [agent("a", "hello")])).toBe(prev);
    expect(mergeEvents([], [])).toEqual([]);
  });

  it("removes events absent from the authoritative transcript", () => {
    const previous = [agent("a", "first"), agent("b", "second", at(2))];
    expect(mergeEvents(previous, [agent("b", "second", at(2))]).map((event) => event.id)).toEqual(["b"]);
    expect(mergeEvents(previous, [])).toEqual([]);
  });

  it("detects a same-length content revert", () => {
    const previous = [agent("a", "first")];
    const merged = mergeEvents(previous, [agent("a", "again")]);
    expect((merged[0] as { text: string }).text).toBe("again");
  });

  it("replaces a prose row whose metrics or model changed under identical text", () => {
    // The Claude store creates the row with pending metrics on the first text
    // frame and stamps cost/model later with the SAME text; a text-only
    // fingerprint kept the client at "cost pending" until a remount.
    const pending = { ...agent("a", "done"), metricsStatus: "pending" as const };
    const final = { ...agent("a", "done"), metricsStatus: "final" as const, messageCost: 0.01, cumulativeCost: 0.05, messageDurationMs: 1200 };
    const merged = mergeEvents([pending], [final]);
    expect(merged[0]).toMatchObject({ metricsStatus: "final", messageCost: 0.01 });
    const labelled = mergeEvents([final], [{ ...final, model: "claude-opus-4-1" }]);
    expect(labelled[0]).toMatchObject({ model: "claude-opus-4-1" });
    // An identical row is still the same reference, so memos hold.
    const stable = [final];
    expect(mergeEvents(stable, [{ ...final }])).toBe(stable);
  });

  // The bug this guards against: OpenCode tool parts mutate in place. Treating
  // "is the id new?" as "did anything change?" freezes chips at `running`.
  it("detects a tool transitioning running -> completed", () => {
    const prev = [tool("t1", { status: "running" })];
    const next = mergeEvents(prev, [tool("t1", { status: "completed", output: "done" })]);
    expect(next).not.toBe(prev);
    expect((next[0] as ToolEvent).status).toBe("completed");
  });

  it("detects streaming output growing on the same tool", () => {
    const prev = [tool("t1", { status: "running", output: "part" })];
    const next = mergeEvents(prev, [tool("t1", { status: "running", output: "partial output" })]);
    expect(next).not.toBe(prev);
    expect((next[0] as ToolEvent).output).toBe("partial output");
  });

  it("detects an error appearing", () => {
    const prev = [tool("t1", { status: "running" })];
    const next = mergeEvents(prev, [tool("t1", { status: "error", error: "boom" })]);
    expect(next).not.toBe(prev);
  });

  it("preserves authoritative incoming order when timestamps tie", () => {
    const merged = mergeEvents(
      [agent("b", "second", at(2))],
      [agent("a", "first", at(1)), agent("c", "same", at(2)), agent("b", "second", at(2))],
    );
    expect(merged.map((e) => e.id)).toEqual(["a", "c", "b"]);
  });

  it("detects an order-only correction", () => {
    const first = agent("a", "first");
    const second = agent("b", "second");
    const merged = mergeEvents([first, second], [second, first]);
    expect(merged).toEqual([second, first]);
  });

  it("lets incoming replace an existing event", () => {
    const merged = mergeEvents([agent("a", "old")], [agent("a", "much newer text")]);
    expect((merged[0] as { text: string }).text).toBe("much newer text");
  });

  // A first sight of a message can arrive without the metadata that classifies
  // it. Without mode in the fingerprint the row would render neutral forever.
  it("replaces a neutral row when a later fetch establishes its mode", () => {
    const neutralUser = [user("u1", "same text")];
    const classifiedUser = mergeEvents(neutralUser, [user("u1", "same text", "plan")]);
    expect(classifiedUser).not.toBe(neutralUser);
    expect((classifiedUser[0] as UserEvent).mode).toBe("plan");

    const planAgent: TranscriptEvent = { ...(agent("a1", "same text") as TranscriptEvent), mode: "plan" };
    const buildAgent: TranscriptEvent = { ...(agent("a1", "same text") as TranscriptEvent), mode: "build" };
    const corrected = mergeEvents([planAgent], [buildAgent]);
    expect(corrected[0]).toBe(buildAgent);
  });

  it("still holds the reference when mode and text are both unchanged", () => {
    const previous = [user("u1", "same text", "build")];
    expect(mergeEvents(previous, [user("u1", "same text", "build")])).toBe(previous);
  });

  it("replaces bounded patch metadata when the hidden file count grows", () => {
    const previous: TranscriptEvent[] = [{
      kind: "patch",
      id: "patch",
      messageId: "m1",
      timestamp: at(1),
      files: ["a.ts", "b.ts"],
      fileCount: 2,
      filesTruncated: false,
      userMessageId: "u1",
    }];
    const incoming: TranscriptEvent[] = [{
      ...previous[0],
      kind: "patch",
      fileCount: 12,
      filesTruncated: true,
    }];

    const merged = mergeEvents(previous, incoming);
    expect(merged).not.toBe(previous);
    expect(merged[0]).toBe(incoming[0]);
  });

  it("preserves unchanged row identity when a sibling changes", () => {
    const unchanged = agent("a", "stable", at(1));
    const previous = [unchanged, agent("b", "old", at(2))];
    const merged = mergeEvents(previous, [agent("a", "stable", at(1)), agent("b", "new text", at(2))]);

    expect(merged).not.toBe(previous);
    expect(merged[0]).toBe(unchanged);
    expect(merged[1]).not.toBe(previous[1]);
  });
});

describe("collapseActionGroups", () => {
  it("folds consecutive completed calls into one group", () => {
    const items = collapseActionGroups([tool("t1"), tool("t2"), tool("t3")]);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("actionGroup");
    expect((items[0] as { calls: ToolEvent[] }).calls).toHaveLength(3);
  });

  it("keys the group on the first call so expand state survives growth", () => {
    const two = collapseActionGroups([tool("t1"), tool("t2")]);
    const three = collapseActionGroups([tool("t1"), tool("t2"), tool("t3")]);
    expect(two[0].id).toBe("group-t1");
    expect(three[0].id).toBe("group-t1");
  });

  it("never hides errors or in-flight calls", () => {
    const items = collapseActionGroups([
      tool("ok1"),
      tool("bad", { status: "error", error: "x" }),
      tool("ok2"),
      tool("busy", { status: "running" }),
    ]);
    expect(items.map((i) => i.id)).toEqual(["ok1", "bad", "ok2", "busy"]);
    expect(items.every((i) => i.type === "event")).toBe(true);
  });

  it("keeps task cards visible even when exact child metadata is unavailable", () => {
    const items = collapseActionGroups([
      tool("ok1"),
      tool("task", { name: "task" }),
      tool("ok2"),
    ]);
    expect(items.map((item) => item.id)).toEqual(["ok1", "task", "ok2"]);
    expect(items.every((item) => item.type === "event")).toBe(true);
  });

  it("keeps edit milestones between completed action groups", () => {
    const patch: TranscriptEvent = {
      kind: "patch",
      id: "patch",
      messageId: "m1",
      timestamp: at(1),
      files: ["src/index.ts"],
      fileCount: 1,
      filesTruncated: false,
      userMessageId: "user-1",
    };
    const items = collapseActionGroups([tool("before-1"), tool("before-2"), patch, tool("after-1"), tool("after-2")]);
    expect(items.map((item) => item.id)).toEqual(["group-before-1", "patch", "group-after-1"]);
  });

  it("leaves a single call ungrouped", () => {
    const items = collapseActionGroups([tool("t1"), agent("a", "hi")]);
    expect(items.map((i) => i.type)).toEqual(["event", "event"]);
  });

  it("flushes a trailing run", () => {
    const items = collapseActionGroups([agent("a", "hi"), tool("t1"), tool("t2")]);
    expect(items.map((i) => i.type)).toEqual(["event", "actionGroup"]);
  });
});

describe("runningActivity", () => {
  it("reports the in-flight tool", () => {
    const activity = runningActivity([
      tool("t1"),
      tool("t2", { status: "running", detail: "npm test", name: "bash" }),
    ]);
    expect(activity).toMatchObject({ kind: "tool", name: "bash", detail: "npm test" });
  });

  it("ignores status separators when looking backwards", () => {
    const activity = runningActivity([
      tool("t1", { status: "running", detail: "npm test" }),
      { kind: "status", id: "s1", messageId: "m1", timestamp: at(2), label: "Compacted" },
    ]);
    expect(activity.kind).toBe("tool");
  });

  // A stale unfinished call deeper in history is not what's happening now.
  it("does not resurrect an old unfinished call", () => {
    const activity = runningActivity([tool("t1", { status: "running" }), agent("a", "done")]);
    expect(activity.kind).toBe("thinking");
  });

  it("falls back to thinking with the newest timestamp", () => {
    const activity = runningActivity([agent("a", "x", at(1)), agent("b", "y", at(5))]);
    expect(activity).toEqual({ kind: "thinking", since: at(5) });
  });
});

describe("extractCommands", () => {
  it("categorises by tool name", () => {
    const entries = extractCommands([
      tool("a", { name: "bash", detail: "ls" }),
      tool("b", { name: "edit", detail: "src/x.ts" }),
      tool("c", { name: "read", detail: "src/y.ts" }),
      tool("d", { name: "mystery_tool", detail: "?" }),
    ]);
    expect(entries.map((e) => e.category)).toEqual(["command", "edit", "read", "other"]);
  });

  it("maps tool status onto audit status", () => {
    const entries = extractCommands([
      tool("a", { detail: "x", status: "completed" }),
      tool("b", { detail: "x", status: "error" }),
      tool("c", { detail: "x", status: "running" }),
    ]);
    expect(entries.map((e) => e.status)).toEqual(["ok", "error", "pending"]);
  });

  it("keeps calls with no detail under their tool name", () => {
    expect(extractCommands([tool("a")])[0].text).toBe("bash");
  });

  it("previews the first non-empty output line, capped", () => {
    const [entry] = extractCommands([
      tool("a", { detail: "ls", output: "\n\n  first line  \nsecond" }),
    ]);
    expect(entry.outputPreview).toBe("first line");
  });

  // The id must match the transcript row anchor or jump-to-event no-ops.
  it("uses the event id as the jump anchor", () => {
    const [entry] = extractCommands([tool("anchor-me", { detail: "ls" })]);
    expect(entry.id).toBe("anchor-me");
  });

  it("includes applied patch milestones in authoritative input order", () => {
    const entries = extractCommands([
      tool("read-first", { name: "read", detail: "src/old.ts", timestamp: at(3) }),
      patch("patch-second", { files: ["src/a.ts", "src/b.ts"], fileCount: 2, timestamp: at(1) }),
      tool("command-third", { detail: "npm test", timestamp: at(2) }),
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(["read-first", "patch-second", "command-third"]);
    expect(entries[1]).toMatchObject({ category: "edit", activityKind: "change", name: "patch", status: "ok", fileCount: 2, fileSummary: "src/a.ts, src/b.ts" });
  });

  it("ignores ordinary status events", () => {
    expect(extractCommands([
      { kind: "status", id: "compaction", messageId: "m1", timestamp: at(1), label: "Context compacted", detail: "src/a.ts" },
    ])).toEqual([]);
  });

  it("preserves source order when activity timestamps tie", () => {
    const timestamp = at(1);
    const entries = extractCommands([
      tool("z", { detail: "first", timestamp }),
      patch("a", { timestamp }),
      tool("m", { detail: "third", timestamp }),
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(["z", "a", "m"]);
  });

  it("includes turn failures and failed tool details", () => {
    const entries = extractCommands([
      tool("failed-tool", { name: "webfetch", detail: "https://invalid", status: "error", error: "Not found" }),
      { kind: "error", id: "failed-turn", messageId: "m1", timestamp: at(2), message: "Provider failed" },
    ]);
    expect(entries).toMatchObject([
      { id: "failed-tool", category: "read", status: "error", outputPreview: "Not found" },
      { id: "failed-turn", category: "other", status: "error", text: "Provider failed" },
    ]);
  });

  it("exports only shell commands from a mixed activity timeline", () => {
    const script = serializeCommands(extractCommands([
      tool("read", { name: "read", detail: "src/a.ts" }),
      patch("patch", { timestamp: at(2) }),
      tool("shell", { name: "bash", detail: "npm test", commandText: "npm test" }),
    ]));
    expect(script).toContain("npm test");
    expect(script).not.toContain("src/a.ts");
  });

  it("does not export a shell tool without captured command text", () => {
    const script = serializeCommands(extractCommands([
      tool("unknown-shell", { name: "bash", title: "Shell command" }),
      tool("known-shell", { name: "bash", detail: "npm test", commandText: "npm test" }),
    ]));
    expect(script).toContain("npm test");
    expect(script).not.toContain("Shell command");
    expect(script.split("\n")).not.toContain("bash");
  });

  it("exports exact multiline and long shell commands", () => {
    const command = `printf '%s\\n' "${"x".repeat(180)}"\nnpm test`;
    const script = serializeCommands(extractCommands([
      tool("shell", { name: "bash", detail: `${command.slice(0, 159)}…`, commandText: command }),
    ]));
    expect(script).toContain(command);
  });
});

describe("extractMrUrls", () => {
  it("finds GitLab MRs on any host and GitHub PRs", () => {
    const urls = extractMrUrls([
      agent("a", "See https://gitlab.example.com/g/p/-/merge_requests/42 for details"),
      tool("t", { output: "opened https://github.com/o/r/pull/7" }),
    ]);
    expect(urls).toEqual([
      "https://gitlab.example.com/g/p/-/merge_requests/42",
      "https://github.com/o/r/pull/7",
    ]);
  });

  it("stops at the iid, ignoring tab segments and query strings", () => {
    const urls = extractMrUrls([agent("a", "https://gl.io/g/p/-/merge_requests/9/diffs?x=1")]);
    expect(urls).toEqual(["https://gl.io/g/p/-/merge_requests/9"]);
  });

  it("terminates correctly inside a markdown link", () => {
    const urls = extractMrUrls([agent("a", "[MR](https://gl.io/g/p/-/merge_requests/3)")]);
    expect(urls).toEqual(["https://gl.io/g/p/-/merge_requests/3"]);
  });

  it("dedupes while preserving first-seen order", () => {
    const urls = extractMrUrls([
      agent("a", "https://gl.io/g/p/-/merge_requests/2"),
      agent("b", "https://gl.io/g/p/-/merge_requests/1"),
      agent("c", "https://gl.io/g/p/-/merge_requests/2"),
    ]);
    expect(urls).toEqual([
      "https://gl.io/g/p/-/merge_requests/2",
      "https://gl.io/g/p/-/merge_requests/1",
    ]);
  });
});

describe("extractSessionLinks", () => {
  it("groups reviews, issues, Notion, and other hosts from one session", () => {
    const index = extractSessionLinks([
      agent("a", "Review https://github.com/o/r/pull/7 closes https://github.com/o/r/issues/12"),
      agent("b", "Design https://www.notion.so/My-Design-Doc-0123456789abcdef0123456789abcdef"),
      tool("t", { output: "docs at https://docs.example.com/guide and https://gitlab.co/g/p/-/merge_requests/3" }),
    ]);

    expect(index.reviews).toEqual([
      "https://github.com/o/r/pull/7",
      "https://gitlab.co/g/p/-/merge_requests/3",
    ]);
    expect(index.issues).toEqual([expect.objectContaining({
      url: "https://github.com/o/r/issues/12",
      kind: "issue",
      label: "o/r#12",
      issue: { owner: "o", repo: "r", number: 12 },
    })]);
    expect(index.notion).toEqual([expect.objectContaining({ kind: "notion", label: "My Design Doc" })]);
    expect(index.other).toEqual([{ host: "docs.example.com", links: [expect.objectContaining({ label: "docs.example.com/guide" })] }]);
    expect(index.total).toBe(5);
  });

  it("counts unique links, not occurrences, and collapses review tab segments", () => {
    const index = extractSessionLinks([
      agent("a", "https://github.com/o/r/pull/7"),
      agent("b", "https://github.com/o/r/pull/7/files"),
      agent("c", "https://docs.example.com/guide"),
      agent("d", "https://docs.example.com/guide/"),
      agent("e", "https://docs.example.com/guide#section"),
    ]);
    expect(index.reviews).toEqual(["https://github.com/o/r/pull/7"]);
    expect(index.other[0].links).toHaveLength(1);
    expect(index.total).toBe(2);
  });

  it("rejects non-HTTP(S) targets so they never become outbound controls", () => {
    const index = extractSessionLinks([
      agent("a", "javascript:alert(1) file:///etc/passwd data:text/html,<b>x</b> ftp://host/f"),
    ]);
    expect(index.total).toBe(0);
    expect(index.other).toEqual([]);
  });

  it("orders other hosts alphabetically and keeps first-seen order inside a host", () => {
    const index = extractSessionLinks([
      agent("a", "https://zulip.example.com/one"),
      agent("b", "https://alpha.example.com/x"),
      agent("c", "https://zulip.example.com/two"),
    ]);
    expect(index.other.map((group) => group.host)).toEqual(["alpha.example.com", "zulip.example.com"]);
    expect(index.other[1].links.map((link) => link.url)).toEqual([
      "https://zulip.example.com/one",
      "https://zulip.example.com/two",
    ]);
  });

  it("terminates inside markdown links and trailing sentence punctuation", () => {
    const index = extractSessionLinks([
      agent("a", "See [docs](https://docs.example.com/a) and https://docs.example.com/b."),
    ]);
    expect(index.other[0].links.map((link) => link.url)).toEqual([
      "https://docs.example.com/a",
      "https://docs.example.com/b",
    ]);
  });

  it("reports an empty index for a session with no links", () => {
    const index = extractSessionLinks([agent("a", "no links here")]);
    expect(index).toMatchObject({ reviews: [], issues: [], notion: [], other: [], total: 0 });
  });

  it("treats notion.site and app.notion.com as Notion", () => {
    const index = extractSessionLinks([
      agent("a", "https://team.notion.site/Page https://app.notion.com/x/Plan"),
    ]);
    expect(index.notion).toHaveLength(2);
    expect(index.other).toEqual([]);
  });
});

describe("formatters", () => {
  it("formats durations across the minute boundary", () => {
    expect(formatDurationMs(250)).toBe("250ms");
    expect(formatDurationMs(3200)).toBe("3.2s");
    expect(formatDurationMs(125_000)).toBe("2m 05s");
    expect(formatDurationMs(undefined)).toBeNull();
    expect(formatDurationMs(-1)).toBeNull();
  });

  it("formats relative times", () => {
    const now = Date.parse(at(100));
    expect(formatRelative(at(100), now)).toBe("just now");
    expect(formatRelative(at(70), now)).toBe("30s ago");
    expect(formatRelative(at(-100), now)).toBe("3m ago");
    expect(formatRelative("not-a-date", now)).toBe("");
  });
});
