import { loadSimulationsFromFiles, type Simulation } from "./simulation.js";

/**
 * Worked examples for every shipped workflow and reminder.
 *
 * These are client-bundled markdown rather than part of `GET /api/workflows`.
 * A simulation is documentation ABOUT a guided action, not part of the trusted
 * contract the server resolves at submit time, so it stays out of the injector
 * payload. The cost is that a workflow added server-side ships without an
 * example — `tests/simulations.test.ts` turns that into a build failure rather
 * than a silent gap.
 *
 * Workflows and reminders are kept in separate directories because they can
 * share an id: `session-handoff` is both a workflow and a reminder, and a flat
 * directory would serve one's example for the other.
 *
 * This replaces the deleted `client/lib/playbooks.ts`, which globbed the
 * retired command catalogue. Only the re-keying trick survives from it:
 * `loadSimulationsFromFiles` keys by PARENT DIRECTORY name, so a flat
 * `<id>.md` file is re-keyed to `<id>/SIMULATION.md` before parsing. That keeps
 * the tested parser untouched.
 */
const workflowFiles = import.meta.glob("../simulations/workflows/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const reminderFiles = import.meta.glob("../simulations/reminders/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function keyByID(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([filePath, raw]) => {
    const id = filePath.split("/").pop()?.replace(/\.md$/u, "") ?? "";
    return [`${id}/SIMULATION.md`, raw];
  }));
}

export const workflowSimulations: Map<string, Simulation> = loadSimulationsFromFiles(keyByID(workflowFiles));
export const reminderSimulations: Map<string, Simulation> = loadSimulationsFromFiles(keyByID(reminderFiles));

export function workflowSimulation(id: string): Simulation | undefined {
  return workflowSimulations.get(id);
}

export function reminderSimulation(id: string): Simulation | undefined {
  return reminderSimulations.get(id);
}

const REPO_ROOT = "https://github.com/leoncheng57/dcaleon";

/**
 * The revision source links resolve against.
 *
 * Named rather than implied: the links follow the default branch, so what a
 * reader sees on GitHub can be newer than the bundle they are reading it from.
 * Stating `main` is honest; silently linking a moving target while looking
 * pinned is not.
 */
export const SIMULATION_SOURCE_REVISION = "main";

export const simulationSource = {
  workflow: (id: string) => `${REPO_ROOT}/blob/${SIMULATION_SOURCE_REVISION}/client/simulations/workflows/${id}.md`,
  reminder: (id: string) => `${REPO_ROOT}/blob/${SIMULATION_SOURCE_REVISION}/client/simulations/reminders/${id}.md`,
};

export const simulationPath = {
  workflow: (id: string) => `client/simulations/workflows/${id}.md`,
  reminder: (id: string) => `client/simulations/reminders/${id}.md`,
};

export type { Simulation };
