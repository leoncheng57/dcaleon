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

  it("maps read-only to a settings file that denies the mutation tools", () => {
    const ro = claudeSettings(preset) as { permissions: { deny: string[]; ask: string[] } };
    expect(ro.permissions.deny).toEqual(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
    expect(ro.permissions.ask).toEqual([]);
    const build = claudeSettings(buildPreset) as { permissions: { deny: string[] } };
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
});
