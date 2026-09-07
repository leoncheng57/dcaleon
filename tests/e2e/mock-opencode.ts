// tests/e2e/mock-opencode.ts
//
// A stand-in for `opencode serve`, so e2e can run in CI with no agent, no LLM
// spend, and deterministic output.
//
// It implements only the endpoints the app actually calls, and it implements
// them the way the REAL server behaves — including the awkward parts, because
// those are exactly what regressions hide in:
//
//   - /session requires ?directory= and is scoped by it
//   - /session/{id}/message returns raw { info, parts }
//   - unknown session ids produce HTTP 500 (not 404) with an UnknownError body
//   - /global/event is SSE and emits a `server.heartbeat` that is absent from
//     the published event union
//   - /prompt_async answers 204 with no body
//
// Run standalone:  npx tsx tests/e2e/mock-opencode.ts [port]

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { ensureGitFixture } from "./git-fixture.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.resolve(here, "../fixtures/session-messages.json"), "utf8"),
) as unknown[];

const hostileMarkdown = [
  "Mobile width containment fixture.",
  "",
  `\`\`\`text\n${"code-token-".repeat(36)}\n\`\`\``,
  "",
  `| column | value |\n| --- | --- |\n| table | ${"wide-cell-".repeat(36)} |`,
  "",
  `https://example.test/${"long-url-token-".repeat(28)}`,
].join("\n");

function mobileMessages(): unknown[] {
  const result: unknown[] = [];
  for (let index = 0; index < 24; index += 1) {
    const created = 1787100000000 + index * 2_000;
    result.push(
      {
        info: { id: `msg_mobile_user_${index}`, role: "user", agent: "build", time: { created } },
        parts: [{ id: `prt_mobile_user_${index}`, messageID: `msg_mobile_user_${index}`, type: "text", text: `History prompt ${index + 1}` }],
      },
      {
        info: { id: `msg_mobile_agent_${index}`, role: "assistant", agent: "build", time: { created: created + 1_000, completed: created + 1_500 } },
        parts: [{ id: `prt_mobile_agent_${index}`, messageID: `msg_mobile_agent_${index}`, type: "text", text: `History response ${index + 1}. ${"Readable transcript content. ".repeat(3)}` }],
      },
    );
  }
  result.push({
    info: { id: "msg_mobile_live", role: "assistant", agent: "build", time: { created: 1787100100000 } },
    parts: [{ id: "prt_mobile_live", messageID: "msg_mobile_live", type: "text", text: hostileMarkdown }],
  });
  return result;
}

// ── Plan / Build provenance fixture ─────────────────────────────────────────
//
// Every classification path the adapter distinguishes, in one session: the two
// user prompts, the assistant `mode` field, the assistant `agent` fallback, a
// sub-agent identity carrying a mode (classified, because mode is primary), a
// sub-agent identity carrying none (neutral), and a mode/agent conflict
// (neutral). The last message is deliberately hostile markdown so the rail is
// proven not to reintroduce horizontal overflow.
function modeMessages(): unknown[] {
  const prose = (
    id: string,
    info: Record<string, unknown>,
    text: string,
    created: number,
  ): unknown => ({
    info: { id, time: { created, completed: created + 500 }, ...info },
    parts: [{ id: `prt_${id}`, messageID: id, type: "text", text }],
  });
  return [
    prose("msg_mode_user_plan", { role: "user", agent: "plan" }, "Draft the migration approach.", 1787500000000),
    prose("msg_mode_agent_plan", { role: "assistant", mode: "plan" }, "Planned response: nothing will be written yet.", 1787500001000),
    prose("msg_mode_user_build", { role: "user", agent: "build" }, "Go ahead and implement it.", 1787500002000),
    // No `mode` field: exercises the exact-agent fallback.
    prose("msg_mode_agent_build", { role: "assistant", agent: "build" }, "Build response: applying the change now.", 1787500003000),
    // A sub-agent identity carrying a mode: `info.mode` is the primary signal,
    // so it classifies the row even though `explore` is not a primary agent.
    prose("msg_mode_agent_subagent", { role: "assistant", agent: "explore", mode: "build" }, "Delegated response: surveying the tree.", 1787500004000),
    // The same identity with nothing to classify it. Neutral.
    prose("msg_mode_agent_unstamped", { role: "assistant", agent: "explore" }, "Unstamped response: no mode metadata.", 1787500004500),
    // Recognized mode and agent disagree. Neutral rather than a guess.
    prose("msg_mode_agent_conflict", { role: "assistant", agent: "plan", mode: "build" }, "Conflicted response: metadata disagrees.", 1787500005000),
    // Text chosen not to collide with the substring matchers above.
    prose("msg_mode_agent_wide", { role: "assistant", mode: "build" }, `Containment fixture for a mode-marked row.\n\n${hostileMarkdown}`, 1787500006000),
  ];
}

// ── Workspace file reference fixture ────────────────────────────────────────
//
// One assistant turn carrying every candidate shape the parser distinguishes,
// so a single deterministic session proves both that verified references
// become controls and that unsafe, missing, ignored, secret, prose and fenced
// candidates stay inert. Built by join() because the body contains a fence.
function filesMessages(directory: string): unknown[] {
  const prose = [
    "Reviewing the fixture project.",
    "",
    "The port constant is at `src/index.ts:12`, and the defaults span `src/index.ts:8-11`.",
    "",
    "Git-style ranges work too: `docs/guide.md#L1-L3`.",
    "",
    "An explicit local link: [the guide](file:docs/guide.md#L3).",
    "",
    "None of these may become controls: `src/missing.ts`, `../../etc/passwd`, `.env`,",
    "`generated.txt`, `https://example.test/src/index.ts`, and `npm test`.",
    "",
    "A prose mention of src/index.ts must stay prose.",
    "",
    "```text",
    "`src/index.ts:12`",
    "```",
    "",
    "Deeply nested: `src/deep/nested.ts`.",
  ].join("\n");
  return [
    {
      info: { id: "msg_files_user", role: "user", agent: "build", time: { created: 1787600000000 } },
      parts: [
        { id: "prt_files_user", messageID: "msg_files_user", type: "text", text: "Show me the entry point." },
        {
          // A structured attachment: an absolute path the UI must relativise
          // before it can be validated or opened.
          id: "prt_files_attachment",
          messageID: "msg_files_user",
          type: "file",
          filename: "index.ts",
          mime: "text/plain",
          source: { type: "file", path: `${directory}/src/index.ts` },
        },
      ],
    },
    {
      info: { id: "msg_files_agent", role: "assistant", agent: "build", mode: "build", time: { created: 1787600001000, completed: 1787600002000 } },
      parts: [{ id: "prt_files_agent", messageID: "msg_files_agent", type: "text", text: prose }],
    },
  ];
}

function paginatedMessages(): unknown[] {
  return Array.from({ length: 225 }, (_, index) => {
    const number = index + 1;
    return {
      info: { id: `msg_page_${number}`, role: number % 2 ? "user" : "assistant", agent: "build", time: { created: 1787300000000 + number, completed: 1787300000000 + number } },
      parts: [{ id: `prt_page_${number}`, messageID: `msg_page_${number}`, type: "text", text: `Paged message ${number}` }],
    };
  });
}

// ── Sub-agent fixture ───────────────────────────────────────────────────────
//
// Kept in its own project directory so child sessions cannot perturb
// the hub assertions that count rows and running pills in the main fixture.
// The children deliberately cover every state and evidence path.
const PARENT_ID = "ses_mock_parent";
const CHILD_RUNNING = "ses_mock_child_running";
const CHILD_DONE = "ses_mock_child_done";
const CHILD_REPORTED = "ses_mock_child_reported";
// A sub-agent that delegated further. Nested delegation is reachable whenever
// subagent_depth allows it, and a one-level tree silently loses this row.
const GRANDCHILD = "ses_mock_grandchild";
const CHILD_UNKNOWN = "ses_mock_child_unknown";
const CHILD_FAILED = "ses_mock_child_failed";
const CHILD_LAUNCHED = "ses_mock_child_launched";
const MANAGED_API_PARENT = "ses_mock_managed_api_parent";
const MANAGED_UI_PARENT = "ses_mock_managed_ui_parent";
const MANAGED_FAILURE_PARENT = "ses_mock_managed_failure_parent";
const MANAGED_CLEANUP_FAILURE_PARENT = "ses_mock_managed_cleanup_failure_parent";
// A pre-existing managed child, so the managed/native distinction (#182) is
// visible on a plain page load — a launch performed by one spec cannot be
// screenshotted, and PR screenshot capture starts a fresh mock.
const MANAGED_SEEDED_CHILD = "ses_mock_managed_seeded_child";
const MANAGED_SEEDED_POLICY = [
  { permission: "bash", pattern: "*", action: "deny" },
  { permission: "edit", pattern: "*", action: "deny" },
];

function taskPart(
  index: number,
  sessionId: string,
  over: { status: string; description: string; agent: string; background?: boolean; modelID?: string },
): Record<string, unknown> {
  return {
    id: `prt_task_${index}`,
    messageID: "msg_parent_plan",
    type: "tool",
    callID: `call_task_${index}`,
    tool: "task",
    state: {
      status: over.status,
      input: {
        description: over.description,
        prompt: `Complete this delegated work: ${over.description}`,
        subagent_type: over.agent,
        ...(over.background ? { background: true } : {}),
      },
      title: over.description,
      metadata: {
        parentSessionId: PARENT_ID,
        sessionId,
        model: { providerID: "anthropic", modelID: over.modelID ?? "claude-opus-5" },
        ...(over.background ? { background: true } : {}),
      },
      time: { start: 1787400001000 + index, end: 1787400002000 + index },
    },
  };
}

function parentMessages(): unknown[] {
  return [
    {
      info: { id: "msg_parent_user", role: "user", agent: "build", time: { created: 1787400000000 } },
      parts: [{ id: "prt_parent_user", messageID: "msg_parent_user", type: "text", text: "Investigate three areas in parallel." }],
    },
    {
      info: { id: "msg_parent_plan", role: "assistant", agent: "build", time: { created: 1787400001000, completed: 1787400003000 } },
      parts: [
        taskPart(1, CHILD_RUNNING, {
          status: "running",
          description: "Audit the parser",
          agent: "explore",
          modelID: "claude-opus-5-with-an-intentionally-long-unbroken-model-name",
        }),
        taskPart(2, CHILD_DONE, { status: "completed", description: "Check the tests", agent: "explore" }),
        taskPart(3, CHILD_REPORTED, { status: "running", description: "Summarize the docs", agent: "general", background: true }),
        taskPart(4, CHILD_UNKNOWN, { status: "completed", description: "Crawl the changelog", agent: "general", background: true }),
        taskPart(5, CHILD_FAILED, { status: "completed", description: "Inspect the deployment", agent: "explore" }),
        taskPart(6, CHILD_LAUNCHED, { status: "running", description: "Review dependency updates", agent: "general" }),
      ],
    },
    {
      // A machine-authored hand-back. It must NOT render as a human bubble.
      info: { id: "msg_parent_notice", role: "user", time: { created: 1787400004000 } },
      parts: [{
        id: "prt_parent_notice",
        messageID: "msg_parent_notice",
        type: "text",
        text: `Background task ${CHILD_REPORTED} completed successfully.`,
      }],
    },
    {
      info: { id: "msg_parent_wrap", role: "assistant", agent: "build", time: { created: 1787400005000, completed: 1787400006000 } },
      parts: [{ id: "prt_parent_wrap", messageID: "msg_parent_wrap", type: "text", text: "Two of three sub-agents have reported back." }],
    },
  ];
}

const messages = new Map<string, unknown[]>([
  ["ses_mock_done", fixture],
  // Deep-cloned, not shared: the mock appends to these arrays when a prompt or
  // permission lands, so aliasing the fixture would leak one session's turns
  // into the other — the same class of shared-state bug this session exists to
  // avoid. The toolbar spec asserts on the cost and context readouts, which are
  // derived from message usage, so an empty transcript would not do.
  ["ses_mock_toolbar", structuredClone(fixture)],
  ["ses_mock_right_tools", structuredClone(fixture)],
  [PARENT_ID, parentMessages()],
  [CHILD_RUNNING, [
    { info: { id: "msg_cr_1", role: "user", agent: "explore", time: { created: 1787400001500 } }, parts: [{ id: "prt_cr_1", messageID: "msg_cr_1", type: "text", text: "Audit the parser" }] },
    { info: { id: "msg_cr_2", role: "assistant", agent: "explore", time: { created: 1787400001600 } }, parts: [{ id: "prt_cr_2", messageID: "msg_cr_2", type: "text", text: "Reading the parser now." }] },
  ]],
  [CHILD_DONE, [
    { info: { id: "msg_cd_1", role: "user", agent: "explore", time: { created: 1787400002500 } }, parts: [{ id: "prt_cd_1", messageID: "msg_cd_1", type: "text", text: "Check the tests" }] },
    { info: { id: "msg_cd_2", role: "assistant", agent: "explore", time: { created: 1787400002600, completed: 1787400002900 } }, parts: [{ id: "prt_cd_2", messageID: "msg_cd_2", type: "text", text: "All suites pass." }] },
  ]],
  [GRANDCHILD, [
    { info: { id: "msg_gc_1", role: "assistant", agent: "explore", time: { created: 1787400002700, completed: 1787400002800 } }, parts: [{ id: "prt_gc_1", messageID: "msg_gc_1", type: "text", text: "Flake reproduced." }] },
  ]],
  // Its own last turn never completed, so only the parent's hand-back notice
  // settles this one — which is what makes it the `parent-completion` case.
  [CHILD_REPORTED, [
    { info: { id: "msg_crp_1", role: "assistant", agent: "general", time: { created: 1787400003100 } }, parts: [{ id: "prt_crp_1", messageID: "msg_crp_1", type: "text", text: "Summarizing." }] },
  ]],
  // Launched in the background, then silently cancelled: its last turn never
  // completed and no notice ever arrived, which is the `unknown` case.
  [CHILD_UNKNOWN, [
    { info: { id: "msg_cu_1", role: "assistant", agent: "general", time: { created: 1787400003500 } }, parts: [{ id: "prt_cu_1", messageID: "msg_cu_1", type: "text", text: "Starting the crawl." }] },
  ]],
  [CHILD_FAILED, [
    { info: { id: "msg_cf_1", role: "assistant", agent: "explore", time: { created: 1787400004100 }, error: { message: "Deployment credentials were unavailable." } }, parts: [] },
  ]],
  [CHILD_LAUNCHED, []],
  [MANAGED_SEEDED_CHILD, [
    { info: { id: "msg_msc_1", role: "user", agent: "plan", time: { created: 1787411500000 } }, parts: [{ id: "prt_msc_1", messageID: "msg_msc_1", type: "text", text: "Summarize the release checklist" }] },
    { info: { id: "msg_msc_2", role: "assistant", agent: "plan", time: { created: 1787411550000, completed: 1787411600000 } }, parts: [{ id: "prt_msc_2", messageID: "msg_msc_2", type: "text", text: "Checklist summarized; nothing was modified." }] },
  ]],
  ["ses_mock_mobile", mobileMessages()],
  ["ses_mock_modes", modeMessages()],
  ["ses_mock_foreign_agent", [
    { info: { id: "msg_foreign", role: "user", agent: "explore", time: { created: 1787300000000 } }, parts: [], },
  ]],
  ["ses_mock_agent_reviewer", [
    {
      info: { id: "msg_reviewer", role: "user", agent: "reviewer", time: { created: 1787420000000 } },
      parts: [{ id: "prt_reviewer", messageID: "msg_reviewer", type: "text", text: "Review the diff." }],
    },
  ]],
  ["ses_mock_agent_departed", [
    { info: { id: "msg_departed", role: "user", agent: "departed", time: { created: 1787420001000 } }, parts: [] },
  ]],
  ["ses_mock_identity_mismatch", [
    { info: { id: "msg_mismatch", role: "user", agent: "explore", time: { created: 1787300050000 } }, parts: [], },
  ]],
  ["ses_mock_paginated", paginatedMessages()],
]);
const promptPayloads: Array<Record<string, unknown> & { sessionID: string }> = [];
let sessionListRequests = 0;
let createdSessionSequence = 0;
const rootWorkflowFailures = new Map<string, "worktree" | "session" | "prompt">();
let mobileRunning = true;
const sessionPayloads: Array<Record<string, unknown>> = [];
const toolIDs = [
  "invalid", "question", "bash", "read", "glob", "grep", "edit", "write", "task",
  "webfetch", "todowrite", "websearch", "skill", "apply_patch", "mcp_dynamic_tool",
];
type PermissionAction = "allow" | "ask" | "deny";
type PermissionRule = { permission: string; pattern: string; action: PermissionAction };
const editAliases = new Set(["edit", "write", "apply_patch"]);
const buildPermission: PermissionRule[] = [
  { permission: "*", pattern: "*", action: "ask" },
  { permission: "bash", pattern: "*", action: "ask" },
  { permission: "bash", pattern: "git *", action: "allow" },
  { permission: "bash", pattern: "rm -rf *", action: "deny" },
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "read", pattern: "**/.env", action: "deny" },
  { permission: "edit", pattern: "*", action: "allow" },
  { permission: "edit", pattern: "**/.env", action: "deny" },
  { permission: "external_directory", pattern: "*", action: "ask" },
];
const agents = [
  { name: "build", mode: "primary", description: "Primary implementation agent", options: {}, permission: buildPermission },
  { name: "plan", mode: "primary", description: "Primary planning agent", options: {}, permission: [...buildPermission, { permission: "edit", pattern: "*", action: "deny" as const }] },
  { name: "explore", mode: "subagent", description: "Fast read-only codebase exploration", options: {}, permission: [
    { permission: "*", pattern: "*", action: "deny" as const },
    { permission: "read", pattern: "*", action: "allow" as const },
    { permission: "glob", pattern: "*", action: "allow" as const },
    { permission: "grep", pattern: "*", action: "allow" as const },
    // Adversarial project override: Managed Child creation must still append a
    // hard read-only ceiling rather than trusting this mutable agent policy.
    { permission: "edit", pattern: "*", action: "allow" as const },
  ] },
  { name: "general", mode: "subagent", description: "General research and multi-step work", options: {}, permission: [
    ...buildPermission,
    { permission: "todowrite", pattern: "*", action: "deny" as const },
  ] },
  // Session-capable foreign agent for the narrowed #52 path: promptable with
  // its own identity, never remapped to Plan/Build.
  { name: "reviewer", mode: "primary", description: "Code review specialist", options: {}, permission: buildPermission },
  // Hidden internals must never appear in the session-agent catalogue.
  { name: "secretive", mode: "primary", hidden: true, description: "Internal agent", options: {}, permission: buildPermission },
];

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "\0").replaceAll("*", ".*").replaceAll("\0", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function effectiveAction(session: Record<string, any>, permission: string, pattern: string): PermissionAction {
  const names = editAliases.has(permission) ? new Set(["*", ...editAliases]) : new Set(["*", permission]);
  let action: PermissionAction = "ask";
  for (const rule of [...buildPermission, ...((session.permission as PermissionRule[] | undefined) ?? [])]) {
    if (names.has(rule.permission) && globMatches(rule.pattern, pattern)) action = rule.action;
  }
  return action;
}

function policyProbe(session: Record<string, any>): Record<string, unknown> {
  return {
    permission: (session.permission as PermissionRule[] | undefined) ?? [],
    disabledTools: toolIDs.filter((tool) => effectiveAction(session, tool, "*") === "deny"),
    probes: {
      bashDefault: effectiveAction(session, "bash", "npm test"),
      bashDestructive: effectiveAction(session, "bash", "rm -rf /tmp/project"),
      readEnv: effectiveAction(session, "read", "src/.env"),
      editEnv: effectiveAction(session, "edit", "src/.env"),
      externalDirectory: effectiveAction(session, "external_directory", "/tmp/outside"),
      unconfiguredTool: effectiveAction(session, "task", "*"),
    },
  };
}

// These fixed paths are shared across mock processes. The E2E lock prevents
// concurrent runs; fixture repair intentionally does not provide run isolation.
const MOCK_DIRECTORY_INPUT = "/tmp/mock-project";
// A second project with its own sessions, so the cross-project recents panel
// has something to merge. Kept separate from the auto-permissions fixture
// directory so adding sessions here cannot perturb those tests.
const SECOND_DIRECTORY_INPUT = "/tmp/mock-second-project";
const AUTO_DIRECTORY_INPUT = "/tmp/mock-auto-project";
// Auto permissions is per-directory in-memory BFF state, and Playwright runs
// spec files in parallel against one BFF. Any two files that toggle the flag on
// the same directory will flip it under each other, so each such file owns a
// directory of its own. This one belongs to conversation-toolbar.ui.spec.ts.
const TOOLBAR_DIRECTORY_INPUT = "/tmp/mock-toolbar-project";
const RIGHT_TOOLS_DIRECTORY_INPUT = "/tmp/mock-right-tools-project";
// Parked-permission state is per-directory too, and the same parallel-files rule
// applies to it: smoke.ui.spec.ts owns MOCK_DIRECTORY, smoke.api.spec.ts owns this
// one. Only an owner can assert an exact pending list, because any other file
// posting or resetting the same directory would change it mid-assertion.
const API_PERMISSION_DIRECTORY_INPUT = "/tmp/mock-api-permissions";
const TOOL_FAILURE_DIRECTORY_INPUT = "/tmp/mock-tool-failure";
const CATALOGUE_FAILURE_DIRECTORY_INPUT = "/tmp/mock-catalogue-failure";
const POLICY_FAILURE_DIRECTORY_INPUT = "/tmp/mock-policy-failure";
// Workspace file viewer fixture. Unlike the canned `/file` responses used by
// the smoke tests, this project exists on disk with real nested directories,
// a real .gitignore and a real symlink escape — the BFF's containment checks
// are filesystem checks, so a fake listing would prove nothing about them.
// Owned by workspace-files.ui.spec.ts and workspace-references.api.spec.ts,
// which only read from it.
const FILES_DIRECTORY_INPUT = "/tmp/mock-files-project";
const SUBAGENT_DIRECTORY_INPUT = "/tmp/mock-subagent-project";
const MANAGED_SUBAGENT_DIRECTORY_INPUT = "/tmp/mock-managed-subagent-project";
// Composer workflow sends append user messages to their sessions and launch a
// managed child under ses_mock_workflow_main, so the fixtures live in a
// directory only workflows.ui.spec.ts uses.
const WORKFLOW_DIRECTORY_INPUT = "/tmp/mock-workflow-project";
// Owned by session-agents.spec.ts: foreign-identity prompting fixtures.
const SESSION_AGENT_DIRECTORY_INPUT = "/tmp/mock-session-agents-project";
mkdirSync(SUBAGENT_DIRECTORY_INPUT, { recursive: true });
mkdirSync(MANAGED_SUBAGENT_DIRECTORY_INPUT, { recursive: true });
mkdirSync(WORKFLOW_DIRECTORY_INPUT, { recursive: true });
mkdirSync(SESSION_AGENT_DIRECTORY_INPUT, { recursive: true });
mkdirSync(MOCK_DIRECTORY_INPUT, { recursive: true });
mkdirSync(SECOND_DIRECTORY_INPUT, { recursive: true });
mkdirSync(AUTO_DIRECTORY_INPUT, { recursive: true });
mkdirSync(TOOLBAR_DIRECTORY_INPUT, { recursive: true });
mkdirSync(RIGHT_TOOLS_DIRECTORY_INPUT, { recursive: true });
mkdirSync(API_PERMISSION_DIRECTORY_INPUT, { recursive: true });
mkdirSync(TOOL_FAILURE_DIRECTORY_INPUT, { recursive: true });
mkdirSync(CATALOGUE_FAILURE_DIRECTORY_INPUT, { recursive: true });
mkdirSync(POLICY_FAILURE_DIRECTORY_INPUT, { recursive: true });
mkdirSync(path.join(MOCK_DIRECTORY_INPUT, "src"), { recursive: true });
export const MOCK_DIRECTORY = realpathSync(MOCK_DIRECTORY_INPUT);
export const SECOND_DIRECTORY = realpathSync(SECOND_DIRECTORY_INPUT);
const AUTO_DIRECTORY = realpathSync(AUTO_DIRECTORY_INPUT);
export const TOOLBAR_DIRECTORY = realpathSync(TOOLBAR_DIRECTORY_INPUT);
const RIGHT_TOOLS_DIRECTORY = realpathSync(RIGHT_TOOLS_DIRECTORY_INPUT);
const API_PERMISSION_DIRECTORY = realpathSync(API_PERMISSION_DIRECTORY_INPUT);
const TOOL_FAILURE_DIRECTORY = realpathSync(TOOL_FAILURE_DIRECTORY_INPUT);
const CATALOGUE_FAILURE_DIRECTORY = realpathSync(CATALOGUE_FAILURE_DIRECTORY_INPUT);
const POLICY_FAILURE_DIRECTORY = realpathSync(POLICY_FAILURE_DIRECTORY_INPUT);
export const SUBAGENT_DIRECTORY = realpathSync(SUBAGENT_DIRECTORY_INPUT);
export const MANAGED_SUBAGENT_DIRECTORY = realpathSync(MANAGED_SUBAGENT_DIRECTORY_INPUT);
export const WORKFLOW_DIRECTORY = realpathSync(WORKFLOW_DIRECTORY_INPUT);
const SESSION_AGENT_DIRECTORY = realpathSync(SESSION_AGENT_DIRECTORY_INPUT);
ensureGitFixture({
  directory: MOCK_DIRECTORY,
  files: { "README.md": "# Mock project\n" },
  trackedFiles: ["README.md"],
  commitSubject: "fixture",
});

// ── Workspace file viewer fixture ───────────────────────────────────────────
//
// Written eagerly and deterministically so the viewer's line numbers, range
// highlight and breadcrumbs can be asserted by exact value.

/** Line 12 is the one the transcript cites; keep it stable. */
const FIXTURE_INDEX_TS = [
  "// src/index.ts — workspace file viewer fixture.",
  "",
  "export interface FixtureOptions {",
  "  label: string;",
  "  retries: number;",
  "}",
  "",
  "export const DEFAULTS: FixtureOptions = {",
  "  label: \"fixture\",",
  "  retries: 2,",
  "};",
  "export const DEFAULT_PORT = 3210;",
  "",
  "export function describeFixture(options: FixtureOptions): string {",
  "  return `${options.label} (${options.retries} retries)`;",
  "}",
  "",
  "export const answer = 42;",
  "",
].join("\n");

const FIXTURE_GUIDE_MD = [
  "# Fixture guide",
  "",
  "The workspace viewer reads this file through the same BFF route as any other.",
  "",
  "- Nothing here is editable.",
  "",
].join("\n");

mkdirSync(FILES_DIRECTORY_INPUT, { recursive: true });
export const FILES_DIRECTORY = realpathSync(FILES_DIRECTORY_INPUT);
ensureGitFixture({
  directory: FILES_DIRECTORY,
  files: {
    ".gitignore": "generated.txt\n",
    ".env": "FIXTURE_SECRET=must-not-be-readable\n",
    "generated.txt": "generated output that git ignores\n",
    "README.md": "# Files fixture\n",
    "src/index.ts": FIXTURE_INDEX_TS,
    "src/deep/nested.ts": "export const nested = true;\n",
    "docs/guide.md": FIXTURE_GUIDE_MD,
    "assets/logo.bin": Buffer.from([0, 1, 2, 3, 255, 254]),
  },
  // `.env` remains untracked to prove the BFF withholds secret-like files.
  trackedFiles: [
    ".gitignore",
    "README.md",
    "src/index.ts",
    "src/deep/nested.ts",
    "docs/guide.md",
    "assets/logo.bin",
  ],
  commitSubject: "workspace file viewer fixture",
});
// Registered here rather than in the map literal: the transcript embeds the
// realpath'd fixture directory, which is only known once it exists.
messages.set("ses_mock_files", filesMessages(FILES_DIRECTORY));

/** Names this fixture reports as git-ignored, mirroring its .gitignore. */
const FILES_IGNORED = new Set(["generated.txt", ".git"]);

function fixtureListing(relative: string): Array<Record<string, unknown>> {
  const absolute = path.join(FILES_DIRECTORY, relative);
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.name !== ".git")
    .map((entry) => ({
      name: entry.name,
      path: relative ? `${relative}/${entry.name}` : entry.name,
      type: entry.isDirectory() ? "directory" : "file",
      ignored: FILES_IGNORED.has(entry.name),
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function fixtureContent(relative: string): Record<string, unknown> {
  const absolute = path.join(FILES_DIRECTORY, relative);
  const bytes = readFileSync(absolute);
  // Mirrors the real server: a file with NUL bytes comes back as binary.
  if (bytes.includes(0)) {
    return { type: "binary", mimeType: "application/octet-stream", encoding: "base64", content: bytes.toString("base64") };
  }
  return { type: "text", content: bytes.toString("utf8") };
}

const SESSIONS: Array<Record<string, any>> = [
  {
    // The session workflows.ui.spec.ts drives its composer from.
    id: "ses_mock_workflow_main",
    title: "Workflow picker main",
    directory: WORKFLOW_DIRECTORY,
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1787000000000, updated: 1787000012000 },
  },
  {
    // The "Send an update to another session" delivery target.
    id: "ses_mock_workflow_target",
    title: "Workflow update target",
    directory: WORKFLOW_DIRECTORY,
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1787000000000, updated: 1787000011000 },
  },
  {
    id: "ses_mock_done",
    title: "Add a health endpoint",
    directory: MOCK_DIRECTORY,
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    cost: 0.0431,
    tokens: { input: 110, output: 940, reasoning: 250, cache: { read: 10400, write: 800 } },
    time: { created: 1787000000000, updated: 1787000012000 },
  },
  {
    // Mirrors ses_mock_done in a directory only conversation-toolbar.ui.spec.ts
    // uses, so that file can toggle auto permissions without racing the UI and
    // API specs that toggle it on MOCK_DIRECTORY.
    id: "ses_mock_toolbar",
    title: "Add a health endpoint",
    directory: TOOLBAR_DIRECTORY,
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    cost: 0.0431,
    tokens: { input: 110, output: 940, reasoning: 250, cache: { read: 10400, write: 800 } },
    time: { created: 1787000000000, updated: 1787000012000 },
  },
  {
    id: "ses_mock_right_tools",
    title: "Review the browser panel",
    directory: RIGHT_TOOLS_DIRECTORY,
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    time: { created: 1787000000000, updated: 1787000012000 },
  },
  {
    id: "ses_mock_running",
    title: "Refactor the parser",
    directory: MOCK_DIRECTORY,
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    cost: 0.12,
    tokens: { input: 20, output: 300, reasoning: 0, cache: { read: 900, write: 100 } },
    time: { created: 1787000100000, updated: 1787000200000 },
  },
  {
    id: "ses_mock_archived",
    title: "Old archived work",
    directory: MOCK_DIRECTORY,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1786000000000, updated: 1786000000000, archived: 1786500000000 },
  },
  {
    id: "ses_mock_unknown_model",
    title: "Imported unknown model",
    directory: MOCK_DIRECTORY,
    agent: "build",
    model: { providerID: "legacy", id: "removed-model", variant: "old" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1787000300000, updated: 1787000300000 },
  },
  {
    // Newest session anywhere: proves the recents panel merges across projects
    // rather than ordering within one.
    id: "ses_second_newest",
    title: "Second project newest",
    directory: SECOND_DIRECTORY,
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1787000400000, updated: 1787000400000 },
  },
  {
    // Oldest active session anywhere, so it sorts below the first project's.
    id: "ses_second_oldest",
    title: "Second project oldest",
    directory: SECOND_DIRECTORY,
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1787000000000, updated: 1787000000000 },
  },
  {
    id: "ses_mock_mobile",
    title: "Mobile full session fixture",
    directory: MOCK_DIRECTORY,
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    cost: 0.2,
    tokens: { input: 1000, output: 2000, reasoning: 0, cache: { read: 0, write: 0 } },
    // Keep the purpose-built long fixture out of ordinary hub assertions while
    // retaining direct route access for mobile transcript tests.
    time: { created: 1787100000000, updated: 1787100100000, archived: 1787100200000 },
  },
  {
    id: "ses_mock_modes",
    title: "Plan and Build provenance fixture",
    directory: MOCK_DIRECTORY,
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    cost: 0,
    tokens: {},
    // Archived for the same reason as the other purpose-built fixtures: hub
    // assertions count rows, and this session is only ever reached by route.
    time: { created: 1787500000000, updated: 1787500006500, archived: 1787500007000 },
  },
  {
    id: "ses_mock_paginated",
    title: "Paginated export fixture",
    directory: MOCK_DIRECTORY,
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    cost: 0,
    tokens: {},
    time: { created: 1787300000000, updated: 1787300000200, archived: 1787300000300 },
  },
  {
    id: "ses_mock_other_directory",
    title: "Other directory session",
    directory: AUTO_DIRECTORY,
    cost: 0,
    tokens: {},
    time: { created: 1787200000000, updated: 1787200000000 },
  },
  {
    id: "ses_mock_foreign_agent",
    title: "Imported Explore session",
    directory: MOCK_DIRECTORY,
    agent: "explore",
    permission: [],
    cost: 0,
    tokens: {},
    time: { created: 1787300000000, updated: 1787300000000, archived: 1787300001000 },
  },
  {
    id: "ses_mock_unknown_agent",
    title: "Imported session without agent metadata",
    directory: MOCK_DIRECTORY,
    permission: [],
    cost: 0,
    tokens: {},
    time: { created: 1787300100000, updated: 1787300100000, archived: 1787300101000 },
  },
  {
    id: "ses_mock_identity_mismatch",
    title: "Session with stale browser identity",
    directory: MOCK_DIRECTORY,
    agent: "build",
    permission: [],
    cost: 0,
    tokens: {},
    time: { created: 1787300050000, updated: 1787300050000, archived: 1787300051000 },
  },
  {
    id: PARENT_ID,
    title: "Parallel investigation",
    directory: SUBAGENT_DIRECTORY,
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    cost: 0.03,
    tokens: { input: 40, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1787400000000, updated: 1787400006000 },
  },
  {
    id: CHILD_RUNNING,
    title: "Audit the parser",
    directory: SUBAGENT_DIRECTORY,
    parentID: PARENT_ID,
    agent: "explore",
    cost: 0.004,
    tokens: {},
    time: { created: 1787400001500, updated: 1787400001600 },
  },
  {
    id: CHILD_DONE,
    title: "Check the tests",
    directory: SUBAGENT_DIRECTORY,
    parentID: PARENT_ID,
    agent: "explore",
    cost: 0.002,
    tokens: {},
    time: { created: 1787400002500, updated: 1787400002900 },
  },
  {
    id: GRANDCHILD,
    title: "Reproduce the flake",
    directory: SUBAGENT_DIRECTORY,
    parentID: CHILD_DONE,
    agent: "explore",
    cost: 0,
    tokens: {},
    time: { created: 1787400002700, updated: 1787400002800 },
  },
  {
    id: CHILD_REPORTED,
    title: "Summarize the docs",
    directory: SUBAGENT_DIRECTORY,
    parentID: PARENT_ID,
    agent: "general",
    cost: 0.001,
    tokens: {},
    time: { created: 1787400003100, updated: 1787400003200 },
  },
  {
    id: CHILD_UNKNOWN,
    title: "Crawl the changelog",
    directory: SUBAGENT_DIRECTORY,
    parentID: PARENT_ID,
    agent: "general",
    cost: 0,
    tokens: {},
    time: { created: 1787400003500, updated: 1787400003500 },
  },
  {
    id: CHILD_FAILED,
    title: "Inspect the deployment",
    directory: SUBAGENT_DIRECTORY,
    parentID: PARENT_ID,
    agent: "explore",
    cost: 0.003,
    tokens: {},
    time: { created: 1787400004100, updated: 1787400004200 },
  },
  {
    id: CHILD_LAUNCHED,
    title: "Review dependency updates",
    directory: SUBAGENT_DIRECTORY,
    parentID: PARENT_ID,
    agent: "general",
    cost: 0,
    tokens: {},
    time: { created: 1787400004300, updated: 1787400004300 },
  },
  {
    id: "ses_mock_orphan",
    title: "Detached delegated session",
    directory: SUBAGENT_DIRECTORY,
    parentID: "ses_missing_parent",
    agent: "explore",
    cost: 0,
    tokens: {},
    time: { created: 1787390000000, updated: 1787390000000 },
  },
  {
    id: MANAGED_API_PARENT,
    title: "Managed API parent",
    directory: MANAGED_SUBAGENT_DIRECTORY,
    agent: "plan",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    permission: [],
    cost: 0,
    tokens: {},
    time: { created: 1787410000000, updated: 1787410000000 },
  },
  {
    id: "ses_mock_agent_reviewer",
    title: "Review session driven by a foreign agent",
    directory: SESSION_AGENT_DIRECTORY,
    agent: "reviewer",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    permission: [],
    cost: 0,
    tokens: {},
    time: { created: 1787420000000, updated: 1787420000000 },
  },
  {
    id: "ses_mock_agent_departed",
    title: "Session whose agent left the roster",
    directory: SESSION_AGENT_DIRECTORY,
    agent: "departed",
    permission: [],
    cost: 0,
    tokens: {},
    time: { created: 1787420001000, updated: 1787420001000 },
  },
  {
    id: MANAGED_UI_PARENT,
    title: "Managed UI parent",
    directory: MANAGED_SUBAGENT_DIRECTORY,
    agent: "plan",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    permission: [],
    cost: 0,
    tokens: {},
    time: { created: 1787411000000, updated: 1787411000000 },
  },
  {
    id: MANAGED_SEEDED_CHILD,
    title: "Summarize the release checklist",
    directory: MANAGED_SUBAGENT_DIRECTORY,
    parentID: MANAGED_UI_PARENT,
    agent: "plan",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    permission: MANAGED_SEEDED_POLICY,
    // The fingerprint must match the ruleset above or the BFF reports
    // `effectivePolicyObserved: false`, which is a different (honest) row.
    metadata: {
      customDcaManagedChild: {
        version: 2,
        origin: "managed-human",
        requestedAgent: "plan",
        authorization: "read-only",
        requestedModel: { providerID: "anthropic", modelID: "claude-opus-5" },
        background: true,
        policyFingerprint: createHash("sha256").update(JSON.stringify(MANAGED_SEEDED_POLICY)).digest("hex"),
      },
    },
    cost: 0.003,
    tokens: {},
    time: { created: 1787411500000, updated: 1787411600000 },
  },
  {
    id: MANAGED_FAILURE_PARENT,
    title: "Managed failure parent",
    directory: MANAGED_SUBAGENT_DIRECTORY,
    agent: "plan",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    permission: [],
    cost: 0,
    tokens: {},
    time: { created: 1787412000000, updated: 1787412000000 },
  },
  {
    id: MANAGED_CLEANUP_FAILURE_PARENT,
    title: "Managed cleanup failure parent",
    directory: MANAGED_SUBAGENT_DIRECTORY,
    agent: "plan",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    permission: [],
    cost: 0,
    tokens: {},
    time: { created: 1787413000000, updated: 1787413000000 },
  },
  {
    // Lives in a directory only smoke.api.spec.ts drives, so that file can park,
    // answer and count permission requests without smoke.ui.spec.ts resetting
    // MOCK_DIRECTORY under it.
    id: "ses_mock_api_permission",
    title: "API permission fixture",
    directory: API_PERMISSION_DIRECTORY,
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    cost: 0,
    tokens: {},
    time: { created: 1787200500000, updated: 1787200500000 },
  },
  {
    // The workspace file viewer fixture, in its own project so browsing it
    // cannot perturb the hub counts or the permission fixtures.
    id: "ses_mock_files",
    title: "Workspace file viewer fixture",
    directory: FILES_DIRECTORY,
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    cost: 0,
    tokens: {},
    time: { created: 1787600000000, updated: 1787600002000 },
  },
  {
    id: "ses_mock_share_failure",
    title: "Share service failure",
    directory: MOCK_DIRECTORY,
    cost: 0,
    tokens: {},
    time: { created: 1787200100000, updated: 1787200100000, archived: 1787200200000 },
  },
  {
    id: "ses_mock_share_api",
    title: "API share fixture",
    directory: MOCK_DIRECTORY,
    cost: 0,
    tokens: {},
    time: { created: 1787200250000, updated: 1787200250000 },
  },
  {
    id: "ses_mock_bad_share_url",
    title: "Unsafe share response",
    directory: MOCK_DIRECTORY,
    cost: 0,
    tokens: {},
    time: { created: 1787200300000, updated: 1787200300000, archived: 1787200400000 },
  },
];

const TODOS = [
  { content: "Read the existing server", status: "completed", priority: "high" },
  { content: "Add the route", status: "in_progress", priority: "high" },
  { content: "Write a test", status: "pending", priority: "medium" },
];

// Mirrors the checked-in and machine-global setting used by the real app.
// The Settings page exposes this value read-only.
let globalConfig: Record<string, unknown> = { subagent_depth: 3 };
let mcpServers: Record<string, unknown> = {
  github: { status: "connected" },
  docs: { status: "failed", error: "mock connection refused" },
  auth: { status: "needs_auth" },
  local: { status: "disabled" },
  registration: { status: "needs_client_registration", error: "register this client first" },
};
const skills = [
  { name: "browser-check", description: "Check a page in the browser.", location: "/Users/mock/.config/opencode/skills/browser-check/SKILL.md", content: "SECRET SKILL CONTENT" },
];
const customCommands = [
  { name: "verify", description: "Run project verification.", source: "command", agent: "build", model: "mock/model", subtask: false, template: "SECRET COMMAND TEMPLATE" },
];
let catalogRequests = 0;
const worktrees = [`${MOCK_DIRECTORY}.worktrees/fixture`];
interface MockPermission {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { messageID: string; callID: string };
}

const permissionFixture = (id: string, sessionID: string): MockPermission => ({
  id,
  sessionID,
  permission: "bash",
  patterns: ["npm test"],
  metadata: { command: "npm test" },
  always: ["npm *"],
  tool: { messageID: `msg_${id}`, callID: `call_${id}` },
});
// One seeded parked request per owning spec file. `/test/permissions/reset`
// restores exactly the seed for the directory it was asked about, so an owner
// gets a known list back without touching anybody else's directory.
const PERMISSION_SEEDS: Array<[string, () => MockPermission[]]> = [
  [MOCK_DIRECTORY, () => [permissionFixture("perm_mock", "ses_mock_done")]],
  [API_PERMISSION_DIRECTORY, () => [permissionFixture("perm_api", "ses_mock_api_permission")]],
  [AUTO_DIRECTORY, () => []],
];
const permissionSeed = (scope: string): MockPermission[] =>
  PERMISSION_SEEDS.find(([directory]) => directory === scope)?.[1]() ?? [];
const pendingPermissions = new Map<string, MockPermission[]>(
  PERMISSION_SEEDS.map(([directory, seed]) => [directory, seed()]),
);
const permissionReplies: Array<{ id: string; reply: unknown }> = [];
const questionFixture = () => [
  {
    id: "que_mock",
    sessionID: "ses_mock_done",
    questions: [
      {
        header: "Deployment",
        question: "Where should this ship?",
        options: [{ label: "Staging", description: "Use the staging environment" }, { label: "Production", description: "Use production" }],
        custom: false,
      },
      {
        header: "Checks",
        question: "Which checks should run?",
        options: [{ label: "Unit", description: "Run unit tests" }, { label: "E2E", description: "Run browser tests" }],
        multiple: true,
        custom: true,
      },
    ],
  },
  {
    id: "que_api",
    sessionID: "ses_mock_running",
    questions: [
      {
        header: "Deployment",
        question: "Where should this ship?",
        options: [{ label: "Staging", description: "Use the staging environment" }, { label: "Production", description: "Use production" }],
        custom: false,
      },
      {
        header: "Checks",
        question: "Which checks should run?",
        options: [{ label: "Unit", description: "Run unit tests" }, { label: "E2E", description: "Run browser tests" }],
        multiple: true,
        custom: true,
      },
    ],
  },
];
let pendingQuestions = questionFixture();
const questionReplies: Array<{ id: string; answers?: unknown; rejected?: boolean }> = [];
mkdirSync(worktrees[0], { recursive: true });
const eventClients = new Set<ServerResponse>();
const holdNextPolicyPatch = new Set<string>();
let heldPolicyPatch: { sessionID: string; release: () => void } | null = null;

function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try { resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {}); }
      catch (error) { reject(error); }
    });
  });
}

function emit(type: string, properties: Record<string, unknown>, directory = MOCK_DIRECTORY): void {
  const frame = `data: ${JSON.stringify({ directory, payload: { type, properties } })}\n\n`;
  for (const client of eventClients) client.write(frame);
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(payload);
}

/** Mirror the real server: unknown session -> 500 UnknownError, not 404. */
function unknownError(res: ServerResponse): void {
  json(res, 500, {
    name: "UnknownError",
    data: { message: "Unexpected server error. Check server logs for details.", ref: "err_mock" },
  });
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://mock");
  const { pathname } = url;
  const directory = url.searchParams.get("directory");

  if (pathname === "/global/health") {
    return json(res, 200, { healthy: true, version: "1.18.23+dca.2" });
  }

  if (pathname === "/global/event") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ payload: { type: "server.connected", properties: {} } })}\n\n`);
    eventClients.add(res);
    // The real server heartbeats every 10s with a type absent from the typed
    // union — clients must tolerate it.
    const beat = setInterval(() => {
      res.write(
        `data: ${JSON.stringify({ directory: MOCK_DIRECTORY, payload: { type: "server.heartbeat", properties: {} } })}\n\n`,
      );
    }, 1_000);
    req.on("close", () => { clearInterval(beat); eventClients.delete(res); });
    return;
  }

  if (pathname === "/global/config") {
    if (req.method === "GET") return json(res, 200, globalConfig);
    if (req.method === "PATCH") {
      void body(req).then((patch) => {
        globalConfig = {
          ...globalConfig,
          ...patch,
          ...(patch.compaction && typeof patch.compaction === "object"
            ? { compaction: { ...((globalConfig.compaction as object) ?? {}), ...(patch.compaction as object) } }
            : {}),
        };
        json(res, 200, globalConfig);
      });
      return;
    }
  }

  if (pathname === "/config") {
    return json(res, 200, { model: "anthropic/claude-opus-5", permission: { "*": "ask", read: "allow" } });
  }
  if (pathname === "/config/providers") {
    if (directory === CATALOGUE_FAILURE_DIRECTORY) return json(res, 503, { error: "mock catalogue unavailable" });
    return json(res, 200, {
      providers: [
        {
          id: "anthropic",
          name: "Anthropic",
          headers: { Authorization: "Bearer must-not-reach-browser" },
          options: { apiKey: "must-not-reach-browser", baseURL: "https://private.example" },
          models: {
            "claude-opus-5": { name: "Claude Opus 5", attachment: true, reasoning: true, limit: { context: 200000, output: 32000 }, variants: { high: { token: "secret" } } },
            "claude-text": { name: "Claude Text", status: "active", limit: { context: 100000, output: 16000 } },
            "claude-retired": { name: "Claude Retired", enabled: false, limit: { context: 1000 } },
          },
        },
        { id: "openai", name: "OpenAI", models: {
          "gpt-5": { name: "GPT-5", modalities: { input: ["text", "image"] }, limit: { context: 128000, output: 16000 } },
          "gpt-5.6-sol": { name: "GPT-5.6 Sol", modalities: { input: ["text", "image"] }, limit: { context: 256000, output: 32000 } },
        } },
      ],
      default: { anthropic: "claude-opus-5" },
    });
  }
  if (pathname === "/experimental/tool/ids") {
    return directory === TOOL_FAILURE_DIRECTORY
      ? json(res, 503, { error: "mock discovery unavailable" })
      : json(res, 200, toolIDs);
  }
  if (pathname === "/agent") return json(res, 200, agents);
  if (pathname === "/experimental/capabilities") return json(res, 200, { backgroundSubagents: true });
  const promoteMatch = /^\/experimental\/session\/([^/]+)\/background$/.exec(pathname);
  if (promoteMatch && req.method === "POST") {
    const id = decodeURIComponent(promoteMatch[1]);
    // Mirrors the real contract: a bare boolean, false when nothing running
    // and synchronous was eligible for promotion.
    return json(res, 200, SESSIONS.some((s) => s.parentID === id && s.id === CHILD_RUNNING));
  }
  if (pathname === "/test/prompt-payloads") return json(res, 200, promptPayloads);
  if (pathname === "/test/session-list-requests") return json(res, 200, { count: sessionListRequests });
  if (pathname === "/test/session-list-requests") return json(res, 200, { count: sessionListRequests });
  if (pathname === "/test/permission-replies") return json(res, 200, permissionReplies);
  if (pathname === "/test/permission" && req.method === "POST") {
    void body(req).then((input) => {
      const permission = {
        id: String(input.id),
        sessionID: String(input.sessionID),
        permission: String(input.permission),
        patterns: Array.isArray(input.patterns) ? input.patterns.map(String) : [],
        metadata: input.metadata && typeof input.metadata === "object" ? input.metadata as Record<string, unknown> : {},
        always: Array.isArray(input.always) ? input.always.map(String) : [],
        ...(input.tool && typeof input.tool === "object" ? { tool: input.tool as { messageID: string; callID: string } } : {}),
      };
      const scope = directory ?? MOCK_DIRECTORY;
      pendingPermissions.set(scope, [...(pendingPermissions.get(scope) ?? []), permission]);
      emit("permission.asked", permission, scope);
      json(res, 201, permission);
    });
    return;
  }
  if (pathname === "/test/session-payloads") return json(res, 200, sessionPayloads);
  if (pathname === "/test/root-workflow-failure" && req.method === "POST") {
    void body(req).then((input) => {
      const stage = input.stage;
      const failureDirectory = typeof input.directory === "string" ? input.directory : "";
      if (!failureDirectory || (stage !== "worktree" && stage !== "session" && stage !== "prompt")) {
        return json(res, 400, { error: "directory and stage are required" });
      }
      rootWorkflowFailures.set(failureDirectory, stage);
      json(res, 200, { stage, directory: failureDirectory });
    });
    return;
  }
  if (pathname === "/test/sharing/reset" && req.method === "POST") {
    // Scoped by session on purpose. `share` lives on the fixture objects this one
    // mock process serves to every Playwright worker, and Playwright runs spec
    // files in parallel, so the previous `for (const session of SESSIONS) delete
    // session.share` revoked the URL whichever *other* file was mid-assertion on.
    // A caller must name the sessions it owns; naming none is a programming error
    // rather than a silent global wipe, and an unknown id fails loudly so renaming
    // a fixture cannot quietly turn a reset into a no-op.
    const ids = url.searchParams.getAll("session").flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
    if (ids.length === 0) {
      return json(res, 400, { error: "mock-opencode: /test/sharing/reset needs at least one ?session= id; it must not reset sessions another spec file owns" });
    }
    const unknown = ids.filter((id) => !SESSIONS.some((session) => session.id === id));
    if (unknown.length > 0) {
      return json(res, 404, { error: `mock-opencode: /test/sharing/reset got unknown session id(s) ${unknown.join(", ")}` });
    }
    for (const session of SESSIONS) {
      if (ids.includes(session.id)) delete session.share;
    }
    return json(res, 200, true);
  }
  if (pathname === "/test/mobile/reset" && req.method === "POST") {
    messages.set("ses_mock_mobile", mobileMessages());
    mobileRunning = true;
    return json(res, 200, true);
  }
  if (pathname === "/test/mobile/idle" && req.method === "POST") {
    mobileRunning = false;
    // The session id is a parameter because the BFF deduplicates identical
    // events within 5 seconds, keyed by directory + type + session. Spec files
    // run in parallel against this one mock, so two files idling the SAME
    // session race: one of them silently loses its notification. Callers that
    // only need "an idle happened" pass their own id and stop colliding.
    const sessionID = url.searchParams.get("sessionID") || "ses_mock_mobile";
    // Directory matters for lineage: the BFF resolves parent/child through
    // /session/{id}?directory=, so an idle for a sub-agent fixture must carry
    // the directory that fixture actually lives in.
    emit("session.idle", { sessionID }, url.searchParams.get("directory") || undefined);
    return json(res, 200, true);
  }
  if (pathname === "/test/mobile/grow" && req.method === "POST") {
    const sessionMessages = messages.get("ses_mock_mobile") as Array<{ info?: { id?: string }; parts?: Array<{ type?: string; text?: string }> }>;
    const live = sessionMessages.find((message) => message.info?.id === "msg_mobile_live");
    const text = live?.parts?.find((part) => part.type === "text");
    if (text) text.text = `${hostileMarkdown}\n\nNew live activity from the running agent.`;
    emit("message.part.updated", { sessionID: "ses_mock_mobile", part: { id: "prt_mobile_live", messageID: "msg_mobile_live" } });
    return json(res, 200, true);
  }
  if (pathname === "/test/paginated/older-update" && req.method === "POST") {
    emit("message.part.updated", { sessionID: "ses_mock_paginated", part: { id: "prt_page_50", messageID: "msg_page_50" } });
    return json(res, 200, true);
  }
  if (pathname === "/test/paginated/pending-update" && req.method === "POST") {
    emit("message.part.updated", { sessionID: "ses_mock_paginated", part: { id: "prt_page_1", messageID: "msg_page_1" } });
    return json(res, 200, true);
  }
  if (pathname === "/test/paginated/newest-update" && req.method === "POST") {
    emit("message.part.updated", { sessionID: "ses_mock_paginated", part: { id: "prt_page_225", messageID: "msg_page_225" } });
    return json(res, 200, true);
  }
  if (pathname === "/test/session-policy/tamper" && req.method === "POST") {
    const session = SESSIONS.find((candidate) => candidate.id === url.searchParams.get("id"));
    if (!session) return unknownError(res);
    session.permission = [
      ...((session.permission as PermissionRule[] | undefined) ?? []),
      { permission: "edit", pattern: "*", action: "allow" },
    ];
    return json(res, 200, true);
  }
  if (pathname === "/test/managed-metadata/tamper" && req.method === "POST") {
    const session = SESSIONS.find((candidate) => candidate.id === url.searchParams.get("id"));
    const marker = session?.metadata?.customDcaManagedChild;
    if (!session || !marker || typeof marker !== "object") return unknownError(res);
    session.metadata.customDcaManagedChild = { ...marker, requestedAgent: "unknown-agent" };
    return json(res, 200, true);
  }
  if (pathname === "/test/session-policy") {
    const session = SESSIONS.find((candidate) => candidate.id === url.searchParams.get("id"));
    return session ? json(res, 200, policyProbe(session)) : unknownError(res);
  }
  if (pathname === "/test/hold-next-policy-patch" && req.method === "POST") {
    void body(req).then((input) => {
      holdNextPolicyPatch.add(String(input.sessionID));
      json(res, 200, true);
    });
    return;
  }
  if (pathname === "/test/policy-patch-pending") {
    return json(res, 200, { pending: heldPolicyPatch?.sessionID === url.searchParams.get("id") });
  }
  if (pathname === "/test/release-policy-patch" && req.method === "POST") {
    if (heldPolicyPatch?.sessionID === url.searchParams.get("id")) heldPolicyPatch.release();
    return json(res, 200, true);
  }
  if (pathname === "/test/question-replies") {
    const id = url.searchParams.get("id");
    return json(res, 200, id ? questionReplies.filter((reply) => reply.id === id) : questionReplies);
  }
  if (pathname === "/test/questions/reset" && req.method === "POST") {
    const scope = url.searchParams.get("scope");
    const fixtures = questionFixture();
    const resetIDs = scope === "api" ? new Set(["que_api"]) : scope === "ui" ? new Set(["que_mock"]) : new Set(["que_api", "que_mock"]);
    pendingQuestions = [...pendingQuestions.filter((item) => !resetIDs.has(item.id)), ...fixtures.filter((item) => resetIDs.has(item.id))];
    for (let index = questionReplies.length - 1; index >= 0; index -= 1) {
      if (resetIDs.has(questionReplies[index].id)) questionReplies.splice(index, 1);
    }
    return json(res, 200, true);
  }
  if (pathname === "/test/permissions/reset" && req.method === "POST") {
    const scope = directory ?? MOCK_DIRECTORY;
    pendingPermissions.set(scope, permissionSeed(scope));
    return json(res, 200, true);
  }

  if (pathname === "/test/catalog-requests" && req.method === "POST") {
    catalogRequests = 0;
    return json(res, 200, true);
  }
  if (pathname === "/test/catalog-requests") return json(res, 200, { count: catalogRequests });
  if (pathname === "/mcp" && req.method === "GET") return json(res, 200, mcpServers);
  if (pathname === "/skill" && req.method === "GET") {
    catalogRequests += 1;
    return json(res, 200, skills);
  }
  if (pathname === "/command" && req.method === "GET") {
    catalogRequests += 1;
    return json(res, 200, customCommands);
  }
  const mcpMatch = /^\/mcp\/([^/]+)\/(connect|disconnect)$/.exec(pathname);
  if (mcpMatch && req.method === "POST") {
    const name = decodeURIComponent(mcpMatch[1]);
    if (!(name in mcpServers)) return json(res, 404, { error: "unknown MCP" });
    mcpServers = { ...mcpServers, [name]: { status: mcpMatch[2] === "connect" ? "connected" : "disabled" } };
    return json(res, 200, true);
  }

  if (pathname === "/lsp") return json(res, 200, { typescript: { status: "connected" } });
  if (pathname === "/permission") return json(res, 200, pendingPermissions.get(directory ?? MOCK_DIRECTORY) ?? []);
  const permissionReply = /^\/permission\/([^/]+)\/reply$/.exec(pathname);
  if (permissionReply && req.method === "POST") {
    const id = decodeURIComponent(permissionReply[1]);
    const scope = directory ?? MOCK_DIRECTORY;
    const scopedPermissions = pendingPermissions.get(scope) ?? [];
    const permission = scopedPermissions.find((request) => request.id === id);
    if (id.startsWith("perm_fail")) return json(res, 500, { error: "mock permission reply failed" });
    if (!permission) return json(res, 404, { error: "permission request not found" });
    void body(req).then((input) => {
      permissionReplies.push({ id, reply: input.reply });
      pendingPermissions.set(scope, scopedPermissions.filter((request) => request.id !== id));
      if (permission && id.startsWith("perm_continue_") && input.reply !== "reject") {
        const now = Date.now();
        const sessionMessages = messages.get(permission.sessionID) ?? [];
        sessionMessages.push({
          info: { id: `msg_permission_${now}`, role: "assistant", agent: "build", time: { created: now, completed: now } },
          parts: [{ id: `prt_permission_${now}`, messageID: `msg_permission_${now}`, type: "text", text: "Permission approved; continuing the conversation." }],
        });
        messages.set(permission.sessionID, sessionMessages);
      }
      emit("permission.replied", { sessionID: permission?.sessionID, requestID: id, reply: input.reply }, directory ?? MOCK_DIRECTORY);
      json(res, 200, true);
    });
    return;
  }
  if (pathname === "/question" && req.method === "GET") return json(res, 200, pendingQuestions);
  const questionAction = /^\/question\/([^/]+)\/(reply|reject)$/.exec(pathname);
  if (questionAction && req.method === "POST") {
    const id = decodeURIComponent(questionAction[1]);
    if (!pendingQuestions.some((request) => request.id === id)) return json(res, 200, false);
    if (questionAction[2] === "reply") {
      void body(req).then((input) => {
        questionReplies.push({ id, answers: input.answers });
        pendingQuestions = pendingQuestions.filter((request) => request.id !== id);
        json(res, 200, true);
      });
      return;
    }
    questionReplies.push({ id, rejected: true });
    pendingQuestions = pendingQuestions.filter((request) => request.id !== id);
    return json(res, 200, true);
  }
  if (pathname === "/file") {
    const relative = url.searchParams.get("path") ?? "";
    // The file-viewer fixture is a real directory tree; everything else keeps
    // the canned two-level listing the older smoke tests are written against.
    if (directory === FILES_DIRECTORY) {
      try {
        return json(res, 200, fixtureListing(relative));
      } catch {
        return json(res, 404, { error: "no such directory" });
      }
    }
    return json(res, 200, relative === "src"
      ? [{ name: "index.ts", path: "src/index.ts", type: "file", ignored: false }]
      : [
          { name: "src", path: "src", type: "directory", ignored: false },
          { name: "README.md", path: "README.md", type: "file", ignored: false },
          { name: "node_modules", path: "node_modules", type: "directory", ignored: true },
        ]);
  }
  if (pathname === "/file/content") {
    const relative = url.searchParams.get("path") ?? "";
    if (directory === FILES_DIRECTORY) {
      try {
        return json(res, 200, fixtureContent(relative));
      } catch {
        return json(res, 404, { error: "no such file" });
      }
    }
    return json(res, 200, { type: "text", content: relative === "README.md" ? "# Mock project" : "export const answer = 42;" });
  }
  if (pathname === "/vcs/diff") {
    return json(res, 200, [{ file: "src/index.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" }]);
  }

  if (pathname === "/experimental/worktree") {
    if (req.method === "GET") return json(res, 200, worktrees);
    if (req.method === "POST") {
      if (directory && rootWorkflowFailures.get(directory) === "worktree") {
        rootWorkflowFailures.delete(directory);
        return json(res, 503, { error: "mock root worktree failure" });
      }
      void body(req).then((input) => {
        const name = typeof input.name === "string" ? input.name : `mock-${Date.now()}`;
        const directory = `${url.searchParams.get("directory") ?? MOCK_DIRECTORY}.worktrees/${name}`;
        mkdirSync(directory, { recursive: true });
        worktrees.push(directory);
        const value = { name, branch: name, directory };
        json(res, 200, value);
        setTimeout(() => emit("worktree.ready", { name, branch: name }, directory), 10);
      });
      return;
    }
    if (req.method === "DELETE") return json(res, 200, true);
  }
  if (pathname === "/experimental/worktree/reset" && req.method === "POST") return json(res, 200, true);

  if (pathname === "/session/status") {
    return json(res, 200, {
      ses_mock_running: { type: "busy" },
      [CHILD_RUNNING]: { type: "busy" },
      ...(mobileRunning ? { ses_mock_mobile: { type: "busy" } } : {}),
    });
  }

  if (pathname === "/session" && req.method === "GET") {
    sessionListRequests += 1;
    if (!directory) return json(res, 400, { error: "directory required" });
    const search = url.searchParams.get("search")?.toLowerCase();
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const matching = SESSIONS.filter((s) => s.directory === directory)
      .filter((s) => !search || `${s.title} ${s.id}`.toLowerCase().includes(search));
    return json(res, 200, matching.slice(0, Number.isFinite(limit) ? limit : 100));
  }

  if (pathname === "/session" && req.method === "POST") {
    if (directory && rootWorkflowFailures.get(directory) === "session") {
      rootWorkflowFailures.delete(directory);
      return json(res, 503, { error: "mock root session creation failure" });
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as {
        title?: string;
        agent?: string;
        parentID?: string;
        metadata?: Record<string, unknown>;
        permission?: PermissionRule[];
        model?: { providerID?: string; id?: string; modelID?: string; variant?: string };
      }) : {};
      sessionPayloads.push(body);
      if (body.model && (!body.model.providerID || !body.model.id || body.model.modelID)) {
        return json(res, 400, { error: "session model must use providerID and id" });
      }
      const created = {
        id: `ses_mock_new_${++createdSessionSequence}`,
        title: body.title ?? "Untitled session",
        directory: directory ?? MOCK_DIRECTORY,
        agent: body.agent,
        parentID: body.parentID,
        model: body.model,
        metadata: body.metadata,
        permission: body.permission ?? [],
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now(), updated: Date.now() },
      };
      SESSIONS.push(created);
      json(res, 200, created);
    });
    return;
  }

  const sessionMatch = /^\/session\/([^/]+)(\/.*)?$/.exec(pathname);
  if (sessionMatch) {
    const id = decodeURIComponent(sessionMatch[1]);
    const rest = sessionMatch[2] ?? "";
    const session = SESSIONS.find((s) => s.id === id);

    if (rest === "/prompt_async" && req.method === "POST") {
      if (!session) return unknownError(res);
      void body(req).then((input) => {
        const promptModel = input.model as { providerID?: string; modelID?: string; id?: string } | undefined;
        if (promptModel && (!promptModel.providerID || !promptModel.modelID || promptModel.id)) {
          return json(res, 400, { error: "prompt model must use providerID and modelID" });
        }
        if (input.tools && typeof input.tools === "object" && Object.keys(input.tools).length > 0) {
          session.permission = [
            ...((session.permission as PermissionRule[] | undefined) ?? []),
            ...Object.entries(input.tools).map(([permission, enabled]) => ({
              permission,
              pattern: "*",
              action: enabled === true ? "allow" : "deny",
            })),
          ];
        }
        promptPayloads.push({ ...input, sessionID: id, effectivePolicy: policyProbe(session) });
        if (promptModel) session.model = {
          providerID: promptModel.providerID,
          id: promptModel.modelID,
          ...(typeof input.variant === "string" ? { variant: input.variant } : {}),
        };
        const parts = Array.isArray(input.parts) ? input.parts as Array<Record<string, unknown>> : [];
        const text = parts.find((part) => part.type === "text")?.text;
        if (text === "FAIL_MANAGED_PROMPT") {
          return json(res, 503, { error: "mock managed prompt failure" });
        }
        if (session.directory && rootWorkflowFailures.get(session.directory) === "prompt") {
          rootWorkflowFailures.delete(session.directory);
          return json(res, 503, { error: "mock root opening prompt failure" });
        }
        if (typeof text === "string") {
          const now = Date.now();
          const sessionMessages = messages.get(id) ?? [];
          sessionMessages.push({
            info: {
              id: `msg_user_${now}`,
              role: "user",
              agent: input.agent,
              model: promptModel ? {
                ...promptModel,
                ...(typeof input.variant === "string" ? { variant: input.variant } : {}),
              } : (session.model && {
                providerID: session.model.providerID,
                modelID: session.model.modelID ?? session.model.id,
                ...(session.model.variant ? { variant: session.model.variant } : {}),
              }),
              time: { created: now },
            },
            parts: [{ id: `prt_user_${now}`, messageID: `msg_user_${now}`, type: "text", text }],
          });
          if (session.metadata?.customDcaManagedChild) {
            sessionMessages.push({
              info: {
                id: `msg_assistant_${now}`,
                role: "assistant",
                agent: input.agent,
                modelID: promptModel?.modelID ?? session.model?.id,
                providerID: promptModel?.providerID ?? session.model?.providerID,
                time: { created: now + 1, completed: now + 2 },
              },
              parts: [{
                id: `prt_assistant_${now}`,
                messageID: `msg_assistant_${now}`,
                type: "text",
                text: "Managed child completed its mock assignment.",
              }],
            });
          }
          messages.set(id, sessionMessages);
        }
        res.writeHead(204).end(); // 204, no body — the real contract.
      });
      return;
    }
    if (rest === "/abort" && req.method === "POST") {
      if (!session) return unknownError(res);
      return json(res, 200, true);
    }
    if (rest === "/share") {
      if (!session) return unknownError(res);
      if (req.method === "POST") {
        if (id === "ses_mock_share_failure") return json(res, 503, { error: "mock share service unavailable" });
        if (id === "ses_mock_bad_share_url") {
          session.share = { url: "javascript:alert(1)" };
          return json(res, 200, { ...session, secret: "must-not-reach-browser" });
        }
        session.share = { url: `https://share.e2e.example.test/s/${encodeURIComponent(id)}` };
        return json(res, 200, { ...session, secret: "must-not-reach-browser" });
      }
      if (req.method === "DELETE") {
        delete session.share;
        return json(res, 200, session);
      }
    }
    if (!session) return unknownError(res);

    if (rest === "") {
      if (req.method === "DELETE") {
        if (session.parentID === MANAGED_CLEANUP_FAILURE_PARENT) {
          return json(res, 503, { error: "mock managed cleanup failure" });
        }
        const index = SESSIONS.indexOf(session);
        if (index >= 0) SESSIONS.splice(index, 1);
        messages.delete(id);
        return json(res, 200, true);
      }
      if (req.method === "PATCH") {
        if (directory === POLICY_FAILURE_DIRECTORY) return json(res, 503, { error: "mock policy activation failed" });
        void body(req).then(async (patch) => {
          if (Array.isArray(patch.permission)) {
            session.permission = [
              ...((session.permission as PermissionRule[] | undefined) ?? []),
              ...(patch.permission as PermissionRule[]),
            ];
          }
          if (holdNextPolicyPatch.delete(id)) {
            await new Promise<void>((resolve) => {
              heldPolicyPatch = { sessionID: id, release: resolve };
            });
            heldPolicyPatch = null;
          }
          json(res, 200, session);
        });
        return;
      }
      return json(res, 200, session);
    }
    if (rest === "/message") {
      const all = messages.get(id) ?? [];
      const requestedLimit = Number(url.searchParams.get("limit") ?? 0);
      const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : all.length;
      const requestedBefore = Number(url.searchParams.get("before") ?? all.length);
      const end = Number.isInteger(requestedBefore) && requestedBefore >= 0
        ? Math.min(requestedBefore, all.length)
        : all.length;
      const start = Math.max(0, end - limit);
      const nextCursor = start > 0 ? String(start) : null;
      return json(res, 200, all.slice(start, end), nextCursor ? { "X-Next-Cursor": nextCursor } : {});
    }
    if (rest === "/diff") {
      const messageID = url.searchParams.get("messageID");
      if (!messageID) return json(res, 400, { error: "messageID required" });
      const message = (messages.get(id) ?? []).find((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
        const info = (candidate as { info?: unknown }).info;
        return !!info && typeof info === "object" && !Array.isArray(info) &&
          (info as { id?: unknown }).id === messageID;
      }) as { info?: { role?: unknown } } | undefined;
      if (message?.info?.role !== "user") return json(res, 200, []);
      return json(res, 200, [
        { file: "src/index.ts", patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1, status: "modified" },
        { file: ".env", patch: "@@ -1 +1 @@\n-TOKEN=old\n+TOKEN=new", additions: 1, deletions: 1, status: "modified" },
        { patch: "missing file", additions: 1, deletions: 0, status: "added" },
      ]);
    }
    if (rest === "/children") {
      return json(res, 200, SESSIONS.filter((candidate) => candidate.parentID === id));
    }
    if (rest === "/todo") {
      return json(res, 200, id === "ses_mock_done" ? TODOS : []);
    }
  }

  json(res, 404, { error: `mock-opencode: unhandled ${req.method} ${pathname}` });
}

const port = Number(process.argv[2] || process.env.MOCK_OPENCODE_PORT || 4599);
createServer(handle).listen(port, "127.0.0.1", () => {
  console.log(`[mock-opencode] listening on http://127.0.0.1:${port}`);
});
