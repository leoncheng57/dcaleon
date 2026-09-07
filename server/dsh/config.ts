import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export type DshPresetMode = "read-only" | "build";

export interface DshPreset {
  id: string;
  label: string;
  provider: string;
  model: string;
  maxTokens?: number;
  cordis: string;
  fingerprint: string;
  mode: DshPresetMode;
}

export interface DshWorkspace {
  id: string;
  label: string;
  directory: string;
  device: number;
  inode: number;
}

export interface DshConfig {
  enabled: boolean;
  configured: boolean;
  python: string;
  bridgeScript: string;
  sessionRoot: string;
  ledgerFile: string;
  sessionsFile?: string;
  trajectoryRoot: string;
  trajectorySensitiveEnabled: boolean;
  trajectoryFullExportEnabled: boolean;
  sdkVersion: string;
  sandbox: "seatbelt" | "test-unsafe";
  presets: DshPreset[];
  workspaces: DshWorkspace[];
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

export function readDshConfig(env: NodeJS.ProcessEnv = process.env): DshConfig {
  const enabled = env.DSH_EXPERIMENT_ENABLED === "true";
  const errors: string[] = [];
  const root = canonicalProspective(path.resolve(env.DSH_STATE_DIR || ".state/dsh"));
  const sdkVersion = env.DSH_SDK_VERSION || "";
  // The unsafe bridge removes the Seatbelt workspace-write backstop, so it may
  // only be honoured by an explicit test process. A deployed service (the
  // launchd plist sets NODE_ENV=production) can never opt into it, and asking
  // for it outside a test fails closed rather than silently downgrading to
  // Seatbelt: a run that believed it was unsandboxed must not proceed either.
  const testUnsafeRequested = env.DSH_TEST_UNSAFE_BRIDGE === "true";
  const testUnsafe = testUnsafeRequested && env.NODE_ENV === "test";
  const sandbox = testUnsafe ? "test-unsafe" : "seatbelt";
  if (testUnsafeRequested && !testUnsafe) {
    errors.push("DSH_TEST_UNSAFE_BRIDGE is test-only and requires NODE_ENV=test");
  }
  if (enabled && !/^\d+\.\d+\.\d+(?:[A-Za-z0-9.-]+)?$/.test(sdkVersion)) {
    errors.push("DSH_SDK_VERSION must pin one exact SDK version");
  }
  if (enabled && process.platform !== "darwin" && !testUnsafe) {
    errors.push("DSH V1 requires macOS Seatbelt; non-macOS launch is test-only");
  }
  if (enabled && !testUnsafe && !path.isAbsolute(env.DSH_PYTHON || "")) {
    errors.push("DSH_PYTHON must be an absolute interpreter path");
  }
  let rawPresets: unknown = [];
  let rawWorkspaces: unknown = [];
  try {
    rawPresets = JSON.parse(env.DSH_PRESETS_JSON || "[]");
  } catch {
    errors.push("DSH_PRESETS_JSON must be valid JSON");
  }
  try {
    rawWorkspaces = JSON.parse(env.DSH_WORKSPACES_JSON || "[]");
  } catch {
    errors.push("DSH_WORKSPACES_JSON must be valid JSON");
  }

  const presets: DshPreset[] = [];
  if (!Array.isArray(rawPresets)) errors.push("DSH_PRESETS_JSON must be an array");
  else for (const candidate of rawPresets) {
    const item = candidate as Record<string, unknown>;
    const cordisInput = absolute(item.cordis);
    const mode = item.mode === "read-only" || item.mode === "build" ? item.mode : null;
    if (!SAFE_ID.test(String(item.id ?? "")) || typeof item.label !== "string" ||
        typeof item.provider !== "string" || typeof item.model !== "string" || !cordisInput ||
        !mode || !/^[a-f0-9]{64}$/.test(String(item.sha256 ?? ""))) {
      errors.push("every DSH preset needs a safe id, label, provider, model, mode=read-only|build, absolute cordis path, and sha256");
      continue;
    }
    if (!existsSync(cordisInput)) {
      errors.push(`DSH preset ${String(item.id)} cordis file does not exist`);
      continue;
    }
    const cordis = realpathSync(cordisInput);
    const fingerprint = createHash("sha256").update(readFileSync(cordis)).digest("hex");
    if (fingerprint !== item.sha256) {
      errors.push(`DSH preset ${String(item.id)} composition fingerprint does not match`);
      continue;
    }
    const maxTokens = item.maxTokens === undefined ? undefined : Number(item.maxTokens);
    if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens <= 0)) {
      errors.push(`DSH preset ${String(item.id)} has an invalid maxTokens`);
      continue;
    }
    presets.push({
      id: String(item.id), label: item.label, provider: item.provider, model: item.model, cordis, mode,
      fingerprint, ...(maxTokens ? { maxTokens } : {}),
    });
  }

  const workspaces: DshWorkspace[] = [];
  if (!Array.isArray(rawWorkspaces)) errors.push("DSH_WORKSPACES_JSON must be an array");
  else for (const candidate of rawWorkspaces) {
    const item = candidate as Record<string, unknown>;
    const directory = absolute(item.directory);
    if (!SAFE_ID.test(String(item.id ?? "")) || typeof item.label !== "string" || !directory) {
      errors.push("every DSH workspace needs a safe id, label, and absolute directory");
      continue;
    }
    if (!existsSync(directory)) {
      errors.push(`DSH workspace ${String(item.id)} does not exist`);
      continue;
    }
    const canonical = realpathSync(directory);
    const metadata = statSync(canonical);
    workspaces.push({ id: String(item.id), label: item.label, directory: canonical, device: metadata.dev, inode: metadata.ino });
  }

  const bridgeScript = path.resolve(env.DSH_BRIDGE_SCRIPT || "scripts/dsh-bridge.py");
  if (enabled && !existsSync(bridgeScript)) errors.push("DSH bridge script does not exist");
  if (enabled && presets.length === 0) errors.push("at least one DSH preset is required");
  if (enabled && workspaces.length === 0) errors.push("at least one allowlisted DSH workspace is required");
  for (const workspace of workspaces) {
    const relative = path.relative(workspace.directory, root);
    const reverse = path.relative(root, workspace.directory);
    if ((!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) ||
        (!reverse || (!reverse.startsWith("..") && !path.isAbsolute(reverse)))) {
      errors.push(`DSH state directory must not overlap workspace ${workspace.id}`);
    }
  }

  return {
    enabled,
    configured: enabled && errors.length === 0,
    python: env.DSH_PYTHON || "python3",
    bridgeScript,
    sessionRoot: path.join(root, "sessions"),
    ledgerFile: path.resolve(env.DSH_EXPERIMENT_LEDGER || path.join(root, "experiment-ledger.json")),
    sessionsFile: path.join(root, "session-index.json"),
    trajectoryRoot: path.join(root, "trajectory"),
    trajectorySensitiveEnabled: env.DSH_TRAJECTORY_SENSITIVE_ENABLED === "true",
    trajectoryFullExportEnabled: env.DSH_TRAJECTORY_SENSITIVE_ENABLED === "true" && env.DSH_TRAJECTORY_FULL_EXPORT_ENABLED === "true",
    sdkVersion,
    sandbox,
    presets,
    workspaces,
    errors,
  };
}
