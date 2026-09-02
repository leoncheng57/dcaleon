import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaudeSupervisor, claudeSeatbeltProfile, claudeSettings, claudeSupervisorEnvironment } from "../server/claude/supervisor.js";
import type { ClaudeConfig, ClaudePreset, ClaudeWorkspace } from "../server/claude/config.js";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

const preset: ClaudePreset = { id: "ro", label: "RO", model: "claude-opus-5", permissionMode: "default", mode: "read-only" };
const buildPreset: ClaudePreset = { ...preset, id: "b", mode: "build" };

/** Writes an executable fake `claude` that ignores its args and emits `body`. */
async function harness(body: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-sup-"));
  temporary.push(root);
  const bin = path.join(root, "fake-claude.mjs");
  await writeFile(bin, `#!/usr/bin/env node\n${body}\n`);
  await chmod(bin, 0o755);
  const workspace: ClaudeWorkspace = { id: "ws", label: "WS", directory: root, device: 0, inode: 0 };
  const config = {
    enabled: true, configured: true, binaryPath: bin, cliVersion: "2.1.257",
    sessionRoot: path.join(root, "sessions"), ledgerFile: path.join(root, "ledger.json"),
    sandbox: "test-unsafe", presets: [preset], workspaces: [workspace], errors: [],
  } as unknown as ClaudeConfig;
  return { root, bin, workspace, config, supervisor: new ClaudeSupervisor(config) };
}

describe("Claude supervisor", () => {
  it("forwards no credential variables into the child", () => {
    const env = claudeSupervisorEnvironment({ PATH: "/bin", HOME: "/home/x", ANTHROPIC_API_KEY: "sk-secret", CLAUDE_CODE_OAUTH_TOKEN: "tok" });
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/home/x");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("provides the user identity claude needs to find its Keychain, synthesizing it when absent", () => {
    // Passed through when present.
    const forwarded = claudeSupervisorEnvironment({ PATH: "/bin", HOME: "/home/x", USER: "alice", LOGNAME: "alice" });
    expect(forwarded.USER).toBe("alice");
    expect(forwarded.LOGNAME).toBe("alice");
    // Synthesized from the process user when the (launchd-minimal) source lacks it,
    // and it is the identity, never a credential.
    const synthesized = claudeSupervisorEnvironment({ PATH: "/bin", HOME: "/home/x", ANTHROPIC_API_KEY: "sk-secret" });
    expect(synthesized.USER).toBeTruthy();
    expect(synthesized.__CF_USER_TEXT_ENCODING).toMatch(/^0x[0-9A-F]+:0x0:0x0$/u);
    expect(synthesized.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("grants the workspace write only in build mode", () => {
    const ro = claudeSeatbeltProfile({ workspace: "/w", stateRoot: "/s", binaryPath: "/b/claude", mode: "read-only", home: "/home/x" });
    const build = claudeSeatbeltProfile({ workspace: "/w", stateRoot: "/s", binaryPath: "/b/claude", mode: "build", home: "/home/x" });
    const writeLine = (profile: string) => profile.split("\n").find((line) => line.startsWith("(allow file-write*")) ?? "";
    expect(writeLine(ro)).not.toContain('(subpath "/w")');
    expect(writeLine(build)).toContain('(subpath "/w")');
    // Auth prerequisites are present in both.
    expect(ro).toContain("Library/Keychains");
    expect(ro).toContain("SecurityServer");
  });

  it("denies mutation tools in read-only and allows them by name in Build", () => {
    const ro = claudeSettings(preset) as { permissions: { allow: string[]; deny: string[]; ask: string[] } };
    expect(ro.permissions.deny).toEqual(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
    expect(ro.permissions.allow).toEqual([]);
    expect(ro.permissions.ask).toEqual([]);
    // Build must allow by name — headless claude denies a mutation tool no rule
    // explicitly allows, even under acceptEdits. Seatbelt still confines the writes.
    const build = claudeSettings(buildPreset) as { permissions: { allow: string[]; deny: string[] } };
    expect(build.permissions.allow).toEqual(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
    expect(build.permissions.deny).toEqual([]);
  });

  it("parses newline-delimited stream-json frames from the child", async () => {
    const { supervisor, workspace } = await harness(`
      process.stdout.write(JSON.stringify({ type: "system", subtype: "init", claude_code_version: "2.1.257", session_id: "x" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01 }) + "\\n");
    `);
    const frames: Array<Record<string, unknown>> = [];
    supervisor.on("frame", ({ frame }: { frame: Record<string, unknown> }) => frames.push(frame));
    await supervisor.run({ session: { id: "s1", sessionUuid: "u1", started: false }, preset, workspace, text: "hello" });
    await vi.waitFor(() => expect(frames.some((f) => f.type === "result")).toBe(true));
    expect(frames.map((f) => f.type)).toEqual(["system", "assistant", "result"]);
  });

  it("fails the turn closed when the init frame version does not match the pin", async () => {
    const { supervisor, workspace } = await harness(`
      process.stdout.write(JSON.stringify({ type: "system", subtype: "init", claude_code_version: "9.9.9" }) + "\\n");
      setTimeout(() => process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "nope" }] } }) + "\\n"), 200);
    `);
    const frames: Array<Record<string, unknown>> = [];
    supervisor.on("frame", ({ frame }: { frame: Record<string, unknown> }) => frames.push(frame));
    await supervisor.run({ session: { id: "s2", sessionUuid: "u2", started: false }, preset, workspace, text: "hello" });
    await vi.waitFor(() => expect(frames.some((f) => f.type === "error" && f.subtype === "version_mismatch")).toBe(true));
  });

  it("cancels a running child with SIGTERM", async () => {
    const { supervisor, workspace } = await harness(`
      process.stdout.write(JSON.stringify({ type: "system", subtype: "init", claude_code_version: "2.1.257" }) + "\\n");
      setInterval(() => {}, 1000); // stay alive until killed
    `);
    let exited = false;
    supervisor.on("exit", () => { exited = true; });
    await supervisor.run({ session: { id: "s3", sessionUuid: "u3", started: false }, preset, workspace, text: "hello" });
    await vi.waitFor(() => expect(supervisor.isRunning("s3")).toBe(true));
    expect(supervisor.cancel("s3")).toBe(true);
    await vi.waitFor(() => expect(exited).toBe(true));
  });
  it("grants the project's .git for a worktree Build session but never in read-only", () => {
    const extras = { extraReads: ["/proj"], extraWrites: ["/proj/.git"] };
    const build = claudeSeatbeltProfile({ workspace: "/wt", stateRoot: "/s", binaryPath: "/b/claude", mode: "build", home: "/home/x", ...extras });
    const writeLine = (profile: string) => profile.split("\n").find((line) => line.startsWith("(allow file-write*")) ?? "";
    expect(writeLine(build)).toContain('(subpath "/wt")');
    expect(writeLine(build)).toContain('(subpath "/proj/.git")');
    expect(build).toContain('(subpath "/proj")');
    // Read-only ignores the write grant entirely: a worktree read-only session cannot commit.
    const ro = claudeSeatbeltProfile({ workspace: "/wt", stateRoot: "/s", binaryPath: "/b/claude", mode: "read-only", home: "/home/x", ...extras });
    expect(writeLine(ro)).not.toContain("/proj/.git");
    expect(writeLine(ro)).not.toContain('(subpath "/wt")');
  });
  it("delivers the final result frame even when the child exits immediately after writing it", async () => {
    // Regression: listening on `exit` (not `close`) let the process end before its
    // last stdout chunk was read, so the turn was marked failed and the `result`
    // frame dropped. A real `claude --resume` lost this race intermittently.
    const { supervisor, workspace } = await harness(`
      const out = [
        JSON.stringify({ type: "system", subtype: "init", claude_code_version: "2.1.257" }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "answer" }] } }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01 }),
      ].join(String.fromCharCode(10)) + String.fromCharCode(10);
      // Write everything then let the process end on its own (a process.exit()
      // here would truncate the child's own stdout — a different bug). The parent
      // may still see the process end before it has read the pipe.
      process.stdout.write(out);
    `);
    const order: string[] = [];
    supervisor.on("frame", ({ frame }: { frame: Record<string, unknown> }) => order.push(String(frame.type)));
    supervisor.on("exit", () => order.push("EXIT"));
    await supervisor.run({ session: { id: "s4", sessionUuid: "u4", started: true }, preset, workspace, text: "hello" });
    await vi.waitFor(() => expect(order).toContain("EXIT"));
    // The result frame must precede the exit signal, every time.
    expect(order.indexOf("result")).toBeGreaterThan(-1);
    expect(order.indexOf("result")).toBeLessThan(order.indexOf("EXIT"));
  });
});
