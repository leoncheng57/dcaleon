// tests/repo-hygiene.test.ts
//
// A tracked symlink is machine-specific by construction: a relative link is
// resolved against the directory it happens to sit in, so a link that points
// somewhere real in one checkout dangles — or worse, silently resolves to
// something else — in the next one.
//
// Issue #305 is the concrete case. PR #302 committed
// `node_modules -> ../../dcaleon/node_modules` (mode 120000), so
// every clone and every worktree cut from `main` materialised a link into one
// particular checkout's dependencies. Installing in any of them wrote through
// into the primary tree that the live launchd BFF service runs from. Nothing
// failed loudly; `.gitignore` already listed `node_modules/`, which does not
// apply to a path git is already tracking.
//
// The guard is a vitest test rather than a CI shell step because `npm test`
// already runs in both places — locally before a PR (CONTRIBUTING.md) and in
// CI's `check` job — so this adds no new CI surface. It reads the *index*
// (`git ls-files`), not history, so CI's shallow `fetch-depth: 1` checkout is
// fine.

import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Reject *every* tracked symlink, not only the ones that escape the repo.
 * "Does this relative link resolve inside the tree?" is a question with
 * surprising answers; "is anything tracked as mode 120000?" is not. There are
 * zero legitimate tracked symlinks here today, so nothing needs grandfathering.
 *
 * Deliberately empty: adding one should be a reviewed edit to this list with a
 * reason beside it, not an accident that CI waves through.
 */
const ALLOWED_SYMLINKS: readonly string[] = [];

/** Git's mode for a symlink blob, as printed by `git ls-files -s`. */
const SYMLINK_MODE = "120000";

/** Directories that must never be tracked at all, in any mode. */
const NEVER_TRACKED = ["node_modules"] as const;

interface TrackedEntry {
  /** Six-digit octal mode, e.g. `100644`, `100755`, `120000`, `160000`. */
  mode: string;
  /** Repo-relative path, POSIX separators, unquoted (`-z` disables quoting). */
  path: string;
}

/** The work tree containing this test file, or `undefined` outside a repo. */
function repositoryRoot(): string | undefined {
  try {
    return execFileSync("git", ["-C", path.resolve(__dirname, ".."), "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Every path in the index. `-s` prefixes `<mode> <sha> <stage>\t`, and `-z`
 * NUL-separates records so paths containing newlines or quotes survive intact.
 */
function trackedEntries(root: string): TrackedEntry[] {
  const output = execFileSync("git", ["-C", root, "ls-files", "-s", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return output
    .split("\0")
    .filter(Boolean)
    .map((record) => ({
      mode: record.slice(0, 6),
      path: record.slice(record.indexOf("\t") + 1),
    }));
}

const root = repositoryRoot();

describe.skipIf(root === undefined)("repository hygiene", () => {
  it("tracks no symlinks", () => {
    const symlinks = trackedEntries(root as string)
      .filter((entry) => entry.mode === SYMLINK_MODE)
      .map((entry) => entry.path)
      .filter((tracked) => !ALLOWED_SYMLINKS.includes(tracked));

    expect(
      symlinks,
      symlinks.length === 0
        ? ""
        : `Tracked symlink(s) found: ${symlinks.join(", ")}. A committed symlink resolves ` +
          `differently in every clone and worktree (see issue #305). Untrack with ` +
          `\`git rm --cached -- ${symlinks.join(" ")}\`, or, if the link is genuinely ` +
          `portable, add it to ALLOWED_SYMLINKS in tests/repo-hygiene.test.ts with a reason.`,
    ).toEqual([]);
  });

  it("tracks nothing inside node_modules", () => {
    // Assertion 1 only sees mode 120000, so it would miss `node_modules`
    // committed as ordinary files (mode 100644) — a different accident with the
    // same consequence: a dependency tree in version control.
    const entries = trackedEntries(root as string)
      .map((entry) => entry.path)
      .filter((tracked) =>
        NEVER_TRACKED.some(
          (name) => tracked === name || tracked.startsWith(`${name}/`) || tracked.includes(`/${name}/`),
        ),
      );

    expect(
      entries,
      entries.length === 0
        ? ""
        : `Tracked path(s) under a dependency directory: ${entries.slice(0, 10).join(", ")}` +
          `${entries.length > 10 ? ` (+${entries.length - 10} more)` : ""}. ` +
          `\`.gitignore\` does not apply to already-tracked paths; untrack with ` +
          `\`git rm --cached -r -- ${NEVER_TRACKED.join(" ")}\`.`,
    ).toEqual([]);
  });
});
