import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ResourceProcess, ResourceSnapshot } from "./resource-types.js";
import { resourceProcessRoles } from "./resource-processes.js";

const run = promisify(execFile);
const SAMPLE_MS = 5_000;
const MAX_ROWS = 128;

export interface ProcessSample {
  pid: number; parentPid: number; memoryBytes: number; cpuSeconds: number; started: string; executable: string;
}

/** ps TIME is [days-][hours:]minutes:seconds, sometimes with fractional seconds. */
export function cpuSeconds(value: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  return match ? Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3]) * 60 + Number(match[4]) : NaN;
}

export function parseProcesses(stdout: string): ProcessSample[] {
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(line);
    if (!match) return [];
    const seconds = cpuSeconds(match[4]);
    if (!Number.isFinite(seconds)) return [];
    return [{ pid: Number(match[1]), parentPid: Number(match[2]), memoryBytes: Number(match[3]) * 1024,
      cpuSeconds: seconds, started: match[5].replace(/\s+/g, " "), executable: path.basename(match[6]) }];
  });
}

/** Only fixed role names cross the API, never command lines or filesystem paths. */
function role(executable: string): string {
  if (/^claude(?:[-.]|$)/i.test(executable)) return "Claude";
  if (/^opencode(?:[-.]|$)/i.test(executable)) return "OpenCode";
  if (/chrom(e|ium)/i.test(executable)) return "Browser";
  if (/^(node|bun)(?:[-.]|$)/i.test(executable)) return "JavaScript runtime";
  if (/^python/i.test(executable)) return "Python runtime";
  if (/^(ba|z|da)?sh$/.test(executable)) return "Shell";
  if (executable === "git") return "Git";
  return "Child process";
}

export function selectProcesses(rows: ProcessSample[], roots: number[]): ProcessSample[] {
  const children = new Map<number, ProcessSample[]>();
  for (const row of rows) {
    const siblings = children.get(row.parentPid);
    if (siblings) siblings.push(row);
    else children.set(row.parentPid, [row]);
  }
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const selected = new Map<number, ProcessSample>();
  const pending = roots.flatMap((pid) => byPid.has(pid) ? [byPid.get(pid)!] : []);
  while (pending.length) {
    const row = pending.pop()!;
    if (selected.has(row.pid)) continue;
    selected.set(row.pid, row);
    pending.push(...(children.get(row.pid) ?? []));
  }
  return [...selected.values()];
}

export function localOpencodePort(baseUrl: string): number | null {
  try {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
    return Number(url.port || (url.protocol === "https:" ? 443 : 80));
  } catch { return null; }
}

export interface HostSample { idle: number; total: number; cores: number; totalMemoryBytes: number; freeMemoryBytes: number }
function hostSample(): HostSample {
  const cpus = os.cpus();
  return { idle: cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0),
    total: cpus.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0),
    cores: cpus.length, totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem() };
}

interface Dependencies {
  now: () => number;
  host: () => HostSample;
  processes: () => Promise<ProcessSample[]>;
  listeners: (port: number) => Promise<number[]>;
  pid: number;
  platform: string;
  roles: () => ReadonlyMap<number, "Claude" | "DSH">;
}
const defaults: Dependencies = {
  now: () => performance.now(), host: hostSample, pid: process.pid, platform: process.platform, roles: resourceProcessRoles,
  processes: async () => {
    const { stdout } = await run("ps", ["-axo", "pid=,ppid=,rss=,time=,lstart=,comm="], {
      timeout: 2_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" },
    });
    return parseProcesses(stdout);
  },
  listeners: async (port) => {
    const { stdout } = await run("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { timeout: 1_000, maxBuffer: 64 * 1024 });
    return stdout.trim().split(/\s+/).map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  },
};

/** On demand, single-flight and shared by all tabs. No permanent sampling timer. */
export class ResourceMonitor {
  private cached?: { at: number; snapshot: ResourceSnapshot };
  private pending?: Promise<ResourceSnapshot>;
  private previous?: { at: number; host: HostSample; processes: Map<number, ProcessSample> };
  private readonly deps: Dependencies;
  constructor(private readonly baseUrl: string, dependencies: Partial<Dependencies> = {}) {
    this.deps = { ...defaults, ...dependencies };
  }
  read(): Promise<ResourceSnapshot> {
    if (this.pending) return this.pending;
    if (this.cached && this.deps.now() - this.cached.at < SAMPLE_MS) return Promise.resolve(this.cached.snapshot);
    this.pending = this.sample().then((snapshot) => {
      this.cached = { at: this.deps.now(), snapshot };
      return snapshot;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async sample(): Promise<ResourceSnapshot> {
    const host = this.deps.host();
    const port = localOpencodePort(this.baseUrl);
    const snapshot: ResourceSnapshot = {
      sampledAt: new Date().toISOString(), available: false,
      host: { cpuPercent: null, cores: host.cores, usedMemoryBytes: host.totalMemoryBytes - host.freeMemoryBytes, totalMemoryBytes: host.totalMemoryBytes },
      total: { cpuPercent: null, memoryBytes: 0, processCount: 0, warmingCount: 0 }, processes: [], truncated: false,
      opencode: port === null ? "remote" : "unavailable",
    };
    if (!["darwin", "linux"].includes(this.deps.platform)) {
      snapshot.reason = "Process sampling is supported on macOS and Linux.";
      return snapshot;
    }
    try {
      const [rows, listeners] = await Promise.all([this.deps.processes(), port === null ? Promise.resolve<number[]>([]) : this.deps.listeners(port).catch(() => [])]);
      // A different program listening on that port must not become an OpenCode root.
      const opencode = rows.filter((row) => listeners.includes(row.pid) && /^opencode(?:[-.]|$)/i.test(row.executable)).map((row) => row.pid);
      if (opencode.length) snapshot.opencode = "included";
      const selected = selectProcesses(rows, [this.deps.pid, ...opencode])
        .filter((row) => !(row.parentPid === this.deps.pid && ["ps", "lsof"].includes(row.executable)));
      if (!selected.some((row) => row.pid === this.deps.pid)) throw new Error("Missing server process");
      const at = this.deps.now();
      const previous = this.previous;
      // After an unopened monitor resumes, warm up again rather than call a long average live usage.
      const elapsed = previous ? at - previous.at : 0;
      const comparable = elapsed > 0 && elapsed <= 30_000;
      if (previous && comparable && host.total > previous.host.total) {
        snapshot.host.cpuPercent = Math.max(0, Math.min(100, 100 * (1 - (host.idle - previous.host.idle) / (host.total - previous.host.total))));
      }
      const roles = this.deps.roles();
      const processes: ResourceProcess[] = selected.map((row) => {
        const old = previous?.processes.get(row.pid);
        const cpuPercent = comparable && old?.started === row.started && old.executable === row.executable && row.cpuSeconds >= old.cpuSeconds
          ? 100_000 * (row.cpuSeconds - old.cpuSeconds) / elapsed : null;
        return { pid: row.pid, parentPid: row.parentPid, label: row.pid === this.deps.pid ? "DCA server" : roles.get(row.pid) ?? role(row.executable), cpuPercent, memoryBytes: row.memoryBytes };
      });
      const measured = processes.filter((row) => row.cpuPercent !== null);
      snapshot.available = true;
      snapshot.total = { cpuPercent: measured.length ? measured.reduce((sum, row) => sum + row.cpuPercent!, 0) : null,
        memoryBytes: processes.reduce((sum, row) => sum + row.memoryBytes, 0), processCount: processes.length, warmingCount: processes.length - measured.length };
      snapshot.processes = processes.sort((a, b) => b.memoryBytes - a.memoryBytes || a.pid - b.pid).slice(0, MAX_ROWS);
      snapshot.truncated = processes.length > MAX_ROWS;
      this.previous = { at, host, processes: new Map(selected.map((row) => [row.pid, row])) };
    } catch {
      snapshot.reason = "Process usage could not be sampled on this host.";
      this.previous = undefined;
    }
    return snapshot;
  }
}
