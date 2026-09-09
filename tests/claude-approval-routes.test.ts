import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaudeApprovalStore } from "../server/claude/approvals.js";
import type { ClaudeConfig } from "../server/claude/config.js";
import { ClaudeSessionStore } from "../server/claude/store.js";
import type { ClaudeSupervisor } from "../server/claude/supervisor.js";
import type { AutoPermissionService } from "../server/opencode/autoPermissions.js";
import { claudeRoutes } from "../server/routes/claude.js";

const temporary: string[] = [];
const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];
const stores: ClaudeSessionStore[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(stores.splice(0).map((store) => store.flush()));
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(input: { approvals?: boolean; autoPermissions?: boolean; mode?: "build" | "read-only" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-approval-routes-"));
  temporary.push(root);
  const store = new ClaudeSessionStore(path.join(root, "ledger.json"));
  stores.push(store);
  await store.load();
  const session = store.create({
    presetId: "p", workspaceId: "ws", workspaceLabel: "WS", mode: input.mode ?? "build", isolation: "direct",
    directory: "/tmp/project", projectDirectory: "/tmp/project", title: "Gate me",
  });
  const config = {
    enabled: true, configured: true, binaryPath: "/bin/false", cliVersion: "2.1.263", sessionRoot: path.join(root, "sessions"),
    ledgerFile: path.join(root, "ledger.json"), approvals: input.approvals ?? true, presets: [], workspaces: [], errors: [], models: [],
  } as unknown as ClaudeConfig;
  const approvals = input.approvals === false ? undefined : new ClaudeApprovalStore();
  const toggles = new Map<string, boolean>();
  const autoPermissions: Pick<AutoPermissionService, "status" | "setEnabled"> = {
    status: vi.fn((directory: string) => ({ enabled: toggles.get(directory) ?? false, error: null })),
    setEnabled: vi.fn(async (directory: string, enabled: boolean) => { toggles.set(directory, enabled); return { enabled, error: null }; }),
  };
  const app = express();
  app.use(express.json());
  app.use("/api", claudeRoutes(
    config, new EventEmitter() as ClaudeSupervisor, store, new EventEmitter(),
    approvals ? { store: approvals, port: 1 } : undefined,
    input.autoPermissions === false ? undefined : autoPermissions,
  ));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}/api/claude/sessions/${session.id}`, session, approvals, autoPermissions, toggles };
}

describe("Claude session approval routes", () => {
  it("states the permission lane, the pending asks and the directory toggle on the session, without the raw tool input", async () => {
    const { base, session, approvals, toggles } = await setup();
    toggles.set("/tmp/project", true);
    const decision = approvals!.ask({ sessionId: session.id, toolName: "Write", toolUseId: "t1", input: { file_path: "/tmp/project/a.txt", content: "PRIVATE BODY" } });

    const response = await fetch(base);
    expect(response.status).toBe(200);
    const body = await response.json() as { session: Record<string, unknown> };
    expect(body.session).toMatchObject({ permissionLane: "gated", autoPermissions: { enabled: true, error: null } });
    expect(body.session.pendingApprovals).toEqual([expect.objectContaining({ toolName: "Write", detail: "/tmp/project/a.txt" })]);
    expect(JSON.stringify(body)).not.toContain("PRIVATE BODY");

    const listed = await (await fetch(`${base}/approvals`)).json() as { approvals: Array<{ id: string }> };
    expect(listed.approvals).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("PRIVATE BODY");

    const replied = await fetch(`${base}/approvals/${listed.approvals[0].id}/reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reply: "once" }) });
    expect(await replied.json()).toEqual({ replied: true });
    expect(await decision).toMatchObject({ behavior: "allow" });
    expect(((await (await fetch(base)).json()) as { session: { pendingApprovals: unknown[] } }).session.pendingApprovals).toEqual([]);
  });

  it("reports bypass when the gate is off and read-only for a read-only preset", async () => {
    const bypass = await setup({ approvals: false });
    expect(((await (await fetch(bypass.base)).json()) as { session: Record<string, unknown> }).session).toMatchObject({ permissionLane: "bypass", pendingApprovals: [] });
    const readOnly = await setup({ mode: "read-only" });
    expect(((await (await fetch(readOnly.base)).json()) as { session: Record<string, unknown> }).session).toMatchObject({ permissionLane: "read-only" });
    const unwired = await setup({ autoPermissions: false });
    expect(((await (await fetch(unwired.base)).json()) as { session: Record<string, unknown> }).session).not.toHaveProperty("autoPermissions");
  });

  it("reads and flips the PROJECT directory's toggle through the session, with a strict body", async () => {
    const { base, autoPermissions } = await setup();
    expect(await (await fetch(`${base}/auto-permissions`)).json()).toEqual({ enabled: false, error: null });
    const bad = await fetch(`${base}/auto-permissions`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: "yes" }) });
    expect(bad.status).toBe(400);
    const extra = await fetch(`${base}/auto-permissions`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true, directory: "/etc" }) });
    expect(extra.status).toBe(400);
    const flipped = await fetch(`${base}/auto-permissions`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) });
    expect(await flipped.json()).toEqual({ enabled: true, error: null });
    expect(autoPermissions.setEnabled).toHaveBeenCalledWith("/tmp/project", true);
    expect(await (await fetch(`${base}/auto-permissions`)).json()).toEqual({ enabled: true, error: null });
  });

  it("answers 503 for the toggle when the service is not wired, and 404 for an unknown session", async () => {
    const { base } = await setup({ autoPermissions: false });
    expect((await fetch(`${base}/auto-permissions`)).status).toBe(503);
    expect((await fetch(`${base.replace(/claude-[^/]+$/u, "claude-missing")}/auto-permissions`)).status).toBe(404);
  });
});
