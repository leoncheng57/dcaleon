import { defineConfig } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { e2eStateFiles, prepareE2EStateFiles } from "./tests/e2e/state-files.js";

// e2e runs entirely against a MOCK OpenCode server (tests/e2e/mock-opencode.ts),
// so the suite needs no agent, no LLM spend and no network — it works the same
// on a laptop and in CI.
//
// Two servers are started: the mock on MOCK_PORT, and the real BFF + built SPA
// on PORT pointed at it. That means the tests exercise the production bundle
// and the real BFF code path, with only the agent itself faked.
const PORT = Number(process.env.PORT || 3410);
const MOCK_PORT = Number(process.env.MOCK_OPENCODE_PORT || 4599);
const PREVIEW_PORT = Number(process.env.MOCK_PREVIEW_PORT || 4600);
const DSH_CORDIS = `${process.cwd()}/tests/fixtures/dsh-readonly.yml`;
const DSH_CORDIS_SHA256 = createHash("sha256").update(readFileSync(DSH_CORDIS)).digest("hex");

// The BFF persists notification preferences, notification history, project pins,
// model pins and the instruction audit to JSON files named by the env vars
// below. Each one is scoped to THIS run and emptied before the BFF boots, so a
// second local run — or a sibling worktree running concurrently on its own
// ports — can neither read nor grow another run's state. MODEL_PINS_FILE and
// INSTRUCTION_AUDIT_FILE were already pid-scoped; the other three were fixed
// strings shared by every run on the machine, which is what made the
// notification badge test in smoke.ui.spec.ts order-dependent and let history
// grow without bound (issue #80). Do not "tidy" these back to constant paths.
// Cleanup is by name only, never by glob, because a sibling worktree may be
// mid-run in the same /tmp; see tests/e2e/state-files.ts.
//
// Playwright re-imports this config inside every worker process, and a worker
// has its own pid, so only the runner may touch the filesystem here.
const stateFiles =
  process.env.TEST_WORKER_INDEX === undefined
    ? prepareE2EStateFiles({ lane: PORT, runID: process.pid })
    : e2eStateFiles(process.pid);

// The observability page reads real files, so the lane needs real ones. These
// are deterministic fixtures rewritten on every run rather than accumulated,
// which is why they are not routed through tests/e2e/state-files.ts: that
// module deliberately only knows how to own and delete `.json` files, and
// weakening that guard for log fixtures would trade a real safety property for
// convenience. Same path per lane, overwritten, never globbed or deleted.
const LOG_DIR = `/tmp/custom-dca-opencode-e2e-logs-${PORT}`;
if (process.env.TEST_WORKER_INDEX === undefined) {
  mkdirSync(LOG_DIR, { recursive: true });
  const at = (offsetMs: number) => new Date(Date.UTC(2026, 7, 29, 12, 0, 0) + offsetMs).toISOString();
  writeFileSync(
    `${LOG_DIR}/audit.jsonl`,
    [
      { ts: at(0), audit: "notification", event: "auto_approval_restore_completed", payload: { restoredCount: 3, outcome: "success" } },
      { ts: at(1_000), audit: "notification", event: "permission_asked_observed", payload: { directoryCorrelation: "dcd9225d2c65dad8", autoApprovalEnabled: true } },
      { ts: at(2_000), audit: "notification", event: "notification_decided", payload: { kind: "permission", outcome: "suppressed", suppressionReason: "auto-permissions" } },
      { ts: at(3_000), audit: "notification", event: "webpush_delivery_finished", payload: { sent: 4, failed: 0, expired: 0 } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  writeFileSync(
    `${LOG_DIR}/bff.launchd.out.log`,
    "[bff] listening on :3210 -> opencode http://127.0.0.1:4097\n",
  );
  // A header plus its frames, so the folding path has something to fold.
  writeFileSync(
    `${LOG_DIR}/bff.launchd.err.log`,
    [
      "[bus] fetch failed",
      "BadRequestError: request aborted",
      "    at IncomingMessage.onAborted (raw-body/index.js:245:10)",
      "    at IncomingMessage.emit (node:events:509:20)",
      "",
    ].join("\n"),
  );
}

// The three services are exported by name so playwright.docker.config.ts can
// reuse this exact wiring — above all the BFF's env block — instead of keeping a
// second copy that drifts. Playwright only ever reads the default export, so
// these named exports are inert for a normal run.
export const mockOpenCodeServer = {
  command: `npx tsx tests/e2e/mock-opencode.ts ${MOCK_PORT}`,
  port: MOCK_PORT,
  reuseExistingServer: !process.env.CI,
  timeout: 30_000,
};

export const mockPreviewServer = {
  command: `npx tsx tests/e2e/mock-preview.ts ${PREVIEW_PORT}`,
  port: PREVIEW_PORT,
  reuseExistingServer: !process.env.CI,
  timeout: 30_000,
};

export const appServer = {
  // Test the built bundle, not the dev server — the predecessor had bugs
  // that only appeared after a production build.
  // NODE_ENV is scoped to the server process, NOT the whole command: putting it
  // in `env` also hands it to `vite build`, which then produces a different
  // client bundle and breaks unrelated UI specs.
  command: "npm run build && NODE_ENV=test node dist/server/index.js",
  port: PORT,
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
  env: {
    PORT: String(PORT),
    OPENCODE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    PROJECTS_DIR: "/tmp",
    PROJECT_PINS_FILE: stateFiles.PROJECT_PINS_FILE,
    MODEL_PINS_FILE: stateFiles.MODEL_PINS_FILE,
    OPENCODE_WORKTREE_ROOT: "/tmp/custom-dca-opencode-e2e-worktrees",
    NOTIFICATION_PREFS_FILE: stateFiles.NOTIFICATION_PREFS_FILE,
    NOTIFICATION_HISTORY_FILE: stateFiles.NOTIFICATION_HISTORY_FILE,
    INSTRUCTION_AUDIT_FILE: stateFiles.INSTRUCTION_AUDIT_FILE,
    AUTO_APPROVE_STATE_FILE: stateFiles.AUTO_APPROVE_STATE_FILE,
    LOG_DIR,
    PREVIEW_ALLOWED_PORTS: String(PREVIEW_PORT),
    PUBLIC_APP_URL: "https://ide.e2e.example.test:8443",
    GITHUB_API_URL: `http://127.0.0.1:${PREVIEW_PORT}`,
    GITHUB_TOKEN: "e2e-planning-token",
    DSH_EXPERIMENT_ENABLED: "true",
    // The unsafe bridge is refused unless the process declares itself a test;
    // NODE_ENV is set on the server command above, never on the build.
    DSH_TEST_UNSAFE_BRIDGE: "true",
    DSH_SDK_VERSION: "0.1.1rc2",
    DSH_STATE_DIR: `/tmp/custom-dca-opencode-dsh-state-${PORT}`,
    DSH_BRIDGE_SCRIPT: `${process.cwd()}/tests/e2e/mock-dsh-bridge.py`,
    DSH_PRESETS_JSON: JSON.stringify([
      {
        id: "e2e-readonly",
        label: "E2E read-only",
        provider: "fixture",
        model: "mock-dsh",
        mode: "read-only",
        cordis: DSH_CORDIS,
        sha256: DSH_CORDIS_SHA256,
      },
      {
        id: "e2e-build",
        label: "E2E Build",
        provider: "fixture",
        model: "mock-dsh",
        mode: "build",
        cordis: DSH_CORDIS,
        sha256: DSH_CORDIS_SHA256,
      },
    ]),
    DSH_WORKSPACES_JSON: JSON.stringify([{
      id: "dsh-e2e-workspace",
      label: "DSH E2E workspace",
      directory: process.cwd(),
    }]),
    DSH_EXPERIMENT_LEDGER: `/tmp/custom-dca-opencode-dsh-ledger-${PORT}.json`,
    CLAUDE_RUNTIME_ENABLED: "true",
    // Unsafe path (mock binary, no Seatbelt) is refused unless NODE_ENV=test,
    // which is set on the server command above, never on the build.
    CLAUDE_TEST_UNSAFE: "true",
    CLAUDE_CLI_VERSION: "2.1.257",
    CLAUDE_BINARY: `${process.cwd()}/tests/e2e/mock-claude.mjs`,
    CLAUDE_STATE_DIR: `/tmp/custom-dca-opencode-claude-state-${PORT}`,
    CLAUDE_PRESETS_JSON: JSON.stringify([
      { id: "e2e-readonly", label: "E2E read-only", model: "mock-claude", effort: "high", permissionMode: "default", mode: "read-only" },
      { id: "e2e-build", label: "E2E Build", model: "mock-claude", permissionMode: "acceptEdits", mode: "build" },
    ]),
    CLAUDE_WORKSPACES_JSON: JSON.stringify([{
      id: "claude-e2e-workspace",
      label: "Claude E2E workspace",
      directory: process.cwd(),
    }]),
    CLAUDE_EXPERIMENT_LEDGER: `/tmp/custom-dca-opencode-claude-ledger-${PORT}.json`,
  },
};

export const baseUse = {
  baseURL: `http://127.0.0.1:${PORT}`,
  trace: "retain-on-failure",
  screenshot: "only-on-failure",
} as const;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [["html", { open: "never" }], ["list"]],
  use: { ...baseUse },
  webServer: [mockOpenCodeServer, mockPreviewServer, appServer],
});
