#!/usr/bin/env node
// Deterministic stand-in for the `claude` binary, so e2e runs with no Anthropic
// account, no model spend, and no network. It speaks the real `-p
// --output-format stream-json` protocol: newline-delimited JSON on stdout.
//
// It ignores every claude flag except that it reads the prompt after `-p` to
// decide slow mode. `PRIVATE ...` sentinels ride in fields the BFF must never
// surface (tool inputs, init data); the UI spec asserts none of them reach the DOM.
import process from "node:process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

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

if (prompt.toLowerCase().includes("simulate an interrupted turn")) {
  emit({ type: "assistant", message: { content: [{ type: "text", text: "I started the requested work, but the process is about to be interrupted." }] } });
  process.kill(process.pid, "SIGTERM");
} else if (prompt.includes("performance gallery")) {
  emit({ type: "assistant", message: { content: [{ type: "text", text: "Historical reference: see `README.md#L1` for the original request." }] } });
  for (let index = 0; index < 230; index++) {
    emit({ type: "assistant", message: { content: [{ type: "text", text: `Step ${index + 1}: **Reviewing the implementation**\n\nThe bounded transcript keeps this conversation responsive.\n\n- Inspect the affected code\n- Verify the behavior with focused tests` }] } });
  }
  emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "perf-tool", name: "Bash", input: { command: "npm test" } }] } });
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "perf-tool", content: "All tests passed." }] } });
  emit({ type: "assistant", message: { content: [{ type: "text", text: "Performance fixture complete. Earlier messages remain available through history and search." }] } });
  emit({ type: "result", subtype: "success", is_error: false, session_id: sessionId, total_cost_usd: 0.0123 });
} else if (prompt.includes("queue fixture: navigation")) {
  await new Promise((resolve) => setTimeout(resolve, 15000));
  emit({ type: "assistant", message: { content: [{ type: "text", text: `Queue echo: ${prompt}` }] } });
  emit({ type: "result", subtype: "success", is_error: false, session_id: sessionId, total_cost_usd: 0.001, stop_reason: "end_turn" });
} else if (prompt.includes("The user attached the following images")) {
  const match = prompt.match(/^- (".*")$/m);
  const imagePath = match ? JSON.parse(match[1]) : "";
  const bytes = readFileSync(imagePath);
  emit({ type: "assistant", message: { content: [{ type: "text", text: `Inspected attached image (${bytes.length} bytes)` }] } });
  emit({ type: "result", subtype: "success", is_error: false, session_id: sessionId, total_cost_usd: 0.001, stop_reason: "end_turn" });
} else if (prompt.includes("queue fixture: initial")) {
  // Long enough for the UI to enqueue several follow-ups while this turn is
  // authoritatively running. Later queue-fixture prompts complete immediately.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  emit({ type: "assistant", message: { content: [{ type: "text", text: `Queue echo: ${prompt}` }] } });
  emit({ type: "result", subtype: "success", is_error: false, session_id: sessionId, total_cost_usd: 0.001, stop_reason: "end_turn" });
} else if (prompt.includes("queue fixture:")) {
  emit({ type: "assistant", message: { content: [{ type: "text", text: `Queue echo: ${prompt}` }] } });
  emit({ type: "result", subtype: "success", is_error: false, session_id: sessionId, total_cost_usd: 0.001, stop_reason: "end_turn" });
} else if (prompt.includes("stay running")) {
  // Slow mode: stay alive until the supervisor sends SIGTERM (the cancel test).
  setInterval(() => {}, 1000);
} else if (prompt.includes('<reminder name="') || prompt.includes('<workflow name="')) {
  // Playbook echo: name which trusted sentinel blocks reached the binary, so
  // the e2e can prove injection happened server-side without leaking bodies.
  const names = [...prompt.matchAll(/<(reminder|workflow) name="([^"]+)">/g)].map(([, kind, name]) => `${kind}=${name}`);
  emit({ type: "assistant", message: { content: [{ type: "text", text: `Injected: ${names.join(" ")}` }] } });
  emit({ type: "result", subtype: "success", is_error: false, session_id: sessionId, total_cost_usd: 0.001, stop_reason: "end_turn" });
} else if (prompt.includes("write a file")) {
  // Build mode: really write into cwd (the session's project or worktree), so the
  // Changes drawer, merge and discard flows have a real diff to work with. Unique
  // content so a later session always produces a change even if the file exists.
  const target = path.join(process.cwd(), "claude-e2e.txt");
  writeFileSync(target, `written by mock claude at ${Date.now()}\n`);
  emit({ type: "assistant", message: { content: [
    { type: "tool_use", id: "tu_write_1", name: "Write", input: { file_path: target, content: "PRIVATE FILE BODY" } },
  ] } });
  emit({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "tu_write_1", is_error: false, content: "File written" },
  ] } });
  emit({ type: "assistant", message: { content: [{ type: "text", text: "Wrote claude-e2e.txt" }] } });
  emit({ type: "result", subtype: "success", is_error: false, session_id: sessionId, total_cost_usd: 0.002, stop_reason: "end_turn" });
} else {
  emit({ type: "assistant", message: { content: [
    { type: "thinking", thinking: "Looking at the allowlisted workspace." },
    { type: "tool_use", id: "tu_mock_1", name: "Read", input: { file: "readme.txt", note: "PRIVATE TOOL INPUT" } },
  ] } });
  emit({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "tu_mock_1", is_error: false, content: "workspace file contents" },
  ] } });
  emit({ type: "assistant", message: { content: [
    // The inline `README.md#L1` reference is what the file-reference wiring turns
    // into a clickable button (the e2e project fixture has a README.md at root).
    // The git `#L` line form is used rather than `README.md:1`: the shared
    // reference parser treats a root-level `name.ext:` as a URI scheme and
    // rejects it — nested `dir/file.ext:line` and the `#L` form both linkify.
    { type: "text", text: "Hello from mock claude. See `README.md#L1` for the overview." },
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
