import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaudeSupervisor } from "../server/claude/supervisor.js";
import type { ClaudeConfig, ClaudeWorkspace } from "../server/claude/config.js";

import { ClaudeApprovalStore } from "../server/claude/approvals.js";
import { APPROVER_PROMPT_TOOL, APPROVER_SOURCE, claudeApproverConfig } from "../server/claude/approver.js";
import { claudeSettings } from "../server/claude/supervisor.js";
import type { ClaudePreset } from "../server/claude/config.js";

const build: ClaudePreset = { id: "b", label: "B", model: "claude-opus-5", permissionMode: "default", mode: "build" };
const ask = (store: ClaudeApprovalStore, toolName = "Write", toolUseId = "toolu_1") =>
  store.ask({ sessionId: "s1", toolName, toolUseId, input: { file_path: "/w/a.txt" } });

describe("Claude approval store", () => {
  it("allows a tool the user answered 'always' without asking a second time", async () => {
    const store = new ClaudeApprovalStore();
    const first = ask(store);
    const [pending] = store.list("s1");
    expect(store.reply(pending.id, "always")).toBe(true);
    expect(await first).toMatchObject({ behavior: "allow" });
    // The standing rule answers immediately: nothing is queued for the user.
    expect(await ask(store, "Write", "toolu_2")).toMatchObject({ behavior: "allow" });
    expect(store.list("s1")).toEqual([]);
    // It is scoped to the tool that was approved, not the whole session.
    const other = ask(store, "Bash", "toolu_3");
    expect(store.list("s1")).toHaveLength(1);
    store.reply(store.list("s1")[0].id, "reject");
    expect(await other).toMatchObject({ behavior: "deny" });
  });

  it("sends a rejection reason back to the model rather than a bare refusal", async () => {
    const store = new ClaudeApprovalStore();
    const pendingDecision = ask(store);
    store.reply(store.list("s1")[0].id, "reject", "not that file");
    expect(await pendingDecision).toEqual({ behavior: "deny", message: "not that file" });
  });

  it("refuses a check nobody answers instead of letting it through", async () => {
    const store = new ClaudeApprovalStore(20);
    const decision = await ask(store);
    expect(decision.behavior).toBe("deny");
    expect(decision.message).toContain("no answer");
    expect(store.list("s1")).toEqual([]);
  });

  it("joins a re-issued check to the wait already in front of the user", async () => {
    const store = new ClaudeApprovalStore();
    const first = ask(store, "Write", "toolu_same");
    const retry = ask(store, "Write", "toolu_same");
    // A dropped MCP connection re-runs the check; the user must not see two rows.
    expect(store.list("s1")).toHaveLength(1);
    store.reply(store.list("s1")[0].id, "once");
    expect(await first).toMatchObject({ behavior: "allow" });
    expect(await retry).toMatchObject({ behavior: "allow" });
  });

  it("refuses whatever is still pending when the turn ends", async () => {
    const store = new ClaudeApprovalStore();
    const decision = ask(store);
    store.cancelSession("s1");
    expect(await decision).toMatchObject({ behavior: "deny" });
    expect(store.list("s1")).toEqual([]);
  });

  it("keeps each session's answers to itself", async () => {
    const store = new ClaudeApprovalStore();
    const first = ask(store);
    store.reply(store.list("s1")[0].id, "always");
    await first;
    const other = store.ask({ sessionId: "s2", toolName: "Write", toolUseId: "t9", input: {} });
    // s1's standing rule must not pre-approve s2.
    expect(store.list("s2")).toHaveLength(1);
    store.reply(store.list("s2")[0].id, "reject");
    expect(await other).toMatchObject({ behavior: "deny" });
  });
  it("auto-approves when the autoApprove callback returns true", async () => {
    const store = new ClaudeApprovalStore();
    store.autoApprove = (sessionId) => sessionId === "s1";

    const autoApproved: string[] = [];
    store.on("auto-approved", ({ toolName }: { toolName: string }) => autoApproved.push(toolName));

    // s1 is auto-approved: resolves immediately, nothing queued.
    const decision = await ask(store, "Bash", "toolu_auto1");
    expect(decision).toMatchObject({ behavior: "allow" });
    expect(store.list("s1")).toEqual([]);
    expect(autoApproved).toEqual(["Bash"]);

    // s2 is NOT auto-approved: queued normally.
    const pending = store.ask({ sessionId: "s2", toolName: "Bash", toolUseId: "toolu_auto2", input: {} });
    expect(store.list("s2")).toHaveLength(1);
    store.reply(store.list("s2")[0].id, "reject");
    expect(await pending).toMatchObject({ behavior: "deny" });
  });

  it("falls through to manual approval when autoApprove returns false", async () => {
    const store = new ClaudeApprovalStore();
    store.autoApprove = () => false;

    const pending = ask(store, "Write", "toolu_manual");
    expect(store.list("s1")).toHaveLength(1);
    store.reply(store.list("s1")[0].id, "once");
    expect(await pending).toMatchObject({ behavior: "allow" });
  });
});

describe("Claude approver", () => {
  it("stops pre-allowing the mutation tools once something can answer for them", () => {
    // Ungated Build must name them or headless claude denies them outright.
    const ungated = claudeSettings(build) as { permissions: { allow: string[] } };
    expect(ungated.permissions.allow).toEqual(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
    // Gated Build must not: naming them here would pre-approve the very calls
    // the prompt tool exists to gate, so it would never be consulted.
    const gated = claudeSettings(build, true) as { permissions: { allow: string[]; ask: string[] } };
    expect(gated.permissions.allow).toEqual([]);
    expect(gated.permissions.ask).toEqual([]);
  });

  it("names the prompt tool the way the CLI resolves an MCP tool", () => {
    expect(APPROVER_PROMPT_TOOL).toBe("mcp__dcaleon_approvals__approve");
  });

  it("keeps the gate's url and token out of the child's argv", () => {
    const document = claudeApproverConfig({
      nodePath: "/usr/bin/node", scriptPath: "/state/approver.mjs",
      url: "http://127.0.0.1:3000/api/claude/internal/approvals", token: "secret-token", sessionId: "s1",
    }) as { mcpServers: Record<string, { args: string[]; env: Record<string, string> }> };
    const server = document.mcpServers.dcaleon_approvals;
    expect(server.args).toEqual(["/state/approver.mjs"]);
    expect(server.args.join(" ")).not.toContain("secret-token");
    expect(server.env.DCALEON_APPROVAL_TOKEN).toBe("secret-token");
  });

  it("generates an approver that denies rather than allows when the gate fails", () => {
    // Every failure path in the generated script must refuse: an approver that
    // cannot reach its gate must not become an implicit approval.
    expect(APPROVER_SOURCE).toContain('behavior: "deny"');
    expect(APPROVER_SOURCE).not.toContain('behavior: "allow"');
    expect(APPROVER_SOURCE).toContain("response.ok");
  });
});

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

/** A fake `claude` that reports the argv it was handed, so the flags are observable. */
async function spawned(input: { approvals?: { url: string; token: string } }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-approve-"));
  temporary.push(root);
  const bin = path.join(root, "fake-claude.mjs");
  await writeFile(bin, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ type: "argv", argv: process.argv.slice(2) }) + "\\n");\n');
  await chmod(bin, 0o755);
  const workspace: ClaudeWorkspace = { id: "ws", label: "WS", directory: root, device: 0, inode: 0 };
  const sessionRoot = path.join(root, "sessions");
  const config = {
    enabled: true, configured: true, binaryPath: bin, cliVersion: "2.1.263",
    sessionRoot, ledgerFile: path.join(root, "ledger.json"),
    approvals: Boolean(input.approvals), presets: [build], workspaces: [workspace], errors: [],
  } as unknown as ClaudeConfig;
  const supervisor = new ClaudeSupervisor(config);
  let argv: string[] = [];
  supervisor.on("frame", ({ frame }: { frame: Record<string, unknown> }) => {
    if (frame.type === "argv") argv = frame.argv as string[];
  });
  await supervisor.run({
    session: { id: "s1", sessionUuid: "uuid-1", started: false },
    preset: build, workspace, turnMode: "build", text: "hi",
    ...(input.approvals ? { approvals: input.approvals } : {}),
  });
  await vi.waitFor(() => expect(argv.length).toBeGreaterThan(0));
  return { argv, sessionRoot };
}

describe("Claude supervisor approval wiring", () => {
  it("routes a gated Build turn through the prompt tool instead of pre-approving it", async () => {
    const { argv, sessionRoot } = await spawned({ approvals: { url: "http://127.0.0.1:3000/api/claude/internal/approvals", token: "tok" } });
    // The mode is what makes the CLI consult anything at all.
    expect(argv).toContain("default");
    expect(argv).not.toContain("bypassPermissions");
    expect(argv).toContain("--permission-prompt-tool");
    expect(argv[argv.indexOf("--permission-prompt-tool") + 1]).toBe(APPROVER_PROMPT_TOOL);
    // The gate is reachable: both the script and the config naming it exist.
    const document = JSON.parse(await readFile(path.join(sessionRoot, "uuid-1.mcp.json"), "utf8")) as
      { mcpServers: Record<string, { args: string[]; env: Record<string, string> }> };
    expect(argv[argv.indexOf("--mcp-config") + 1]).toBe(path.join(sessionRoot, "uuid-1.mcp.json"));
    expect(document.mcpServers.dcaleon_approvals.env.DCALEON_APPROVAL_TOKEN).toBe("tok");
    await expect(readFile(document.mcpServers.dcaleon_approvals.args[0], "utf8")).resolves.toContain("tools/call");
  });

  it("leaves an ungated turn exactly as it was", async () => {
    const { argv } = await spawned({});
    expect(argv).toContain("bypassPermissions");
    expect(argv).not.toContain("--permission-prompt-tool");
    expect(argv).not.toContain("--mcp-config");
  });
});
