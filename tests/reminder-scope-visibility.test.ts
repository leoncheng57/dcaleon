import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { filterByScope, isInScope } from "../server/reminders/loader.js";
import { parseReminderMarkdown } from "../server/reminders/reminders.js";

const SCOPE = "leoncheng57/dcaleon";
const roots: string[] = [];

async function repository(remote?: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dca-scope-vis-"));
  roots.push(directory);
  execFileSync("git", ["init", "-q", directory]);
  if (remote) execFileSync("git", ["-C", directory, "remote", "add", "origin", remote]);
  return directory;
}

function preset(id: string, scope?: string) {
  const lines = ["---", `name: ${id}`, `description: The ${id} reminder.`];
  if (scope) lines.push(`scope_repository: ${scope}`);
  lines.push("---", "", `Body of ${id}.`);
  const parsed = parseReminderMarkdown(id, lines.join("\n"));
  if (!parsed) throw new Error(`fixture ${id} failed to parse`);
  return parsed;
}

let presets: ReturnType<typeof preset>[];
let matching: string;
let unrelated: string;
let noRemote: string;

beforeAll(async () => {
  presets = [preset("general"), preset("scoped", SCOPE)];
  matching = await repository(`https://github.com/${SCOPE}.git`);
  unrelated = await repository("https://github.com/someone-else/other-project.git");
  noRemote = await repository();
});

afterAll(async () => {
  await Promise.all(roots.map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("filterByScope", () => {
  it("lists a scoped reminder only in its own repository", async () => {
    const ids = (await filterByScope(presets, matching)).map((item) => item.id);
    expect(ids).toEqual(["general", "scoped"]);
  });

  it("hides a scoped reminder in an unrelated repository", async () => {
    const ids = (await filterByScope(presets, unrelated)).map((item) => item.id);
    expect(ids).toEqual(["general"]);
  });

  it("hides a scoped reminder when identity cannot be resolved", async () => {
    // No origin, and a directory that is not a repository at all. Both are
    // "unknown", and unknown must hide rather than fall back to visible.
    expect((await filterByScope(presets, noRemote)).map((item) => item.id)).toEqual(["general"]);
    const plain = await mkdtemp(path.join(os.tmpdir(), "dca-scope-plain-"));
    roots.push(plain);
    expect((await filterByScope(presets, plain)).map((item) => item.id)).toEqual(["general"]);
    expect((await filterByScope(presets, "")).map((item) => item.id)).toEqual(["general"]);
  });

  it("sees a linked worktree of the scoped repository as in scope", async () => {
    execFileSync("git", ["-C", matching, "commit", "-q", "--allow-empty", "-m", "seed"], {
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    const linked = path.join(matching, "..", `${path.basename(matching)}-wt`);
    roots.push(linked);
    execFileSync("git", ["-C", matching, "worktree", "add", "-q", "-b", "feature/scope", linked]);
    expect((await filterByScope(presets, linked)).map((item) => item.id)).toEqual(["general", "scoped"]);
  });
});

describe("isInScope (the injection path)", () => {
  it("resolves a scoped reminder inside its repository", async () => {
    expect(await isInScope(preset("scoped", SCOPE), matching)).toBe(true);
  });

  it("refuses a scoped reminder by id from another repository", async () => {
    // This is the leak that matters: filtering only the listing route would
    // hide the reminder from the picker while leaving its body injectable.
    const scoped = preset("scoped", SCOPE);
    expect(await isInScope(scoped, unrelated)).toBe(false);
    expect(await isInScope(scoped, noRemote)).toBe(false);
    expect(await isInScope(scoped, "")).toBe(false);
  });

  it("still resolves unscoped reminders anywhere", async () => {
    expect(await isInScope(preset("general"), unrelated)).toBe(true);
  });
});
