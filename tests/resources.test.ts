import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { registerResourceProcess, resourceProcessRoles } from "../server/resource-processes.js";
import { cpuSeconds, localOpencodePort, parseProcesses, ResourceMonitor, selectProcesses, type ProcessSample } from "../server/resources.js";

const processRow = (pid: number, parentPid = 1, executable = "node", seconds = 1): ProcessSample => ({
  pid, parentPid, executable, cpuSeconds: seconds, memoryBytes: 1024, started: "Mon Sep 7 12:00:00 2026",
});
const host = { idle: 500, total: 1000, cores: 8, totalMemoryBytes: 16000, freeMemoryBytes: 4000 };

describe("resource sampler", () => {
  it("tracks runtime-owned labels and removes exited children without deleting a reused PID", () => {
    const child = () => Object.assign(new EventEmitter(), { pid: 1234567, exitCode: null, signalCode: null }) as ChildProcess;
    const first = child();
    registerResourceProcess(first, "Claude");
    expect(resourceProcessRoles().get(first.pid!)).toBe("Claude");
    const second = child();
    registerResourceProcess(second, "DSH");
    first.emit("exit", 0);
    expect(resourceProcessRoles().get(second.pid!)).toBe("DSH");
    second.emit("exit", 0);
    expect(resourceProcessRoles().has(second.pid!)).toBe(false);
  });
  it("parses macOS/Linux ps counters without returning command paths", () => {
    const rows = parseProcesses(" 42 1 512 00:01.50 Mon Sep  7 12:00:00 2026 /private/path with spaces/claude\n 43 42 256 1-02:03:04 Mon Sep 7 12:00:01 2026 /usr/bin/git\ninvalid");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ pid: 42, parentPid: 1, memoryBytes: 524288, cpuSeconds: 1.5, executable: "claude" });
    expect(rows[1].cpuSeconds).toBe(93784);
    expect(cpuSeconds("02:03")).toBe(123);
    expect(Number.isNaN(cpuSeconds("bad"))).toBe(true);
  });

  it("walks only selected trees, deduplicates nested roots and tolerates cycles", () => {
    const rows = [processRow(1, 2), processRow(2, 1), processRow(3, 2), processRow(8, 9)];
    expect(selectProcesses(rows, [1, 2]).map((row) => row.pid).sort()).toEqual([1, 2, 3]);
  });

  it("never inspects a caller-selected remote host or invalid URL", () => {
    expect(localOpencodePort("http://127.0.0.1:4096")).toBe(4096);
    expect(localOpencodePort("http://[::1]:4096")).toBe(4096);
    expect(localOpencodePort("https://localhost")).toBe(443);
    for (const url of ["http://host.example:4096", "http://127.0.0.1.evil:4096", "file:///tmp/server", "bad"]) expect(localOpencodePort(url)).toBeNull();
  });

  it("shares concurrent reads and caches samples across tabs without a timer", async () => {
    let now = 0;
    const processes = vi.fn(async () => [processRow(10)]);
    const monitor = new ResourceMonitor("http://remote:4096", { now: () => now, host: () => host, pid: 10, platform: "linux", processes });
    const [a, b] = await Promise.all([monitor.read(), monitor.read()]);
    expect(a).toBe(b);
    expect(a.total.cpuPercent).toBeNull();
    now = 4999;
    expect(await monitor.read()).toBe(a);
    expect(processes).toHaveBeenCalledTimes(1);
    now = 5000;
    await monitor.read();
    expect(processes).toHaveBeenCalledTimes(2);
  });

  it("calculates interval CPU, includes local OpenCode and excludes unrelated processes and sampler commands", async () => {
    let now = 0;
    let rows = [processRow(10), processRow(11, 10, "claude"), processRow(12, 10, "ps"), processRow(20, 1, "opencode-1.18.23"), processRow(21, 20, "git"), processRow(90, 1, "secret-program")];
    let currentHost = host;
    const monitor = new ResourceMonitor("http://localhost:4096", { now: () => now, host: () => currentHost, pid: 10, platform: "darwin", processes: async () => rows, listeners: async () => [20, 90] });
    await monitor.read();
    now = 5000;
    rows = rows.map((row) => ({ ...row, cpuSeconds: row.cpuSeconds + 2.5 }));
    currentHost = { ...host, total: 2000, idle: 1000 };
    const snapshot = await monitor.read();
    expect(snapshot.opencode).toBe("included");
    expect(snapshot.processes.map((row) => row.pid)).toEqual([10, 11, 20, 21]);
    expect(snapshot.total).toMatchObject({ cpuPercent: 200, memoryBytes: 4096, processCount: 4, warmingCount: 0 });
    expect(snapshot.host.cpuPercent).toBe(50);
    expect(JSON.stringify(snapshot)).not.toContain("secret-program");
    expect(snapshot.processes[0].label).toBe("DCA server");
  });

  it("warms reused PIDs/new children and restarts CPU sampling after long gaps", async () => {
    let now = 0;
    let rows = [processRow(10)];
    const monitor = new ResourceMonitor("http://remote", { now: () => now, host: () => host, pid: 10, platform: "linux", processes: async () => rows });
    await monitor.read();
    now = 5000;
    rows = [{ ...processRow(10), started: "new start" }, processRow(11, 10, "claude")];
    expect((await monitor.read()).total.warmingCount).toBe(2);
    now = 40000;
    expect((await monitor.read()).total.cpuPercent).toBeNull();
  });

  it("bounds visible rows but computes totals from every tracked process", async () => {
    const rows = [processRow(10), ...Array.from({ length: 150 }, (_, i) => processRow(100 + i, 10))];
    const monitor = new ResourceMonitor("http://remote", { host: () => host, pid: 10, platform: "linux", processes: async () => rows });
    const result = await monitor.read();
    expect(result.truncated).toBe(true);
    expect(result.processes).toHaveLength(128);
    expect(result.total.processCount).toBe(151);
    expect(result.total.memoryBytes).toBe(151 * 1024);
  });

  it("degrades honestly when process inspection fails, without leaking errors", async () => {
    const monitor = new ResourceMonitor("http://localhost", { host: () => host, platform: "linux", processes: async () => { throw new Error("secret path"); }, listeners: async () => [] });
    const result = await monitor.read();
    expect(result.available).toBe(false);
    expect(result.total.cpuPercent).toBeNull();
    expect(JSON.stringify(result)).not.toContain("secret path");
    const unsupported = new ResourceMonitor("http://remote", { platform: "win32" });
    expect((await unsupported.read()).reason).toContain("macOS and Linux");
  });
});
