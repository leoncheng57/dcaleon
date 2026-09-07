// tests/e2e-state-files.test.ts
//
// Issue #80: three of the four BFF state files Playwright hands the server were
// fixed paths in /tmp, shared by every run on the machine, and nothing ever
// deleted them. Two runs — successive locally, or concurrent in sibling
// worktrees — therefore read and wrote each other's notification history,
// notification preferences and project pins.
//
// The fix is per-run paths plus a startup cleanup, so the two things worth
// pinning down mechanically are: the paths really are unique per run, and the
// cleanup really cannot reach a file it was not given. The second matters more
// than it looks — a glob over `/tmp/dcaleon-e2e-*` would delete a
// sibling worktree's live state, turning an isolation fix into a worse bug.
//
// This file deliberately does NOT import playwright.config.ts. Importing it
// executes its startup cleanup with the importing process's pid and the DEFAULT
// port lane, which could delete a concurrent run's files. The config is checked
// by reading its source instead, the same way
// tests/e2e-shared-state-ownership.test.ts checks the spec files.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  E2E_STATE_PREFIX,
  assertOwnedStateFile,
  e2eStateFiles,
  isOwnedStateFile,
  laneMarkerFile,
  prepareE2EStateFiles,
  removeOwnedStateFiles,
} from "./e2e/state-files.js";

const CONFIG = path.resolve(__dirname, "..", "playwright.config.ts");
const STATE_ENV_VARS = [
  "PROJECT_PINS_FILE",
  "MODEL_PINS_FILE",
  "NOTIFICATION_PREFS_FILE",
  "NOTIFICATION_HISTORY_FILE",
  "INSTRUCTION_AUDIT_FILE",
  "AUTO_APPROVE_STATE_FILE",
] as const;

/**
 * Every path this file creates for real. Tests use ids that no Playwright run
 * can produce — a pid is digits, these are not — so a concurrent suite on this
 * machine cannot collide with them.
 */
const created = new Set<string>();

function own(file: string): string {
  created.add(file);
  return file;
}

afterEach(() => {
  for (const file of created) rmSync(file, { recursive: true, force: true });
  created.clear();
});

describe("e2e state file paths", () => {
  it("scopes every BFF state file to the run", () => {
    const files = e2eStateFiles("run-a");
    expect(Object.keys(files).sort()).toEqual([...STATE_ENV_VARS].sort());
    for (const [name, file] of Object.entries(files)) {
      expect(file, `${name} must live under the e2e prefix`).toMatch(
        new RegExp(`^${E2E_STATE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );
      expect(file, `${name} must carry the run id`).toContain("run-a");
      expect(file).toMatch(/\.json$/);
    }
    // Distinct stores, distinct files.
    expect(new Set(Object.values(files)).size).toBe(STATE_ENV_VARS.length);
  });

  it("gives two runs completely disjoint file sets", () => {
    const first = Object.values(e2eStateFiles("run-a"));
    const second = Object.values(e2eStateFiles(1234));
    expect(first.filter((file) => second.includes(file))).toEqual([]);
    // A prefix relationship would still be two different files, but it makes
    // ad-hoc `rm` and log-reading ambiguous, so require the ids to differ where
    // the id actually sits.
    expect(new Set([...first, ...second]).size).toBe(STATE_ENV_VARS.length * 2);
  });

  it("is deterministic for the same run id", () => {
    expect(e2eStateFiles("run-a")).toEqual(e2eStateFiles("run-a"));
  });

  it("rejects a run id that could smuggle path syntax into a filename", () => {
    for (const bad of ["../escape", "a/b", "", "run id", "run.id", "*"]) {
      expect(() => e2eStateFiles(bad), JSON.stringify(bad)).toThrow(/run id/);
    }
  });
});

describe("e2e state file cleanup", () => {
  it("refuses to delete a path it was not given", () => {
    const outsiders = [
      "/tmp/some-other-tool.json",
      "/tmp/dcaleon-e2e-worktrees", // the worktree ROOT is a directory and is not ours to remove
      "/tmp/dcaleon-e2e-worktrees/project/state.json", // nested, so not "directly under" the prefix
      "/tmp/dcaleon-e2e-*.json", // a glob is never a path
      "/tmp/dcaleon-e2e-../../etc/passwd",
      `${E2E_STATE_PREFIX}notification-history.json.bak`,
      `${E2E_STATE_PREFIX}`,
      "dcaleon-e2e-relative.json",
      "",
      42,
      null,
      undefined,
    ];
    for (const outsider of outsiders) {
      expect(isOwnedStateFile(outsider), JSON.stringify(outsider)).toBe(false);
      expect(() => assertOwnedStateFile(outsider), JSON.stringify(outsider)).toThrow(/refusing to delete/);
      expect(() => removeOwnedStateFiles([outsider]), JSON.stringify(outsider)).toThrow(/refusing to delete/);
    }
  });

  it("validates the whole list before deleting any of it", () => {
    const keep = own(`${E2E_STATE_PREFIX}unit-keep-a.json`);
    writeFileSync(keep, "{}");
    expect(() => removeOwnedStateFiles([keep, "/tmp/not-ours.json"])).toThrow(/refusing to delete/);
    // A half-applied cleanup is worse than none: the caller would believe the
    // survivors are intact.
    expect(existsSync(keep)).toBe(true);
  });

  it("removes exactly the files it is handed and tolerates missing ones", () => {
    const target = own(`${E2E_STATE_PREFIX}unit-target-a.json`);
    const bystander = own(`${E2E_STATE_PREFIX}unit-bystander-a.json`);
    const absent = own(`${E2E_STATE_PREFIX}unit-absent-a.json`);
    writeFileSync(target, "{}");
    writeFileSync(bystander, "{}");

    expect(removeOwnedStateFiles([target, absent])).toEqual([target]);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(bystander), "a sibling run's file must survive").toBe(true);
  });
});

describe("e2e run preparation", () => {
  it("starts the run from an empty set and records what it owns", () => {
    const lane = "unit-lane-a";
    own(laneMarkerFile(lane));
    const files = e2eStateFiles("unit-run-a");
    for (const file of Object.values(files)) {
      own(file);
      writeFileSync(file, '{"stale":true}');
    }

    expect(prepareE2EStateFiles({ lane, runID: "unit-run-a" })).toEqual(files);
    for (const file of Object.values(files)) expect(existsSync(file), file).toBe(false);

    const marker: unknown = JSON.parse(readFileSync(laneMarkerFile(lane), "utf8"));
    expect((marker as { files: string[] }).files.sort()).toEqual(Object.values(files).sort());
  });

  it("clears the previous run on the same lane, and nothing else", () => {
    const lane = "unit-lane-b";
    own(laneMarkerFile(lane));
    const first = prepareE2EStateFiles({ lane, runID: "unit-run-b1" });
    for (const file of Object.values(first)) {
      own(file);
      writeFileSync(file, '{"first":true}');
    }
    // A concurrent run on a DIFFERENT lane. Its files must be untouched.
    const otherLane = own(laneMarkerFile("unit-lane-c"));
    writeFileSync(otherLane, JSON.stringify({ files: Object.values(e2eStateFiles("unit-run-c")) }));
    const sibling = own(e2eStateFiles("unit-run-c").NOTIFICATION_HISTORY_FILE);
    writeFileSync(sibling, '{"sibling":true}');

    const second = prepareE2EStateFiles({ lane, runID: "unit-run-b2" });
    for (const file of Object.values(second)) own(file);

    for (const file of Object.values(first)) expect(existsSync(file), file).toBe(false);
    expect(existsSync(sibling), "another lane's live state must survive").toBe(true);
    expect(existsSync(otherLane), "another lane's marker must survive").toBe(true);
  });

  it("ignores a corrupt or hostile lane marker instead of acting on it", () => {
    const lane = "unit-lane-d";
    const marker = own(laneMarkerFile(lane));
    const outside = path.join(own(mkdtempSync(path.join(tmpdir(), "e2e-state-files-"))), "victim.json");
    writeFileSync(outside, "{}");
    writeFileSync(marker, JSON.stringify({ files: [outside, "/etc/passwd", 7] }));

    for (const file of Object.values(prepareE2EStateFiles({ lane, runID: "unit-run-d" }))) own(file);
    expect(existsSync(outside), "a marker may not name a file outside the e2e prefix").toBe(true);
    rmSync(path.dirname(outside), { recursive: true, force: true });
  });

  it("survives a marker that is not JSON at all", () => {
    const lane = "unit-lane-e";
    writeFileSync(own(laneMarkerFile(lane)), "half-written");
    for (const file of Object.values(prepareE2EStateFiles({ lane, runID: "unit-run-e" }))) own(file);
    expect(existsSync(laneMarkerFile(lane))).toBe(true);
  });

  it("rejects a lane that could smuggle path syntax into the marker name", () => {
    for (const bad of ["../escape", "a/b", ""]) {
      expect(() => laneMarkerFile(bad), JSON.stringify(bad)).toThrow(/lane/);
    }
  });
});

describe("playwright config wiring", () => {
  const source = readFileSync(CONFIG, "utf8");

  it("names every state file through the run-scoped helper", () => {
    for (const name of STATE_ENV_VARS) {
      expect(source, `${name} must be taken from the per-run helper`).toMatch(
        new RegExp(`\\n\\s*${name}: stateFiles\\.${name},`),
      );
    }
  });

  it("keeps no fixed e2e state path that two runs could share", () => {
    // The worktree ROOT is deliberately still a constant directory (it is not
    // BFF state and does not accumulate across runs), so only `.json` state
    // files are forbidden here.
    expect(source.match(/\/tmp\/dcaleon-e2e-[^"`\s]*\.json/g) ?? []).toEqual([]);
  });

  it("only mutates the filesystem in the runner, not in re-imported workers", () => {
    // Playwright re-imports the config in every worker process; a worker has its
    // own pid, so an unguarded cleanup there would delete the live run's files.
    expect(source).toContain("process.env.TEST_WORKER_INDEX === undefined");
  });
});
