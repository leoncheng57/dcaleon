import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export type ClaudePresetMode = "read-only" | "build";

// Claude Code's own permission modes plus the runtime's read-only default.
// `ask` has no answerer in a headless lane, so a preset never selects an
// interactive mode here — the generated settings file maps ask -> deny.
const PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk"]);
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

export interface ClaudePreset {
  id: string;
  label: string;
  model: string;
  effort?: string;
  permissionMode: string;
  mode: ClaudePresetMode;
  maxBudgetUsd?: number;
}

export interface ClaudeWorkspace {
  id: string;
  label: string;
  directory: string;
  device: number;
  inode: number;
}

export interface ClaudeConfig {
  enabled: boolean;
  configured: boolean;
  binaryPath: string;
  cliVersion: string;
  sessionRoot: string;
  ledgerFile: string;
  sandbox: "seatbelt" | "test-unsafe";
  presets: ClaudePreset[];
  workspaces: ClaudeWorkspace[];
  errors: string[];
}

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function absolute(value: unknown): string | null {
  return typeof value === "string" && path.isAbsolute(value) ? path.normalize(value) : null;
}

function canonicalProspective(value: string): string {
  let cursor = value;
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return value;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(realpathSync(cursor), ...suffix);
}

export function readClaudeConfig(env: NodeJS.ProcessEnv = process.env): ClaudeConfig {
  const enabled = env.CLAUDE_RUNTIME_ENABLED === "true";
  const errors: string[] = [];
  const root = canonicalProspective(path.resolve(env.CLAUDE_STATE_DIR || ".state/claude"));
  const cliVersion = env.CLAUDE_CLI_VERSION || "";

  // The unsafe path drops the Seatbelt workspace-write backstop and points the
  // supervisor at a mock binary, so it may only be honoured by an explicit test
  // process. A deployed service (the launchd plist sets NODE_ENV=production) can
  // never opt into it, and asking for it outside a test fails closed rather than
  // silently downgrading to Seatbelt.
  const testUnsafeRequested = env.CLAUDE_TEST_UNSAFE === "true";
  const testUnsafe = testUnsafeRequested && env.NODE_ENV === "test";
  const sandbox = testUnsafe ? "test-unsafe" : "seatbelt";
  if (testUnsafeRequested && !testUnsafe) {
    errors.push("CLAUDE_TEST_UNSAFE is test-only and requires NODE_ENV=test");
  }
  if (enabled && !/^\d+\.\d+\.\d+(?:[A-Za-z0-9.-]+)?$/.test(cliVersion)) {
    errors.push("CLAUDE_CLI_VERSION must pin one exact CLI version");
  }
  if (enabled && process.platform !== "darwin" && !testUnsafe) {
    errors.push("Claude runtime V1 requires macOS Seatbelt; non-macOS launch is test-only");
  }

  const binaryInput = absolute(env.CLAUDE_BINARY);
  let binaryPath = "";
  if (enabled) {
    if (!binaryInput) {
      errors.push("CLAUDE_BINARY must be an absolute path to the claude executable");
    } else if (!existsSync(binaryInput)) {
      errors.push("CLAUDE_BINARY does not exist");
    } else {
      binaryPath = realpathSync(binaryInput);
    }
  } else if (binaryInput && existsSync(binaryInput)) {
    binaryPath = realpathSync(binaryInput);
  }

  let rawPresets: unknown = [];
  let rawWorkspaces: unknown = [];
  try {
    rawPresets = JSON.parse(env.CLAUDE_PRESETS_JSON || "[]");
  } catch {
    errors.push("CLAUDE_PRESETS_JSON must be valid JSON");
  }
  try {
    rawWorkspaces = JSON.parse(env.CLAUDE_WORKSPACES_JSON || "[]");
  } catch {
    errors.push("CLAUDE_WORKSPACES_JSON must be valid JSON");
  }

  const presets: ClaudePreset[] = [];
  if (!Array.isArray(rawPresets)) errors.push("CLAUDE_PRESETS_JSON must be an array");
  else for (const candidate of rawPresets) {
    const item = candidate as Record<string, unknown>;
    const mode = item.mode === "read-only" || item.mode === "build" ? item.mode : null;
    const permissionMode = typeof item.permissionMode === "string" && PERMISSION_MODES.has(item.permissionMode) ? item.permissionMode : null;
    if (!SAFE_ID.test(String(item.id ?? "")) || typeof item.label !== "string" ||
        typeof item.model !== "string" || !item.model || !mode || !permissionMode) {
      errors.push("every Claude preset needs a safe id, label, model, mode=read-only|build, and a non-interactive permissionMode");
      continue;
    }
    if (item.effort !== undefined && !(typeof item.effort === "string" && EFFORT_LEVELS.has(item.effort))) {
      errors.push(`Claude preset ${String(item.id)} has an invalid effort`);
      continue;
    }
    const maxBudgetUsd = item.maxBudgetUsd === undefined ? undefined : Number(item.maxBudgetUsd);
    if (maxBudgetUsd !== undefined && (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0)) {
      errors.push(`Claude preset ${String(item.id)} has an invalid maxBudgetUsd`);
      continue;
    }
    presets.push({
      id: String(item.id), label: item.label, model: item.model, permissionMode, mode,
      ...(typeof item.effort === "string" ? { effort: item.effort } : {}),
      ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
    });
  }

  const workspaces: ClaudeWorkspace[] = [];
  if (!Array.isArray(rawWorkspaces)) errors.push("CLAUDE_WORKSPACES_JSON must be an array");
  else for (const candidate of rawWorkspaces) {
    const item = candidate as Record<string, unknown>;
    const directory = absolute(item.directory);
    if (!SAFE_ID.test(String(item.id ?? "")) || typeof item.label !== "string" || !directory) {
      errors.push("every Claude workspace needs a safe id, label, and absolute directory");
      continue;
    }
    if (!existsSync(directory)) {
      errors.push(`Claude workspace ${String(item.id)} does not exist`);
      continue;
    }
    const canonical = realpathSync(directory);
    const metadata = statSync(canonical);
    workspaces.push({ id: String(item.id), label: item.label, directory: canonical, device: metadata.dev, inode: metadata.ino });
  }

  if (enabled && presets.length === 0) errors.push("at least one Claude preset is required");
  if (enabled && workspaces.length === 0) errors.push("at least one allowlisted Claude workspace is required");
  for (const workspace of workspaces) {
    const relative = path.relative(workspace.directory, root);
    const reverse = path.relative(root, workspace.directory);
    if ((!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) ||
        (!reverse || (!reverse.startsWith("..") && !path.isAbsolute(reverse)))) {
      errors.push(`Claude state directory must not overlap workspace ${workspace.id}`);
    }
  }

  return {
    enabled,
    configured: enabled && errors.length === 0,
    binaryPath,
    cliVersion,
    sessionRoot: path.join(root, "sessions"),
    ledgerFile: path.resolve(env.CLAUDE_EXPERIMENT_LEDGER || path.join(root, "experiment-ledger.json")),
    sandbox,
    presets,
    workspaces,
    errors,
  };
}
