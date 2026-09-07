import { expect, type Page } from "@playwright/test";
import express from "express";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeRoutes } from "../../server/routes/claude.js";
import { ClaudeSessionStore, type ClaudeTranscriptEvent } from "../../server/claude/store.js";
import { readClaudeConfig } from "../../server/claude/config.js";
import type { ClaudeSupervisor } from "../../server/claude/supervisor.js";

export const prose = (i: number): ClaudeTranscriptEvent => ({ id: `row-${i}`, messageId: `message-${i}`, timestamp: "2026-09-07T12:00:00Z", kind: "agent", text: `Activity ${i}\n\n${"Realistic **Markdown** with lists and inline code: `example.ts`. ".repeat(12)}` });
const mixed = (): ClaudeTranscriptEvent[] => Array.from({ length: 260 }, (_, i) => {
  if (i % 10 === 0) return { ...prose(i), kind: "user", text: `Please investigate step ${i}`, reminders: [], workflows: [], attachments: [] };
  if (i % 10 === 1) return { ...prose(i), kind: "thought", text: `Inspecting the implementation for step ${i}.` };
  if (i % 10 === 2) return { ...prose(i), kind: "tool", name: "Bash", status: "completed", detail: `Historical command ${i}`, commandText: `echo historical-${i}`, output: "ok\n".repeat(20), attachments: [] };
  if (i % 10 === 3) return { ...prose(i), kind: "patch", files: ["src/old.ts"], fileCount: 1, filesTruncated: false };
  if (i % 10 === 4) return { ...prose(i), kind: "status", label: "Recovered after a server restart" };
  return prose(i);
});

// Each test owns a real BFF/store and workspace, including SSE. No shared resets.
export async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "claude-performance-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/old.ts"), "export const historical = true;\n");
  const store = new ClaudeSessionStore(path.join(root, "ledger.json"));
  await store.load();
  const config = { ...readClaudeConfig({}), enabled: true, configured: true, errors: [] };
  const app = express();
  app.use((_req, res, next) => { res.set("Access-Control-Allow-Origin", "*"); next(); });
  app.use(express.json());
  app.use("/api", claudeRoutes(config, new EventEmitter() as ClaudeSupervisor, store));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin, store,
    create(running = false) {
      const session = store.create({ presetId: "e2e-readonly", workspaceId: "e2e", workspaceLabel: "Performance fixture", mode: "read-only", isolation: "direct", directory: root, projectDirectory: root, title: "Long conversation" });
      session.events = mixed();
      session.events[5] = { ...prose(5), text: "Ancient reference `src/old.ts:1`" };
      session.running = running;
      return session;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.flush();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function open(page: Page, server: Awaited<ReturnType<typeof fixture>>, id: string) {
  const payloads: Array<{ bytes: number; count: number; delta: boolean }> = [];
  await page.addInitScript(({ origin }) => {
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL, init?: EventSourceInit) { super(String(url).includes("/api/claude/events") ? origin + String(url) : url, init); }
    };
    Object.assign(window, { longTasks: [] });
    new PerformanceObserver((list) => { (window as any).longTasks.push(...list.getEntries().map((entry) => entry.duration)); }).observe({ type: "longtask", buffered: true });
  }, { origin: server.origin });
  await page.route(new RegExp(`/api/claude/sessions/${id}(?:[/?]|$)`), async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: server.origin + url.pathname + url.search });
    if (url.pathname.endsWith(id)) {
      const body = await response.body();
      const parsed = JSON.parse(body.toString());
      payloads.push({ bytes: body.length, count: parsed.events?.length ?? 0, delta: parsed.page?.delta });
    }
    await route.fulfill({ response });
  });
  await page.goto(`/claude/sessions/${id}`);
  await expect(page.getByTestId("claude-history-controls")).toHaveAttribute("data-resident-events", "50");
  await expect(page.locator('[data-transcript-item="row-259"]')).toBeInViewport();
  return payloads;
}

export async function metrics(page: Page) {
  return page.evaluate(() => {
    const element = document.querySelector<HTMLElement>('[data-testid="claude-history-controls"]')!;
    return { resident: Number(element.dataset.residentEvents), pages: Number(element.dataset.residentPages), reconcileMs: Number(element.dataset.reconcileMs), rows: document.querySelectorAll("[data-transcript-item]").length, commits: Number(document.querySelector<HTMLElement>('[data-testid="claude-virtual-transcript"]')?.dataset.renderCommits), longTasks: (window as any).longTasks as number[] };
  });
}
