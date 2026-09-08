import { describe, expect, it } from "vitest";

import fixture from "./fixtures/session-messages.json" with { type: "json" };
import {
  detectInterrupted,
  messageMode,
  normalizeMessage,
  normalizeTranscript,
  PATCH_FILE_METADATA_LIMITS,
  taskMetadataOf,
  toolDetail,
  type RawMessage,
} from "../client/lib/events.js";
import type { AgentEvent, ThoughtEvent, ToolEvent, UserEvent } from "../client/lib/transcript.js";

const messages = fixture as RawMessage[];

describe("normalizeTranscript", () => {
  const { events } = normalizeTranscript(messages);

  it("maps a user text part to a user row", () => {
    const user = events.find((e) => e.kind === "user") as UserEvent;
    expect(user.text).toBe("Add a health endpoint to the server.");
    expect(user.reminders).toEqual([]);
  });

  it("folds file references into the surrounding turn instead of emitting a row", () => {
    expect(events.some((e) => e.id === "prt_file_001")).toBe(false);
    const user = events.find((e) => e.kind === "user") as UserEvent;
    expect(user.attachments).toEqual([
      {
        filename: "notes.md",
        mime: "text/plain",
        url: "file:///workspace/notes.md",
        path: "/workspace/notes.md",
      },
    ]);
  });

  it("maps assistant text to an agent row", () => {
    const agent = events.filter((e) => e.kind === "agent");
    expect(agent.map((e) => (e as { text: string }).text)).toEqual([
      "I'll add the route now. Review: https://github.com/acme/demo/pull/7 closes https://github.com/acme/demo/issues/12 spec https://www.notion.so/Route-Spec-0123456789abcdef0123456789abcdef",
    ]);
  });

  it("emits step-start and step-finish as bookkeeping, never as rows", () => {
    expect(events.some((e) => e.id.includes("stepstart"))).toBe(false);
    expect(events.some((e) => e.id.includes("stepfinish"))).toBe(false);
  });

  it("tolerates unknown part types rather than throwing or rendering them", () => {
    expect(events.some((e) => e.id === "prt_unknown_001")).toBe(false);
    expect(events.length).toBeGreaterThan(0);
  });
});

describe("reasoning", () => {
  const { events } = normalizeTranscript(messages);
  const thoughts = events.filter((e) => e.kind === "thought") as ThoughtEvent[];

  it("keeps readable reasoning and reports its duration", () => {
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0].text).toBe("The server has no health route yet, so I will add one.");
    expect(thoughts[0].durationMs).toBe(2000);
  });

  it("drops encrypted-only reasoning instead of rendering an empty row", () => {
    expect(thoughts.some((t) => t.id === "prt_reason_002")).toBe(false);
  });

  // Provider artefacts must never cross the adapter boundary.
  it("never carries the Anthropic signature into the contract", () => {
    const serialized = JSON.stringify(thoughts);
    expect(serialized).not.toContain("OPAQUE_SIGNATURE_MUST_NOT_RENDER");
    expect(serialized).not.toContain("signature");
  });
});

describe("tool events", () => {
  const { events } = normalizeTranscript(messages);
  const tools = events.filter((e) => e.kind === "tool") as ToolEvent[];

  it("carries call and result as one event — no action/observation pairing", () => {
    const read = tools.find((t) => t.name === "read")!;
    expect(read.status).toBe("completed");
    expect(read.detail).toBe("/workspace/server/index.ts");
    expect(read.output).toBe("export const app = express();");
    expect(read.title).toBe("server/index.ts");
    expect(read.durationMs).toBe(250);
  });

  it("surfaces errors with their message", () => {
    const failed = tools.find((t) => t.name === "webfetch")!;
    expect(failed.status).toBe("error");
    expect(failed.error).toContain("ENOTFOUND");
  });

  it("shows partial output for a call still running", () => {
    const running = tools.find((t) => t.name === "bash")!;
    expect(running.status).toBe("running");
    expect(running.output).toBe("partial output so far");
    expect(running.commandText).toBe("npm test");
    expect(running.durationMs).toBeUndefined();
  });

  it("preserves exact multiline shell commands separately from display detail", () => {
    const command = `printf '%s\\n' "${"x".repeat(180)}"\nnpm test`;
    const [event] = normalizeMessage({
      info: { id: "m-command", role: "assistant", time: { created: 1 } },
      parts: [{
        id: "p-command",
        messageID: "m-command",
        type: "tool",
        tool: "bash",
        state: { status: "completed", input: { command }, output: "ok" },
      }],
    }) as ToolEvent[];
    expect(event.commandText).toBe(command);
    expect(event.detail).not.toBe(command);
  });
});

describe("task metadata", () => {
  const task = (state: NonNullable<RawMessage["parts"]>[number]["state"]): RawMessage => ({
    info: { id: "msg_task", role: "assistant", time: { created: 1 } },
    parts: [{ id: "prt_task", messageID: "msg_task", type: "tool", tool: "task", state }],
  });

  it("normalizes verified foreground, agent, model, and child fields", () => {
    const [event] = normalizeMessage(task({
      status: "completed",
      input: { description: "Inspect architecture", prompt: "Review the boundaries", subagent_type: "explore" },
      metadata: {
        parentSessionId: "ses_parent",
        sessionId: "ses_child_exact",
        model: { providerID: "anthropic", modelID: "claude-opus-5" },
      },
    })) as ToolEvent[];

    expect(event).toMatchObject({
      name: "task",
      taskExecution: "foreground",
      taskAgent: "explore",
      taskModel: "claude-opus-5",
      childSessionId: "ses_child_exact",
    });
  });

  it("normalizes explicit background execution and the selected subagent", () => {
    const [event] = normalizeMessage(task({
      status: "running",
      input: { description: "Implement change", prompt: "Edit the files", subagent_type: "general", background: true },
      metadata: {
        parentSessionId: "ses_parent",
        sessionId: "ses_child_background",
        model: { providerID: "openai", modelID: "gpt-5.6-sol" },
        background: true,
      },
    })) as ToolEvent[];
    expect(event).toMatchObject({ taskExecution: "background", taskAgent: "general" });
  });

  it("omits unknown and malformed task values instead of guessing", () => {
    expect(taskMetadataOf({
      type: "tool",
      tool: "task",
      state: {
        input: { subagent_type: "explore", background: "true" },
        metadata: { sessionId: 42, model: { modelID: 7 }, effort: false, background: "true" },
      },
    })).toEqual({});

    const [event] = normalizeMessage(task({
      status: "completed",
      input: { description: "Malformed task", prompt: "Do work", subagent_type: "explore" },
      metadata: { sessionId: "ses_unverified", model: { modelID: "missing-provider" } },
    })) as ToolEvent[];
    expect(event).toMatchObject({ childSessionId: "ses_unverified" });
    expect(event).not.toHaveProperty("taskExecution");
    expect(event).not.toHaveProperty("taskModel");

    expect(taskMetadataOf({
      type: "tool",
      tool: "task",
      state: {
        input: { description: "Bad flag", prompt: "Do work", subagent_type: "explore" },
        metadata: {
          parentSessionId: "ses_parent",
          sessionId: "ses_child",
          model: { providerID: "anthropic", modelID: "claude-opus-5" },
          background: false,
        },
      },
    })).toEqual({});
  });

  it("does not attach task metadata to generic tools", () => {
    expect(taskMetadataOf({
      type: "tool",
      tool: "bash",
      state: {
        input: { subagent_type: "plan", background: true },
        metadata: { sessionId: "ses_wrong", model: { modelID: "wrong" }, effort: "high" },
      },
    })).toEqual({});
  });
});

describe("messageMode", () => {
  // A conversation can switch modes, so every case below is decided from ONE
  // message. Anything that cannot be decided that way must stay neutral.

  it("reads a user prompt's mode from its exact primary agent", () => {
    expect(messageMode({ role: "user", agent: "plan" })).toBe("plan");
    expect(messageMode({ role: "user", agent: "build" })).toBe("build");
  });

  it("ignores a user prompt's mode field, which upstream does not populate", () => {
    expect(messageMode({ role: "user", mode: "plan" })).toBeUndefined();
    expect(messageMode({ role: "user", agent: "explore", mode: "plan" })).toBeUndefined();
  });

  it("prefers an assistant message's recognized mode", () => {
    expect(messageMode({ role: "assistant", mode: "plan" })).toBe("plan");
    expect(messageMode({ role: "assistant", mode: "build" })).toBe("build");
    expect(messageMode({ role: "assistant", mode: "build", agent: "build" })).toBe("build");
  });

  it("falls back to an assistant message's exact agent when mode is absent or unknown", () => {
    expect(messageMode({ role: "assistant", agent: "plan" })).toBe("plan");
    // An unrecognized label says nothing about who authored the turn, so it
    // does not disqualify the identity underneath it.
    expect(messageMode({ role: "assistant", mode: "chat", agent: "build" })).toBe("build");
    // …and it does not resurrect an identity that is not a mode either.
    expect(messageMode({ role: "assistant", mode: "chat", agent: "explore" })).toBeUndefined();
  });

  it("omits mode when a recognized mode and agent disagree", () => {
    expect(messageMode({ role: "assistant", mode: "plan", agent: "build" })).toBeUndefined();
    expect(messageMode({ role: "assistant", mode: "build", agent: "plan" })).toBeUndefined();
  });

  it("stays neutral for an internal or sub-agent identity with no mode", () => {
    for (const agent of ["general", "explore", "compaction", "some-future-agent"]) {
      expect(messageMode({ role: "assistant", agent }), agent).toBeUndefined();
    }
  });

  // `info.mode` is the primary signal, so it classifies the row even when the
  // author is internal. The badge is provenance, not proof of policy: per #75
  // a child can report Build while retaining a parent's historical Plan denies.
  it("lets a recognized mode classify an internal or sub-agent turn", () => {
    for (const agent of ["general", "explore", "compaction", "some-future-agent"]) {
      expect(messageMode({ role: "assistant", agent, mode: "build" }), agent).toBe("build");
      expect(messageMode({ role: "assistant", agent, mode: "plan" }), agent).toBe("plan");
    }
  });

  it("stays neutral for missing, empty and non-string metadata", () => {
    expect(messageMode({ role: "assistant" })).toBeUndefined();
    expect(messageMode({ role: "user" })).toBeUndefined();
    expect(messageMode({})).toBeUndefined();
    expect(messageMode({ role: "assistant", agent: "" })).toBeUndefined();
    expect(messageMode({ role: "user", agent: "" })).toBeUndefined();
    expect(messageMode({ role: "assistant", mode: "Plan" })).toBeUndefined();
    expect(messageMode({ role: "user", agent: "Build" })).toBeUndefined();
    expect(messageMode({ role: "assistant", agent: 1 as unknown as string })).toBeUndefined();
    expect(messageMode({ role: "assistant", mode: 1 as unknown as string })).toBeUndefined();
  });
});

describe("mode on transcript rows", () => {
  const prose = (info: RawMessage["info"], text: string): RawMessage => ({
    info,
    parts: [{ id: `prt_${info?.id}`, messageID: info?.id, type: "text", text }],
  });

  it("attaches the normalized mode to user and assistant prose", () => {
    const [user] = normalizeMessage(
      prose({ id: "m1", role: "user", agent: "plan", time: { created: 1 } }, "Draft an approach"),
    ) as UserEvent[];
    const [assistant] = normalizeMessage(
      prose({ id: "m2", role: "assistant", mode: "build", time: { created: 2 } }, "Editing now"),
    ) as AgentEvent[];

    expect(user.mode).toBe("plan");
    expect(assistant.mode).toBe("build");
  });

  it("omits the key entirely when nothing classifies the message", () => {
    const [assistant] = normalizeMessage(
      prose({ id: "m3", role: "assistant", agent: "explore", time: { created: 3 } }, "Reading files"),
    );
    expect(assistant).not.toHaveProperty("mode");
  });

  it("does not mark thoughts, tools or patch rows", () => {
    const events = normalizeMessage({
      info: { id: "m4", role: "assistant", agent: "plan", time: { created: 4 } },
      parts: [
        { id: "p1", messageID: "m4", type: "reasoning", text: "Considering options", time: { start: 4, end: 5 } },
        { id: "p2", messageID: "m4", type: "tool", tool: "read", state: { status: "completed" } },
        { id: "p3", messageID: "m4", type: "patch", hash: "h", files: ["a.ts"] },
      ],
    });
    expect(events.map((event) => event.kind)).toEqual(["thought", "tool", "patch"]);
    for (const event of events) expect(event).not.toHaveProperty("mode");
  });

  // A hand-back is machine-authored; a Plan/Build badge would claim the human
  // chose a mode for a message they never sent.
  it("does not mark a sub-agent hand-back notice", () => {
    const [notice] = normalizeMessage(
      prose(
        { id: "m5", role: "user", agent: "build", time: { created: 5 } },
        "Background task ses_child_abc123 completed successfully.",
      ),
    );
    expect(notice.kind).toBe("status");
    expect(notice).not.toHaveProperty("mode");
  });
});

describe("milestone rows", () => {
  const { events } = normalizeTranscript(messages);

  it("preserves patch files and the directly stated initiating user message", () => {
    const patch = events.find((e) => e.id === "prt_patch_001")!;
    expect(patch).toEqual(expect.objectContaining({
      kind: "patch",
      files: ["server/index.ts", "tests/health.test.ts"],
      fileCount: 2,
      filesTruncated: false,
      userMessageId: "msg_user_001",
    }));
  });

  it("does not infer an initiating user message when parentID is absent", () => {
    const [patch] = normalizeMessage({
      info: { id: "m_patch", role: "assistant", time: { created: 1 } },
      parts: [{ id: "p_patch", type: "patch", files: ["src/a.ts"] }],
    });
    expect(patch.kind).toBe("patch");
    expect(patch).not.toHaveProperty("userMessageId");
  });

  it("drops malformed patch file names at the adapter seam", () => {
    const [patch] = normalizeMessage({
      info: { id: "m_patch", role: "assistant", parentID: "m_user", time: { created: 1 } },
      parts: [{ id: "p_patch", type: "patch", files: [" src/a.ts ", "", 42 as unknown as string] }],
    });
    expect(patch).toEqual(expect.objectContaining({
      kind: "patch",
      files: ["src/a.ts"],
      fileCount: 3,
      filesTruncated: true,
    }));
  });

  it("bounds patch filename count, each path, and aggregate path metadata", () => {
    const rawFiles = Array.from({ length: PATCH_FILE_METADATA_LIMITS.displayedFiles + 4 }, (_, index) =>
      `src/${index}/${"x".repeat(PATCH_FILE_METADATA_LIMITS.pathCharacters * 2)}.ts`
    );
    const [patch] = normalizeMessage({
      info: { id: "m_patch", role: "assistant", parentID: "m_user", time: { created: 1 } },
      parts: [{ id: "p_patch", type: "patch", files: rawFiles }],
    });
    expect(patch.kind).toBe("patch");
    if (patch.kind !== "patch") return;
    expect(patch.fileCount).toBe(rawFiles.length);
    expect(patch.filesTruncated).toBe(true);
    expect(patch.files.length).toBeLessThanOrEqual(PATCH_FILE_METADATA_LIMITS.displayedFiles);
    expect(patch.files.every((file) => file.length <= PATCH_FILE_METADATA_LIMITS.pathCharacters)).toBe(true);
    expect(patch.files.reduce((total, file) => total + file.length, 0)).toBeLessThanOrEqual(
      PATCH_FILE_METADATA_LIMITS.aggregatePathCharacters,
    );
  });

  it("does not inspect filename entries beyond the bounded display window", () => {
    const rawFiles = Array.from({ length: PATCH_FILE_METADATA_LIMITS.displayedFiles + 1 }, (_, index) => `src/${index}.ts`);
    Object.defineProperty(rawFiles, PATCH_FILE_METADATA_LIMITS.displayedFiles, {
      get: () => { throw new Error("unbounded filename access"); },
    });

    const [patch] = normalizeMessage({
      info: { id: "m_patch", role: "assistant", time: { created: 1 } },
      parts: [{ id: "p_patch", type: "patch", files: rawFiles }],
    });
    expect(patch).toEqual(expect.objectContaining({
      fileCount: PATCH_FILE_METADATA_LIMITS.displayedFiles + 1,
      files: rawFiles.slice(0, PATCH_FILE_METADATA_LIMITS.displayedFiles),
      filesTruncated: true,
    }));
  });

  it("marks automatic compaction", () => {
    const compaction = events.find((e) => e.id === "prt_compaction_001")!;
    expect((compaction as { label: string }).label).toBe("Context compacted automatically");
  });
});

describe("usage", () => {
  it("collects one snapshot per step-finish, for the status bar", () => {
    const { usage } = normalizeTranscript(messages);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toEqual({
      messageId: "msg_asst_001",
      cost: 0.0421,
      tokens: { input: 100, output: 900, reasoning: 250, cacheRead: 10000, cacheWrite: 750, total: 12000 },
    });
  });

  it("attaches final message metrics and a cumulative cost to agent prose", () => {
    const transcript = normalizeTranscript([
      {
        info: { id: "assistant-one", role: "assistant", time: { created: 1_000, completed: 3_500 } },
        parts: [
          { id: "text-one", type: "text", text: "First" },
          { id: "finish-one", type: "step-finish", cost: 0.0012, tokens: { input: 10, output: 4 } },
        ],
      },
      {
        info: { id: "assistant-two", role: "assistant", time: { created: 4_000, completed: 5_000 } },
        parts: [
          { id: "text-two-a", type: "text", text: "Second A" },
          { id: "finish-two-a", type: "step-finish", cost: 0.002, tokens: { input: 20, output: 5, cache: { read: 6 } } },
          { id: "text-two-b", type: "text", text: "Second B" },
          { id: "finish-two-b", type: "step-finish", cost: 0.003, tokens: { input: 30, output: 7, reasoning: 2 } },
        ],
      },
    ]);
    const prose = transcript.events.filter((event) => event.kind === "agent");
    expect(prose[0]).toMatchObject({ metricsStatus: "final", costStatus: "final", messageCost: 0.0012, cumulativeCost: 0.0012, messageDurationMs: 2_500 });
    expect(prose[1]).not.toHaveProperty("messageCost");
    expect(prose[2]).toMatchObject({
      messageCost: 0.005,
      cumulativeCost: 0.0062,
      messageDurationMs: 1_000,
      inputTokens: 50,
      outputTokens: 12,
      reasoningTokens: 2,
      cacheReadTokens: 6,
      cacheWriteTokens: 0,
    });
  });

  it("marks in-flight and completed messages without usage honestly", () => {
    const transcript = normalizeTranscript([
      { info: { id: "pending", role: "assistant", time: { created: 1_000 } }, parts: [{ id: "p", type: "text", text: "Streaming" }] },
      { info: { id: "done", role: "assistant", time: { created: 2_000, completed: 3_000 } }, parts: [{ id: "d", type: "text", text: "No usage" }] },
    ]);
    expect(transcript.events.filter((event) => event.kind === "agent")).toMatchObject([
      { metricsStatus: "pending", costStatus: "pending" },
      { metricsStatus: "final", costStatus: "unavailable", durationStatus: "final" },
    ]);
  });
});

describe("toolDetail", () => {
  it("prefers a command over other fields", () => {
    expect(toolDetail({ command: "npm test", timeout: 1 })).toBe("npm test");
  });

  it("collapses whitespace and truncates long values", () => {
    expect(toolDetail({ command: "a\n\n  b" })).toBe("a b");
    const long = toolDetail({ command: "x".repeat(300) })!;
    expect(long).toHaveLength(160);
    expect(long.endsWith("…")).toBe(true);
  });

  // Regression guard: the predecessor rendered whole file bodies into chips
  // because it stringified the whole argument object.
  it("ignores bulky fields like file contents", () => {
    expect(toolDetail({ content: "x".repeat(5000) })).toBeUndefined();
    expect(toolDetail({ new_str: "whole file body" })).toBeUndefined();
  });

  it("returns undefined for absent or unrecognised input", () => {
    expect(toolDetail(undefined)).toBeUndefined();
    expect(toolDetail({ mystery: 42 })).toBeUndefined();
  });
});

describe("detectInterrupted", () => {
  it("reports nothing while the session is running", () => {
    expect(detectInterrupted(messages, true)).toEqual({ interrupted: false });
  });

  // The last fixture message is an assistant turn with no time.completed.
  it("flags an assistant turn that never completed", () => {
    expect(detectInterrupted(messages, false)).toEqual({
      interrupted: true,
      reason: "incomplete-turn",
    });
  });

  it("flags a user prompt that was never answered", () => {
    const trailing: RawMessage[] = [
      { info: { id: "m1", role: "user", time: { created: 1 } }, parts: [] },
    ];
    expect(detectInterrupted(trailing, false)).toEqual({
      interrupted: true,
      reason: "never-answered",
    });
  });

  it("treats a completed assistant turn as healthy", () => {
    const done: RawMessage[] = [
      { info: { id: "m1", role: "assistant", time: { created: 1, completed: 2 } }, parts: [] },
    ];
    expect(detectInterrupted(done, false)).toEqual({ interrupted: false });
  });

  it("handles an empty transcript", () => {
    expect(detectInterrupted([], false)).toEqual({ interrupted: false });
  });
});

describe("frozen contract", () => {
  // The whole migration is cheap because row components never see raw backend
  // shapes. This test is the enforcement: if an adapter change starts passing
  // provider metadata or nested backend objects through, it fails here.
  //
  // Verified against 1,133 real messages / 1,592 events from a live 1.18.19
  // server before being written down.
  const ALLOWED: Record<string, string[]> = {
    user: ["kind", "id", "messageId", "timestamp", "text", "reminders", "workflows", "attachments", "mode"],
    agent: [
      "kind", "id", "messageId", "timestamp", "text", "mode",
      "metricsStatus", "costStatus", "cumulativeCostStatus", "durationStatus",
      "messageCost", "cumulativeCost", "messageDurationMs", "inputTokens", "outputTokens",
      "reasoningTokens", "cacheReadTokens", "cacheWriteTokens",
    ],
    thought: ["kind", "id", "messageId", "timestamp", "text", "durationMs"],
    tool: [
      "kind", "id", "messageId", "timestamp", "status", "name",
      "title", "detail", "commandText", "output", "error", "durationMs", "attachments",
      "taskExecution", "taskAgent", "taskModel", "childSessionId",
    ],
    patch: ["kind", "id", "messageId", "timestamp", "files", "fileCount", "filesTruncated", "userMessageId"],
    status: ["kind", "id", "messageId", "timestamp", "label", "detail", "childSessionId"],
    error: ["kind", "id", "messageId", "timestamp", "message"],
  };

  const { events } = normalizeTranscript(messages);

  it("emits no keys outside the contract", () => {
    for (const event of events) {
      const extra = Object.keys(event).filter((k) => !ALLOWED[event.kind].includes(k));
      expect(extra, `${event.kind} (${event.id})`).toEqual([]);
    }
  });

  it("emits only scalars, except attachments", () => {
    for (const event of events) {
      for (const [key, value] of Object.entries(event)) {
        if (key === "attachments" || key === "reminders" || key === "workflows" || key === "files") continue;
        expect(
          value === null || typeof value !== "object",
          `${event.kind}.${key} must not be a nested backend object`,
        ).toBe(true);
      }
    }
  });

  it("keeps attachments to the declared fields", () => {
    for (const event of events) {
      if (!("attachments" in event)) continue;
      for (const attachment of event.attachments) {
        const extra = Object.keys(attachment).filter(
          (k) => !["filename", "mime", "url", "path"].includes(k),
        );
        expect(extra).toEqual([]);
      }
    }
  });

  it("keeps patch files as display-only strings", () => {
    for (const event of events) {
      if (event.kind !== "patch") continue;
      expect(event.files.every((file) => typeof file === "string")).toBe(true);
    }
  });
});

describe("normalizeMessage", () => {
  it("emits an error row for a failed turn that produced no parts", () => {
    const events = normalizeMessage({
      info: { id: "m9", role: "assistant", time: { created: 5 }, error: { message: "boom" } },
      parts: [],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "error", message: "boom" });
  });

  it("keeps a turn-level error alongside partial output", () => {
    const events = normalizeMessage({
      info: { id: "m9", role: "assistant", time: { created: 5 }, error: { message: "boom" } },
      parts: [{ id: "p9", messageID: "m9", type: "text", text: "partial answer" }],
    });
    expect(events).toMatchObject([
      { kind: "agent", text: "partial answer" },
      { kind: "error", message: "boom" },
    ]);
  });

  it("extracts errors from newer nested OpenCode envelopes", () => {
    const nested = normalizeMessage({ info: { id: "nested", role: "assistant", time: { created: 5 }, error: { data: { message: "provider quota exceeded" } } }, parts: [] });
    const alternate = normalizeMessage({ info: { id: "alternate", role: "assistant", time: { created: 5 }, error: { error: "connection refused" } }, parts: [] });
    expect(nested[0]).toMatchObject({ kind: "error", message: "provider quota exceeded" });
    expect(alternate[0]).toMatchObject({ kind: "error", message: "connection refused" });
  });

  it("produces ISO timestamps", () => {
    const [event] = normalizeMessage({
      info: { id: "m10", role: "user", time: { created: 1787000000000 } },
      parts: [{ id: "p", messageID: "m10", type: "text", text: "hi" }],
    });
    expect(event.timestamp).toBe(new Date(1787000000000).toISOString());
  });
});
