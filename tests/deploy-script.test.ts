import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/deploy.sh");
const roots: string[] = [];

interface Run {
  status: number;
  output: string;
}

function git(directory: string, args: string[]): void {
  execFileSync("git", ["-C", directory, ...args], { stdio: "ignore" });
}

function gitOut(directory: string, args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
}

/**
 * A throwaway repository containing only the script under test. The script
 * resolves its own repository root from its location, so a copy under
 * <fixture>/scripts/ operates entirely inside the fixture.
 */
function fixture(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "dca-deploy-script-"));
  roots.push(directory);
  mkdirSync(path.join(directory, "scripts"));
  // Present but empty: the script installs dependencies when node_modules is
  // absent, and these tests must never reach a real `npm ci`.
  mkdirSync(path.join(directory, "node_modules"));
  copyFileSync(scriptSource, path.join(directory, "scripts", "deploy.sh"));
  writeFileSync(path.join(directory, "package.json"), '{ "name": "fixture" }\n');
  writeFileSync(path.join(directory, "package-lock.json"), '{ "name": "fixture" }\n');

  git(directory, ["init", "--initial-branch=main"]);
  git(directory, ["config", "user.email", "fixture@example.com"]);
  git(directory, ["config", "user.name", "Fixture"]);
  git(directory, ["add", "scripts/deploy.sh", "package.json", "package-lock.json"]);
  git(directory, ["commit", "-m", "fixture baseline"]);
  return directory;
}

function run(directory: string, args: string[]): Run {
  try {
    const output = execFileSync("bash", [path.join(directory, "scripts", "deploy.sh"), ...args], {
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, DCA_DEPLOY_PREFLIGHT_ONLY: "1" },
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("supervised deploy script", () => {
  it("passes preflight on a clean checkout and skips an unnecessary install", () => {
    const directory = fixture();

    const result = run(directory, ["--skip-fetch", "--ref=HEAD"]);

    expect(result.status).toBe(0);
    expect(result.output).toContain("clean");
    expect(result.output).toContain("will skip 'npm ci'");
    expect(result.output).toContain("preflight only");
  });

  it("changes nothing before the preflight gate", () => {
    const directory = fixture();
    // A second commit gives the gate a real checkout to perform, so a gate
    // placed too late would be caught by the HEAD assertion below.
    writeFileSync(path.join(directory, "README.md"), "# later\n");
    git(directory, ["add", "README.md"]);
    git(directory, ["commit", "-m", "second commit"]);
    const head = gitOut(directory, ["rev-parse", "HEAD"]);
    git(directory, ["checkout", "--detach", "HEAD~1"]);
    const detached = gitOut(directory, ["rev-parse", "HEAD"]);
    expect(detached).not.toBe(head);

    const result = run(directory, ["--skip-fetch", "--ref=main"]);

    expect(result.status).toBe(0);
    expect(result.output).toContain("preflight only");
    // The gate must precede the checkout: this is the flaw the gate exists to
    // avoid, and a "preflight" that moves HEAD or reinstalls dependencies is
    // not a preflight.
    expect(gitOut(directory, ["rev-parse", "HEAD"])).toBe(detached);
  });

  it("refuses to deploy a checkout with uncommitted changes", () => {
    const directory = fixture();
    writeFileSync(path.join(directory, "package.json"), '{ "name": "edited" }\n');

    const result = run(directory, ["--skip-fetch", "--ref=HEAD"]);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("refusing to deploy");
    expect(result.output).toContain("package.json");
    // The stash stack is shared across worktrees, so the guidance must not
    // suggest stashing.
    expect(result.output).toContain("Do not stash it");
  });

  it("explains that the target branch is held by another worktree instead of failing on it", () => {
    const directory = fixture();
    const secondary = path.join(directory, "..", `${path.basename(directory)}-secondary`);
    roots.push(secondary);
    // Reproduces the runbook failure: `main` lives in a different worktree, so
    // `git switch main` here would abort. The script detaches instead.
    git(directory, ["checkout", "--detach", "HEAD"]);
    git(directory, ["worktree", "add", secondary, "main"]);

    const result = run(directory, ["--skip-fetch", "--ref=main"]);

    expect(result.status).toBe(0);
    expect(result.output).toContain("checked out in another worktree");
    expect(result.output).toContain("detached");
  });

  it("rejects an unresolvable ref", () => {
    const directory = fixture();

    const result = run(directory, ["--skip-fetch", "--ref=origin/does-not-exist"]);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("cannot resolve ref");
  });

  it("rejects the development port and malformed ports before building", () => {
    const directory = fixture();

    const development = run(directory, ["--skip-fetch", "--ref=HEAD", "--port=3000"]);
    expect(development.status).not.toBe(0);
    expect(development.output).toContain("conflicts with the development default");

    const malformed = run(directory, ["--skip-fetch", "--ref=HEAD", "--port=not-a-port"]);
    expect(malformed.status).not.toBe(0);
    expect(malformed.output).toContain("invalid supervised port");

    const outOfRange = run(directory, ["--skip-fetch", "--ref=HEAD", "--port=70000"]);
    expect(outOfRange.status).not.toBe(0);
    expect(outOfRange.output).toContain("invalid supervised port");
  });

  it("rejects an unknown option", () => {
    const directory = fixture();

    const result = run(directory, ["--nope"]);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("unknown option");
  });

  it("prints usage without touching the repository", () => {
    const directory = fixture();

    const result = run(directory, ["--help"]);

    expect(result.status).toBe(0);
    expect(result.output).toContain("Usage: scripts/deploy.sh");
    expect(result.output).toContain("--force-active-claude");
  });
});
