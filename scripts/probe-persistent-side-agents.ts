import "dotenv/config";

import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_SERVER_VERSION,
  OpencodeError,
  checkHealth,
  readOpencodeConfig,
  request,
  type OpencodeConfig,
  type RequestOptions,
} from "../server/opencode/client.js";
import { requireWorkspaceDirectory } from "../server/paths.js";

const ACK = "CREATE_AND_DELETE_PROBE_SESSIONS";
const DESTRUCTIVE_ACK = "DELETE_PROBE_PARENT";
const TITLE_PREFIX = "[persistent-side-agent-probe";

type ProbeStatus = "pass" | "fail" | "inconclusive" | "skipped";

interface CliOptions {
  mode: "help" | "dry-run" | "run";
  directory?: string;
  model?: { providerID: string; modelID: string };
  output?: string;
  timeoutMs: number;
  pollMs: number;
  keepSessions: boolean;
  includeParentDelete: boolean;
}

interface Session {
  id: string;
  directory: string;
  title?: string;
  parentID?: string;
  permission?: Array<{ permission: string; pattern: string; action: string }>;
}

interface Message {
  info?: {
    id?: string;
    role?: string;
    time?: { completed?: number };
    error?: unknown;
  };
  parts?: Array<{ type?: string; text?: string }>;
}

interface ProbeResult {
  id: string;
  status: ProbeStatus;
  evidence: Record<string, string | number | boolean | null | string[]>;
  error?: string;
}

interface Report {
  schemaVersion: 1;
  kind: "persistent-side-agent-live-probe";
  run: {
    id: string;
    startedAt: string;
    completedAt?: string;
    containsSensitiveLocalIdentifiers: true;
  };
  target: {
    serverOrigin: string;
    serverVersion?: string;
    expectedServerVersion: string;
    directory: { basename: string; sha256: string };
    model?: { providerID: string; modelID: string };
  };
  probes: ProbeResult[];
  cleanup: {
    status: "not-started" | "completed" | "partial" | "retained-by-request";
    retainedSessionIDs: string[];
    errors: string[];
  };
  private: {
    directory: string;
    createdSessions: Array<Session & { role: "parent" | "child" }>;
  };
}

const HELP = `Persistent side-agent OpenCode contract probe

Usage:
  npx tsx scripts/probe-persistent-side-agents.ts --help
  npx tsx scripts/probe-persistent-side-agents.ts --dry-run --directory /abs/path [--model provider/model]
  PERSISTENT_SIDE_AGENT_PROBE_ACK=${ACK} npx tsx scripts/probe-persistent-side-agents.ts --run --directory /abs/path [options]

Options:
  --output PATH                 Private JSON report path
  --timeout-ms N               Turn timeout (5000..600000; default 120000)
  --poll-ms N                  Poll interval (250..10000; default 1000)
  --keep-sessions              Retain probe sessions for manual restart testing
  --include-parent-delete      Probe cascade behavior; requires destructive acknowledgement
`;

function failArgument(message: string): never {
  const error = new Error(message) as Error & { exitCode?: number };
  error.exitCode = 2;
  throw error;
}

function integer(value: string | undefined, name: string, minimum: number, maximum: number): number {
  if (!value || !/^\d+$/u.test(value)) failArgument(`${name} requires an integer`);
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) failArgument(`${name} must be ${minimum}..${maximum}`);
  return parsed;
}

export function parseArgs(argv: string[]): CliOptions {
  if (argv.includes("--help")) return { mode: "help", timeoutMs: 120_000, pollMs: 1_000, keepSessions: false, includeParentDelete: false };

  let mode: CliOptions["mode"] | undefined;
  let directory: string | undefined;
  let model: CliOptions["model"];
  let output: string | undefined;
  let timeoutMs = 120_000;
  let pollMs = 1_000;
  let keepSessions = false;
  let includeParentDelete = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--run" || argument === "--dry-run") {
      if (mode) failArgument("choose exactly one mode");
      mode = argument === "--run" ? "run" : "dry-run";
    } else if (argument === "--directory") {
      directory = argv[++index];
    } else if (argument === "--model") {
      const raw = argv[++index] ?? "";
      const slash = raw.indexOf("/");
      if (slash <= 0 || slash === raw.length - 1) failArgument("--model must be provider/model");
      model = { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) };
    } else if (argument === "--output") {
      output = argv[++index];
    } else if (argument === "--timeout-ms") {
      timeoutMs = integer(argv[++index], "--timeout-ms", 5_000, 600_000);
    } else if (argument === "--poll-ms") {
      pollMs = integer(argv[++index], "--poll-ms", 250, 10_000);
    } else if (argument === "--keep-sessions") {
      keepSessions = true;
    } else if (argument === "--include-parent-delete") {
      includeParentDelete = true;
    } else {
      failArgument(`unknown argument: ${argument}`);
    }
  }

  if (!mode) failArgument("choose --help, --dry-run, or --run");
  if (!directory || !path.isAbsolute(directory)) failArgument("--directory must be an absolute path");
  if (mode === "dry-run" && (keepSessions || includeParentDelete)) failArgument("mutation flags require --run");
  return { mode, directory, model, output, timeoutMs, pollMs, keepSessions, includeParentDelete };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseSession(value: unknown): Session {
  if (!value || typeof value !== "object") throw new Error("invalid session response");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.directory !== "string") throw new Error("session response lacks id or directory");
  return candidate as unknown as Session;
}

function messageText(message: Message): string {
  return (message.parts ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim();
}

function completedAssistantIDs(messages: Message[]): Set<string> {
  return new Set(messages.filter((message) => message.info?.role === "assistant" && typeof message.info.time?.completed === "number").map((message) => message.info?.id).filter((id): id is string => Boolean(id)));
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForAnswer(config: OpencodeConfig, directory: string, sessionID: string, baseline: Set<string>, marker: string, options: CliOptions): Promise<{ exact: boolean; text: string }> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const messages = await request<Message[]>(config, `/session/${encodeURIComponent(sessionID)}/message`, { directory, query: { limit: 30 } });
    const answer = [...messages].reverse().find((message) => {
      const id = message.info?.id;
      return message.info?.role === "assistant" && typeof message.info.time?.completed === "number" && Boolean(id) && !baseline.has(id!);
    });
    if (answer) {
      if (answer.info?.error) throw new Error("assistant turn completed with an error");
      const text = messageText(answer);
      return { exact: text === marker, text };
    }
    await delay(options.pollMs);
  }
  throw new Error(`timed out waiting for child ${sessionID}`);
}

async function atomicWrite(filename: string, report: Report): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, filename);
}

function addProbe(report: Report, id: string, status: ProbeStatus, evidence: ProbeResult["evidence"], error?: unknown): void {
  report.probes.push({ id, status, evidence, ...(error ? { error: error instanceof Error ? error.message : "unknown error" } : {}) });
}

function creationBody(title: string, options: CliOptions, parentID?: string): Record<string, unknown> {
  return {
    title,
    agent: "build",
    ...(parentID ? { parentID } : {}),
    ...(options.model ? { model: { providerID: options.model.providerID, id: options.model.modelID } } : {}),
  };
}

function promptBody(text: string, options: CliOptions): Record<string, unknown> {
  return {
    agent: "build",
    ...(options.model ? { model: options.model } : {}),
    parts: [{ type: "text", text }],
  };
}

async function cleanup(config: OpencodeConfig, report: Report): Promise<void> {
  report.cleanup.status = "completed";
  for (const expected of [...report.private.createdSessions].reverse()) {
    try {
      const actual = parseSession(await request(config, `/session/${encodeURIComponent(expected.id)}`, { directory: report.private.directory }));
      if (actual.id !== expected.id || actual.directory !== expected.directory || actual.title !== expected.title || !actual.title?.includes(report.run.id)) throw new Error("ownership validation failed");
      const statuses = await request<Record<string, { type?: string }>>(config, "/session/status", { directory: report.private.directory }).catch((): Record<string, { type?: string }> => ({}));
      if (["busy", "retry"].includes(statuses[expected.id]?.type ?? "")) await request(config, `/session/${encodeURIComponent(expected.id)}/abort`, { method: "POST", directory: report.private.directory });
      await request(config, `/session/${encodeURIComponent(expected.id)}`, { method: "DELETE", directory: report.private.directory });
    } catch (error) {
      report.cleanup.status = "partial";
      report.cleanup.retainedSessionIDs.push(expected.id);
      report.cleanup.errors.push(error instanceof Error ? error.message : "unknown cleanup error");
    }
  }
}

export function dryRunPlan(options: CliOptions): Record<string, unknown> {
  return {
    network: false,
    filesystemWrites: false,
    directory: options.directory,
    model: options.model ?? "server default",
    probes: ["health", "parent-child relationship", "tool denial", "turn one", "idle persistence", "turn two context", "parent isolation", "cleanup"],
  };
}

async function execute(options: CliOptions): Promise<{ report: Report; output: string }> {
  if (process.env.PERSISTENT_SIDE_AGENT_PROBE_ACK !== ACK) failArgument(`set PERSISTENT_SIDE_AGENT_PROBE_ACK=${ACK}`);
  if (options.includeParentDelete && process.env.PERSISTENT_SIDE_AGENT_DESTRUCTIVE_ACK !== DESTRUCTIVE_ACK) failArgument(`set PERSISTENT_SIDE_AGENT_DESTRUCTIVE_ACK=${DESTRUCTIVE_ACK}`);

  const config = readOpencodeConfig();
  const directory = await requireWorkspaceDirectory(options.directory);
  const runID = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const origin = new URL(config.baseUrl);
  origin.username = "";
  origin.password = "";
  origin.pathname = "/";
  origin.search = "";
  const report: Report = {
    schemaVersion: 1,
    kind: "persistent-side-agent-live-probe",
    run: { id: runID, startedAt: new Date().toISOString(), containsSensitiveLocalIdentifiers: true },
    target: { serverOrigin: origin.origin, expectedServerVersion: EXPECTED_SERVER_VERSION, directory: { basename: path.basename(directory), sha256: hash(directory) }, ...(options.model ? { model: options.model } : {}) },
    probes: [],
    cleanup: { status: "not-started", retainedSessionIDs: [], errors: [] },
    private: { directory, createdSessions: [] },
  };
  const output = path.resolve(options.output ?? `.state/persistent-side-agent-probes/${runID}.json`);

  try {
    const health = await checkHealth(config);
    report.target.serverVersion = health.version;
    addProbe(report, "contract.health", health.healthy ? "pass" : "fail", { healthy: health.healthy, version: health.version, versionMatches: health.versionMatches });

    const toolIDs = await request<unknown[]>(config, "/experimental/tool/ids", { directory });
    const tools = toolIDs.filter((tool): tool is string => typeof tool === "string");
    if (tools.length === 0) throw new Error("tool catalogue was empty or invalid");

    const parentTitle = `${TITLE_PREFIX} ${runID}] parent`;
    const parent = parseSession(await request(config, "/session", { method: "POST", directory, body: creationBody(parentTitle, options) }));
    report.private.createdSessions.push({ ...parent, role: "parent" });
    const childTitle = `${TITLE_PREFIX} ${runID}] child`;
    const child = parseSession(await request(config, "/session", { method: "POST", directory, body: creationBody(childTitle, options, parent.id) }));
    report.private.createdSessions.push({ ...child, role: "child" });
    addProbe(report, "relationship.create", child.parentID === parent.id ? "pass" : "fail", { childHasExpectedParent: child.parentID === parent.id });

    const children = await request<Session[]>(config, `/session/${encodeURIComponent(parent.id)}/children`, { directory });
    const sessions = await request<Session[]>(config, "/session", { directory, query: { limit: 100 } });
    addProbe(report, "relationship.children", children.filter((item) => item.id === child.id).length === 1 ? "pass" : "fail", { childMatches: children.filter((item) => item.id === child.id).length });
    addProbe(report, "relationship.list", sessions.some((item) => item.id === parent.id) && sessions.some((item) => item.id === child.id) ? "pass" : "fail", { bothListed: sessions.some((item) => item.id === parent.id) && sessions.some((item) => item.id === child.id) });

    const permission = tools.map((tool) => ({ permission: tool, pattern: "*", action: "deny" }));
    await request(config, `/session/${encodeURIComponent(child.id)}`, { method: "PATCH", directory, body: { permission } });
    const patched = parseSession(await request(config, `/session/${encodeURIComponent(child.id)}`, { directory }));
    const suffix = (patched.permission ?? []).slice(-permission.length);
    addProbe(report, "safety.permissions", JSON.stringify(suffix) === JSON.stringify(permission) ? "pass" : "fail", { deniedToolCount: permission.length });

    const parentBefore = await request<Message[]>(config, `/session/${encodeURIComponent(parent.id)}/message`, { directory, query: { limit: 30 } });
    const firstBaseline = completedAssistantIDs(await request<Message[]>(config, `/session/${encodeURIComponent(child.id)}/message`, { directory, query: { limit: 30 } }));
    const markerOne = `PSA_PROBE_${runID}_TURN_1`;
    await request(config, `/session/${encodeURIComponent(child.id)}/prompt_async`, { method: "POST", directory, body: promptBody(`This is a non-mutating contract probe. Do not call tools. Reply exactly: ${markerOne}`, options) });
    const first = await waitForAnswer(config, directory, child.id, firstBaseline, markerOne, options);
    addProbe(report, "prompt.first", first.exact ? "pass" : "fail", { exactMarkerMatched: first.exact });

    const statuses = await request<Record<string, { type?: string }>>(config, "/session/status", { directory });
    const childStillReadable = parseSession(await request(config, `/session/${encodeURIComponent(child.id)}`, { directory })).id === child.id;
    addProbe(report, "persistence.idle", childStillReadable && !["busy", "retry"].includes(statuses[child.id]?.type ?? "") ? "pass" : "fail", { childStillReadable, reportedBusy: ["busy", "retry"].includes(statuses[child.id]?.type ?? "") });

    const secondBaseline = completedAssistantIDs(await request<Message[]>(config, `/session/${encodeURIComponent(child.id)}/message`, { directory, query: { limit: 30 } }));
    const markerTwo = `PSA_PROBE_${runID}_TURN_2_AFTER_${markerOne}`;
    await request(config, `/session/${encodeURIComponent(child.id)}/prompt_async`, { method: "POST", directory, body: promptBody(`This is turn two. Do not call tools. Reply exactly: ${markerTwo}`, options) });
    const second = await waitForAnswer(config, directory, child.id, secondBaseline, markerTwo, options);
    addProbe(report, "prompt.second", second.exact ? "pass" : "fail", { exactMarkerMatched: second.exact });
    addProbe(report, "persistence.context", second.text.includes(markerOne) ? "pass" : "fail", { firstMarkerObserved: second.text.includes(markerOne) });

    const parentAfter = await request<Message[]>(config, `/session/${encodeURIComponent(parent.id)}/message`, { directory, query: { limit: 30 } });
    addProbe(report, "parent.isolation", "inconclusive", { parentMessageCountChanged: parentAfter.length !== parentBefore.length });

    if (options.includeParentDelete) {
      await request(config, `/session/${encodeURIComponent(parent.id)}`, { method: "DELETE", directory });
      report.private.createdSessions = report.private.createdSessions.filter((session) => session.id !== parent.id);
      const childAfter = await request<Session>(config, `/session/${encodeURIComponent(child.id)}`, { directory }).catch(() => null);
      addProbe(report, "parent.delete", "inconclusive", { behavior: !childAfter ? "cascade" : childAfter.parentID === parent.id ? "orphan-retained" : "parent-link-cleared" });
    }
  } catch (error) {
    addProbe(report, "run", "fail", {}, error instanceof OpencodeError ? new Error(`HTTP ${error.status} from ${error.path}`) : error);
  } finally {
    if (options.keepSessions) {
      report.cleanup.status = "retained-by-request";
      report.cleanup.retainedSessionIDs = report.private.createdSessions.map((session) => session.id);
    } else {
      await cleanup(config, report);
    }
    report.run.completedAt = new Date().toISOString();
    await atomicWrite(output, report);
  }
  return { report, output };
}

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.mode === "help") {
      process.stdout.write(HELP);
      return;
    }
    if (options.mode === "dry-run") {
      process.stdout.write(`${JSON.stringify(dryRunPlan(options), null, 2)}\n`);
      return;
    }
    const { report, output } = await execute(options);
    const failed = report.probes.some((probe) => probe.status === "fail") || report.cleanup.status === "partial";
    process.stdout.write(`${JSON.stringify({ runID: report.run.id, server: report.target.serverOrigin, directory: report.target.directory, results: report.probes.map(({ id, status }) => ({ id, status })), cleanup: report.cleanup.status, privateReport: output }, null, 2)}\n`);
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    const exitCode = (error as Error & { exitCode?: number }).exitCode ?? 1;
    process.stderr.write(`${error instanceof Error ? error.message : "unknown probe error"}\n`);
    process.exitCode = exitCode;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main();
}
