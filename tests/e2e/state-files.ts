// tests/e2e/state-files.ts
//
// The BFF persists notification preferences, notification history, project pins,
// model pins and the instruction audit to JSON files whose paths come from
// environment variables (server/notifications/preferences.ts,
// server/notifications/history.ts, server/projects.ts, server/modelPins.ts,
// server/opencode/instruction-audit.ts). Playwright points all five at /tmp so a
// run never touches the developer's real `.state/` directory — but three of them
// used to be FIXED strings shared by every run on the machine, while
// MODEL_PINS_FILE and INSTRUCTION_AUDIT_FILE were scoped per run. That asymmetry
// was issue #80.
//
// It cost real time. Nothing ever deleted the shared files, so history grew
// across runs (934 records / 519KB in a day of local runs, with the suite
// drifting from ~33s to ~57s and back to ~42s after a manual delete), and
// `smoke.ui.spec.ts`'s notification badge test — which reads a live unresolved
// count off the bell's aria-label — was asserting against state written by an
// unrelated run, including a concurrent one in a sibling worktree.
//
// So every run gets its own file set and starts from an empty one.
//
// Deletion here is deliberately narrow. A sibling worktree may be mid-run in the
// same /tmp right now, so this module never globs `/tmp/dcaleon-e2e-*`:
// it only unlinks paths it was handed, and it refuses anything that is not a
// plain `.json` file sitting directly under the e2e prefix. That is the same
// principle the mock's `/test/*/reset` endpoints already follow — a reset may
// only clear what its caller named.

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

/** Every e2e state file lives directly under this prefix, and nothing else may be removed. */
export const E2E_STATE_PREFIX = "/tmp/dcaleon-e2e-";

/** A plain `<name>.json` directly under the prefix: no `/`, no `..`, no globs, no whitespace. */
const OWNED_FILE = /^[A-Za-z0-9._-]+\.json$/;

/** Run and lane ids are interpolated into a filename, so they may not smuggle path syntax. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** The BFF state files an e2e run owns, keyed by the env var that names each one. */
export interface E2EStateFiles {
  PROJECT_PINS_FILE: string;
  MODEL_PINS_FILE: string;
  NOTIFICATION_PREFS_FILE: string;
  NOTIFICATION_HISTORY_FILE: string;
  INSTRUCTION_AUDIT_FILE: string;
  AUTO_APPROVE_STATE_FILE: string;
}

function safeID(value: string | number, what: string): string {
  const id = String(value);
  if (!SAFE_ID.test(id)) {
    throw new Error(`e2e ${what} must match ${String(SAFE_ID)} — received ${JSON.stringify(value)}`);
  }
  return id;
}

/**
 * Paths for one run. Pure: it computes names and touches no disk, so a caller
 * that only wants to know where the state lives cannot accidentally delete it.
 */
export function e2eStateFiles(runID: string | number): E2EStateFiles {
  const id = safeID(runID, "run id");
  return {
    PROJECT_PINS_FILE: `${E2E_STATE_PREFIX}project-pins-${id}.json`,
    MODEL_PINS_FILE: `${E2E_STATE_PREFIX}model-pins-${id}.json`,
    NOTIFICATION_PREFS_FILE: `${E2E_STATE_PREFIX}notifications-${id}.json`,
    NOTIFICATION_HISTORY_FILE: `${E2E_STATE_PREFIX}notification-history-${id}.json`,
    INSTRUCTION_AUDIT_FILE: `${E2E_STATE_PREFIX}instruction-audit-${id}.json`,
    // Persisted auto-approve flags must start empty per run for the same
    // reason notification history does: specs toggle auto permissions, and a
    // flag surviving into the next run would flip that run's ask-mode
    // assertions before it made a single request.
    AUTO_APPROVE_STATE_FILE: `${E2E_STATE_PREFIX}auto-approve-${id}.json`,
  };
}

/** True when `candidate` is a path this module is allowed to unlink. */
export function isOwnedStateFile(candidate: unknown): candidate is string {
  return (
    typeof candidate === "string" &&
    candidate.startsWith(E2E_STATE_PREFIX) &&
    OWNED_FILE.test(candidate.slice(E2E_STATE_PREFIX.length))
  );
}

/** Throws unless `candidate` is a path this module is allowed to unlink. */
export function assertOwnedStateFile(candidate: unknown): string {
  if (!isOwnedStateFile(candidate)) {
    throw new Error(
      `refusing to delete ${JSON.stringify(candidate)}: e2e cleanup may only remove a plain .json file directly under ${E2E_STATE_PREFIX}`,
    );
  }
  return candidate;
}

/**
 * Unlink exactly the given paths. Every path is validated BEFORE anything is
 * deleted, so a bad entry cannot leave a half-applied cleanup behind. A missing
 * file is the expected case on a first run, not an error.
 */
export function removeOwnedStateFiles(paths: readonly unknown[]): string[] {
  const files = paths.map(assertOwnedStateFile);
  const removed: string[] = [];
  for (const file of files) {
    try {
      unlinkSync(file);
      removed.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return removed;
}

/** Where the run holding a given BFF port records the files it created. */
export function laneMarkerFile(lane: string | number): string {
  return assertOwnedStateFile(`${E2E_STATE_PREFIX}run-lane-${safeID(lane, "lane")}.json`);
}

/** Paths the previous run on this lane recorded as its own. Unreadable or corrupt marker: none. */
function previousLaneFiles(marker: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(marker, "utf8"));
    const files = (parsed as { files?: unknown })?.files;
    // A marker is machine-written, but it is also a file on a shared /tmp, so an
    // entry that is not obviously ours is skipped rather than trusted.
    return Array.isArray(files) ? files.filter(isOwnedStateFile) : [];
  } catch {
    return [];
  }
}

/**
 * Give this run an empty, run-unique set of state files and record them.
 *
 * `lane` is the BFF port. Only one run can hold a port at a time, so the marker
 * for that port names the previous holder's files: removing those, by name,
 * keeps /tmp from gaining a fresh orphan set on every run, and it is also the
 * only cleanup that reaches a BFF Playwright decided to REUSE
 * (`reuseExistingServer`), which is still writing the previous run's paths.
 *
 * It cannot clear a reused server's in-memory notification history —
 * `HistoryStore` loads once and caches (server/notifications/history.ts) — so a
 * reused BFF is deterministic for preferences and project pins (both re-read
 * from disk on every call) but not for history. Passing CI=1 forces a fresh
 * server and makes all three deterministic; that is what the e2e protocol does.
 */
export function prepareE2EStateFiles(options: { lane: string | number; runID: string | number }): E2EStateFiles {
  const marker = laneMarkerFile(options.lane);
  const files = e2eStateFiles(options.runID);
  const mine = Object.values(files);

  removeOwnedStateFiles(previousLaneFiles(marker).filter((file) => !mine.includes(file)));
  removeOwnedStateFiles(mine);
  writeFileSync(
    marker,
    `${JSON.stringify({ lane: String(options.lane), runID: String(options.runID), files: mine }, null, 2)}\n`,
  );
  return files;
}
