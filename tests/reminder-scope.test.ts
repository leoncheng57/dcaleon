import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { parseReminderMarkdown } from "../server/reminders/reminders.js";
import { formatIdentity, parseGitHubRemote, resolveRepositoryIdentity } from "../server/reminders/repository-identity.js";

// Real repositories, because the identity check under test is a real git call.
const roots: string[] = [];
async function repository(remote?: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dca-scope-"));
  roots.push(directory);
  execFileSync("git", ["init", "-q", directory]);
  if (remote) execFileSync("git", ["-C", directory, "remote", "add", "origin", remote]);
  return directory;
}

afterAll(async () => {
  await Promise.all(roots.map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("parseGitHubRemote", () => {
  it("accepts the spellings git actually writes", () => {
    const expected = { owner: "leoncheng57", repo: "dcaleon" };
    for (const remote of [
      "https://github.com/leoncheng57/dcaleon.git",
      "https://github.com/leoncheng57/dcaleon",
      "git@github.com:leoncheng57/dcaleon.git",
      "ssh://git@github.com/leoncheng57/dcaleon.git",
      "https://github.com/leoncheng57/dcaleon/",
      "  https://github.com/leoncheng57/dcaleon.git  ",
    ]) {
      expect(parseGitHubRemote(remote), remote).toEqual(expected);
    }
  });

  it("refuses look-alikes rather than matching loosely", () => {
    for (const remote of [
      // A different host that embeds the right-looking path.
      "https://evil.test/leoncheng57/dcaleon.git",
      "git@evil.test:leoncheng57/dcaleon.git",
      // A subdomain is not github.com.
      "https://github.com.evil.test/leoncheng57/dcaleon",
      // Extra path segments must not be collapsed to owner/repo.
      "https://github.com/leoncheng57/dcaleon/tree/main",
      "https://github.com/leoncheng57",
      // Nonsense and empties.
      "",
      "   ",
      "not a url",
      "file:///etc/passwd",
    ]) {
      expect(parseGitHubRemote(remote), remote).toBeNull();
    }
  });

  it("compares case-insensitively once formatted", () => {
    const upper = parseGitHubRemote("https://github.com/LeonCheng57/Dcaleon.git");
    expect(upper).not.toBeNull();
    expect(formatIdentity(upper!)).toBe("leoncheng57/dcaleon");
  });
});

describe("resolveRepositoryIdentity", () => {
  it("reads the origin remote of a real repository", async () => {
    const directory = await repository("https://github.com/leoncheng57/dcaleon.git");
    const identity = await resolveRepositoryIdentity(directory);
    expect(identity && formatIdentity(identity)).toBe("leoncheng57/dcaleon");
  });

  it("returns null for a repository with no origin", async () => {
    expect(await resolveRepositoryIdentity(await repository())).toBeNull();
  });

  it("returns null for a directory that is not a repository", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dca-scope-plain-"));
    roots.push(directory);
    expect(await resolveRepositoryIdentity(directory)).toBeNull();
  });

  it("returns null for a non-GitHub origin", async () => {
    expect(await resolveRepositoryIdentity(await repository("https://gitlab.com/a/b.git"))).toBeNull();
  });

  it("treats a worktree as the same identity as its primary checkout", async () => {
    const primary = await repository("https://github.com/leoncheng57/dcaleon.git");
    execFileSync("git", ["-C", primary, "commit", "-q", "--allow-empty", "-m", "seed"], {
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    const linked = path.join(primary, "..", `${path.basename(primary)}-wt`);
    roots.push(linked);
    execFileSync("git", ["-C", primary, "worktree", "add", "-q", "-b", "feature/x", linked]);
    // The worktree directory name says nothing about the repository, which is
    // exactly why identity must come from git rather than the path.
    const identity = await resolveRepositoryIdentity(linked);
    expect(identity && formatIdentity(identity)).toBe("leoncheng57/dcaleon");
  });
});

describe("scope_repository frontmatter", () => {
  const preset = (scope: string) => parseReminderMarkdown("scoped", [
    "---", "name: scoped", "description: A scoped reminder.", `scope_repository: ${scope}`, "---", "", "Body.",
  ].join("\n"));

  it("parses and lowercases a valid owner/repo", () => {
    expect(preset("LeonCheng57/Dcaleon")?.scopeRepository).toBe("leoncheng57/dcaleon");
  });

  it("rejects the preset outright when the scope is malformed", () => {
    // Rejecting is the fail-closed outcome. Ignoring a bad scope would ship the
    // reminder as generally visible, which is the opposite of what it asked for.
    for (const scope of ["notarepo", "a/b/c", "/leading", "trailing/", "has space/repo", ""]) {
      expect(preset(scope), scope).toBeNull();
    }
  });

  it("leaves an unscoped preset generally visible", () => {
    const parsed = parseReminderMarkdown("general", [
      "---", "name: general", "description: A general reminder.", "---", "", "Body.",
    ].join("\n"));
    expect(parsed?.scopeRepository).toBeUndefined();
  });
});
