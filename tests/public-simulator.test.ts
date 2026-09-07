import { describe, expect, it } from "vitest";

import type { DshTrajectoryPage, PlanningSnapshot } from "../client/lib/api.js";
import { createPublicSimulator } from "../client/simulator/publicSimulator.js";
import { workflowCatalogue } from "../server/workflows/workflows.js";

describe("public simulator workflow fixtures", () => {
  // The fixture is the whole catalogue in catalogue order, because the preview
  // has no BFF to ask: a short fixture would show a Playbooks page that quietly
  // disagrees with the real one.
  it("mirrors the current workflow ids, in catalogue order", async () => {
    const response = await createPublicSimulator()("https://preview.invalid/api/workflows");
    const payload = await response.json() as { workflows: Array<{ id: string; injector: string; argument?: { label: string; required: boolean; maxLength: number }; prompt?: string }> };
    expect(payload.workflows.map(({ id }) => id)).toEqual(workflowCatalogue().map(({ id }) => id));
    expect(payload.workflows.every(({ injector }) => injector.length > 0)).toBe(true);
    // The fixture injectors are deliberately short summaries, but the field a
    // workflow collects is part of its shape and must match the real server.
    for (const real of workflowCatalogue()) {
      const fixture = payload.workflows.find(({ id }) => id === real.id)!;
      expect(fixture.title, real.id).toBe(real.title);
      expect(fixture.description, real.id).toBe(real.description);
      expect(fixture.argument, real.id).toEqual(real.argument);
      expect(fixture.prompt, real.id).toEqual(real.prompt);
    }
  });
});

describe("public simulator planning fixtures", () => {
  it("exposes a complete deterministic epic hierarchy", async () => {
    const response = await createPublicSimulator()("https://preview.invalid/api/planning/items");
    const snapshot = await response.json() as PlanningSnapshot;

    expect(snapshot.epicsTruncated).toBe(false);
    expect(snapshot.items.every((item) => Number.isInteger(item.childCount)
      && Number.isInteger(item.completedChildCount)
      && (item.parentNumber === null || Number.isInteger(item.parentNumber)))).toBe(true);
    expect(snapshot.items.find((item) => item.number === 153)).toMatchObject({ childCount: 2, completedChildCount: 1 });
    expect(snapshot.items.filter((item) => item.parentNumber === 153).map((item) => item.number)).toEqual([112, 109]);
  });
});

describe("public simulator DSH fixtures", () => {
  it("keeps DSH configuration and transcript mutations browser-local", async () => {
    const simulator = createPublicSimulator();
    const config = await (await simulator("https://preview.invalid/api/dsh/config")).json() as { presets: Array<{ id: string; mode: string }> };
    expect(config.presets[0]).toMatchObject({ id: "dsh-preview-preset", mode: "read-only" });
    expect(config.presets.length).toBeGreaterThanOrEqual(1);

    const created = await (await simulator("https://preview.invalid/api/dsh/sessions", {
      method: "POST",
      body: JSON.stringify({ presetId: "dsh-preview-preset", workspaceId: "dsh-preview-workspace" }),
    })).json() as { session: { id: string } };
    await simulator(`https://preview.invalid/api/dsh/sessions/${created.session.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "Inspect the fixture" }),
    });
    const transcript = await (await simulator(`https://preview.invalid/api/dsh/sessions/${created.session.id}`)).json() as { events: Array<{ kind: string; text?: string }> };
    expect(transcript.events).toContainEqual(expect.objectContaining({ kind: "agent", text: expect.stringContaining("No DSH runtime") }));
    const trajectory = await (await simulator(`https://preview.invalid/api/dsh/sessions/${created.session.id}/trajectory`)).json() as DshTrajectoryPage;
    expect(trajectory.coverage).toMatchObject({ source: "dca-captured-projection", complete: false, mayContainGaps: true });
    expect(trajectory.events).toContainEqual(expect.objectContaining({ type: "tool/call", metadata: expect.objectContaining({ callId: "id:callpreview" }) }));
    expect(JSON.stringify(trajectory)).not.toContain("PRIVATE");
    const detail = await simulator(`https://preview.invalid/api/dsh/sessions/${created.session.id}/trajectory/${created.session.id}%3A3/detail`, { method: "POST" });
    expect(detail.status).toBe(403);

    const freshSimulator = createPublicSimulator();
    const freshSessions = await (await freshSimulator("https://preview.invalid/api/dsh/sessions")).json() as { sessions: Array<{ id: string }> };
    expect(freshSessions.sessions.some((session) => session.id === created.session.id)).toBe(false);
  });
});
