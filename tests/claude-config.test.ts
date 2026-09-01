import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readClaudeConfig } from "../server/claude/config.js";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-config-"));
  temporary.push(root);
  const workspace = path.join(root, "workspace");
  const binary = path.join(root, "claude");
  await mkdir(workspace);
  await writeFile(binary, "#!/bin/sh\n");
  return { root, workspace, binary };
}

/** The allowlist inputs, without the platform escape hatch. */
function coreEnv(item: Awaited<ReturnType<typeof fixture>>): NodeJS.ProcessEnv {
  return {
    CLAUDE_RUNTIME_ENABLED: "true",
    CLAUDE_BINARY: item.binary,
    CLAUDE_CLI_VERSION: "2.1.257",
    CLAUDE_STATE_DIR: path.join(item.root, "state"),
    CLAUDE_PRESETS_JSON: JSON.stringify([
      { id: "readonly", label: "Read only", model: "claude-opus-5", effort: "high", permissionMode: "default", mode: "read-only" },
    ]),
    CLAUDE_WORKSPACES_JSON: JSON.stringify([{ id: "ws", label: "Workspace", directory: item.workspace }]),
  };
}

// Seatbelt is macOS-only, so a non-darwin CI run must declare itself a test to
// configure at all — mirrors the DSH config tests. sandbox is then "test-unsafe".
function baseEnv(item: Awaited<ReturnType<typeof fixture>>): NodeJS.ProcessEnv {
  return { ...coreEnv(item), NODE_ENV: "test", CLAUDE_TEST_UNSAFE: "true" };
}

describe("Claude runtime configuration", () => {
  it("stays disabled and exposes no implicit version default", () => {
    const config = readClaudeConfig({});
    expect(config.enabled).toBe(false);
    expect(config.configured).toBe(false);
    expect(config.cliVersion).toBe("");
    expect(config.presets).toEqual([]);
  });

  it("configures from an allowlisted binary, preset, and workspace", async () => {
    const item = await fixture();
    const config = readClaudeConfig(baseEnv(item));
    expect(config.configured).toBe(true);
    expect(config.errors).toEqual([]);
    expect(config.binaryPath).toBe(realpathSync(item.binary));
    expect(config.presets[0]).toMatchObject({ id: "readonly", model: "claude-opus-5", mode: "read-only", permissionMode: "default" });
    expect(config.workspaces[0]).toMatchObject({ id: "ws", label: "Workspace" });
  });

  it.runIf(process.platform === "darwin")("defaults to the seatbelt sandbox on macOS", async () => {
    const item = await fixture();
    const config = readClaudeConfig(coreEnv(item));
    expect(config.configured).toBe(true);
    expect(config.sandbox).toBe("seatbelt");
  });

  it("fails closed when the pinned CLI version is absent", async () => {
    const item = await fixture();
    const config = readClaudeConfig({ ...baseEnv(item), CLAUDE_CLI_VERSION: "" });
    expect(config.configured).toBe(false);
    expect(config.errors.join(" ")).toContain("CLAUDE_CLI_VERSION must pin one exact CLI version");
  });

  it("fails closed when the binary path is missing or not absolute", async () => {
    const item = await fixture();
    const relative = readClaudeConfig({ ...baseEnv(item), CLAUDE_BINARY: "claude" });
    expect(relative.configured).toBe(false);
    expect(relative.errors.join(" ")).toContain("CLAUDE_BINARY must be an absolute path");
    const missing = readClaudeConfig({ ...baseEnv(item), CLAUDE_BINARY: path.join(item.root, "nope") });
    expect(missing.errors.join(" ")).toContain("CLAUDE_BINARY does not exist");
  });

  it("rejects an interactive permission mode a headless lane cannot answer", async () => {
    const item = await fixture();
    const config = readClaudeConfig({
      ...baseEnv(item),
      CLAUDE_PRESETS_JSON: JSON.stringify([{ id: "ask", label: "Ask", model: "claude-opus-5", permissionMode: "ask", mode: "read-only" }]),
    });
    expect(config.configured).toBe(false);
    expect(config.errors.join(" ")).toContain("non-interactive permissionMode");
  });

  it("accepts Build mode and rejects an unknown mode", async () => {
    const item = await fixture();
    const build = readClaudeConfig({
      ...baseEnv(item),
      CLAUDE_PRESETS_JSON: JSON.stringify([{ id: "build", label: "Build", model: "claude-opus-5", permissionMode: "acceptEdits", mode: "build" }]),
    });
    expect(build.configured).toBe(true);
    expect(build.presets[0].mode).toBe("build");
    const unknown = readClaudeConfig({
      ...baseEnv(item),
      CLAUDE_PRESETS_JSON: JSON.stringify([{ id: "bad", label: "Bad", model: "claude-opus-5", permissionMode: "default", mode: "sideways" }]),
    });
    expect(unknown.configured).toBe(false);
    expect(unknown.errors.join(" ")).toContain("mode=read-only|build");
  });

  it("refuses the unsafe path outside an explicit test process", async () => {
    const item = await fixture();
    for (const nodeEnv of ["production", "development"]) {
      const config = readClaudeConfig({ ...coreEnv(item), CLAUDE_TEST_UNSAFE: "true", NODE_ENV: nodeEnv });
      expect(config.configured).toBe(false);
      expect(config.sandbox).toBe("seatbelt");
      expect(config.errors.join(" ")).toContain("CLAUDE_TEST_UNSAFE is test-only");
    }
    expect(readClaudeConfig({ ...coreEnv(item), CLAUDE_TEST_UNSAFE: "true", NODE_ENV: "test" }).sandbox).toBe("test-unsafe");
  });

  it("rejects a state directory that overlaps a workspace", async () => {
    const item = await fixture();
    const config = readClaudeConfig({ ...baseEnv(item), CLAUDE_STATE_DIR: path.join(item.workspace, "state") });
    expect(config.configured).toBe(false);
    expect(config.errors.join(" ")).toContain("must not overlap workspace");
  });
});
