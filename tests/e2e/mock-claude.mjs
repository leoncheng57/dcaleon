#!/usr/bin/env node
// Deterministic stand-in for the `claude` binary, so e2e runs with no Anthropic
// account, no model spend, and no network. It speaks the real `-p
// --output-format stream-json` protocol: newline-delimited JSON on stdout.
//
// It ignores every claude flag except that it reads the prompt after `-p` to
// decide slow mode. `PRIVATE ...` sentinels ride in fields the BFF must never
// surface (tool inputs, init data); the UI spec asserts none of them reach the DOM.
import process from "node:process";

const argv = process.argv.slice(2);
const promptIndex = argv.indexOf("-p");
const prompt = promptIndex >= 0 ? String(argv[promptIndex + 1] ?? "") : "";
// The real binary reports its own version; the supervisor's minimal env
// allowlist deliberately does not forward CLAUDE_CLI_VERSION into the child, so
// this fixture hardcodes the version the runtime is pinned to. Keep it in step
// with CLAUDE_CLI_VERSION in playwright.config.ts (the version-mismatch path is
// covered separately in tests/claude-supervisor.test.ts).
const version = "2.1.257";
const sessionId = "mock-claude-session";

function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

emit({
  type: "system",
  subtype: "init",
  claude_code_version: version,
  session_id: sessionId,
  model: "mock-claude",
  permissionMode: "default",
  cwd: process.cwd(),
  private_init_data: "PRIVATE INIT DATA",
  tools: ["Read", "Bash"],
});

if (prompt.includes("stay running")) {
  // Slow mode: stay alive until the supervisor sends SIGTERM (the cancel test).
  setInterval(() => {}, 1000);
} else {
  emit({ type: "assistant", message: { content: [
    { type: "thinking", thinking: "Looking at the allowlisted workspace." },
    { type: "tool_use", id: "tu_mock_1", name: "Read", input: { file: "readme.txt", note: "PRIVATE TOOL INPUT" } },
  ] } });
  emit({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "tu_mock_1", is_error: false, content: "workspace file contents" },
  ] } });
  emit({ type: "assistant", message: { content: [
    { type: "text", text: "Hello from mock claude" },
  ] } });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    total_cost_usd: 0.0123,
    stop_reason: "end_turn",
  });
  // No process.exit(): with no pending handles Node exits on its own AFTER the
  // stdout pipe drains. Calling exit() here would truncate the final frames.
}
