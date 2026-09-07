import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ARTIFACT_LIMITS,
  EXIT_DOCKER_UNAVAILABLE,
  RESOURCE_PREFIX,
  assertImageRef,
  assertRunID,
  classifyDockerProbe,
  containerName,
  createRunID,
  dockerCreateArgs,
  exportArtifacts,
  imageTag,
  parseArgs,
  readRuntimeUID,
  resolveArtifactRoot,
  unavailableMessage,
} from "../scripts/e2e-docker.js";

// Unit coverage for the host side of the isolated E2E lane (issue #204).
//
// The launcher is the only part of that lane that runs with the developer's own
// privileges: everything else is inside a container with no network, no mounts
// and dropped capabilities. So the properties worth pinning down here are the
// ones that decide what the host does — which resources get created, which get
// deleted, which arguments reach the test runner unchanged, and what is allowed
// to come back out of the container.
//
// These are pure-function tests on purpose. They assert the launcher's decisions
// as data, without a Docker daemon, so they run in the ordinary `npm test` tier
// and a regression is caught before anyone waits on an image build.

const roots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "e2e-docker-launcher-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  // Only paths this file created, by name. Never a glob.
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("run identity", () => {
  it("derives a sortable id from the clock plus entropy", () => {
    const id = createRunID(new Date("2026-08-26T02:30:15.123Z"), "abc12345");
    expect(id).toBe("20260826t023015z-abc12345");
  });

  it("orders ids by time so stray containers are readable at a glance", () => {
    const earlier = createRunID(new Date("2026-08-26T02:00:00.000Z"), "aaaaaaaa");
    const later = createRunID(new Date("2026-08-26T03:00:00.000Z"), "aaaaaaaa");
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });

  it("generates distinct ids for concurrent runs", () => {
    // Two agents starting in the same second must not choose one container name;
    // the whole point of the lane is that their fixtures stay separate.
    const ids = new Set(Array.from({ length: 500 }, () => createRunID()));
    expect(ids.size).toBe(500);
  });

  it("generates ids that satisfy its own validator", () => {
    for (let index = 0; index < 200; index += 1) {
      expect(() => assertRunID(createRunID())).not.toThrow();
    }
  });

  // A run id is interpolated into a container name, an image tag AND a
  // filesystem path. Anything that can carry path or shell syntax through those
  // three uses is the bug that turns a cleanup into a host deletion.
  it.each([
    ["path traversal", "../../etc"],
    ["absolute path", "/etc/passwd"],
    ["separator", "run/id"],
    ["backslash", "run\\id"],
    ["command substitution", "run$(whoami)"],
    ["semicolon", "run;rm"],
    ["whitespace", "run id"],
    ["newline", "run\nid"],
    ["null byte", "run\u0000id"],
    ["uppercase", "RUNIDXX"],
    ["leading dash", "-runidxx"],
    ["trailing dash", "runidxx-"],
    ["double dash", "run--idxx"],
    ["too short", "abc"],
    ["too long", "a".repeat(65)],
    ["empty", ""],
    ["dot", "."],
    ["not a string", 42],
    ["null", null],
  ])("rejects %s as a run id", (_label, value) => {
    expect(() => assertRunID(value as string)).toThrow(/unsafe e2e run id/u);
  });

  it("names the container and tag from the validated id", () => {
    const id = createRunID(new Date("2026-08-26T02:30:15.000Z"), "abc12345");
    expect(containerName(id)).toBe(`${RESOURCE_PREFIX}-20260826t023015z-abc12345`);
    expect(imageTag(id)).toBe(`${RESOURCE_PREFIX}:run-20260826t023015z-abc12345`);
  });

  it("refuses to name a container or tag from an unsafe id", () => {
    expect(() => containerName("../evil")).toThrow(/unsafe e2e run id/u);
    expect(() => imageTag("a;b")).toThrow(/unsafe e2e run id/u);
  });
});

describe("argument forwarding", () => {
  it("forwards nothing for a full-suite run", () => {
    expect(parseArgs([])).toEqual({
      options: { keepImage: false, keepContainer: false, noCache: false },
      playwrightArgs: [],
    });
  });

  it("forwards a targeted spec verbatim", () => {
    // This is the shape `npm run test:e2e:docker -- tests/e2e/smoke.ui.spec.ts`
    // arrives in, because npm consumes the separator before we see argv.
    expect(parseArgs(["tests/e2e/smoke.ui.spec.ts"]).playwrightArgs).toEqual([
      "tests/e2e/smoke.ui.spec.ts",
    ]);
  });

  it("preserves Playwright flags, values and grep patterns as separate elements", () => {
    const argv = ["tests/e2e/smoke.ui.spec.ts", "--grep", "notification badge", "--workers=2", "-x"];
    expect(parseArgs(argv).playwrightArgs).toEqual(argv);
  });

  it("never merges arguments into a single string", () => {
    // The container entrypoint does `exec playwright test ... "$@"`, so as long
    // as each argument stays its own array element, a title containing spaces or
    // `;` is data. Joining them anywhere would make it a command.
    const argv = ["--grep", "a title; rm -rf /", "tests/e2e/a b.spec.ts"];
    const forwarded = parseArgs(argv).playwrightArgs;
    expect(forwarded).toHaveLength(3);
    expect(forwarded[1]).toBe("a title; rm -rf /");
    expect(forwarded[2]).toBe("tests/e2e/a b.spec.ts");
  });

  it("consumes leading launcher flags without forwarding them", () => {
    const parsed = parseArgs(["--keep-image", "--no-cache", "tests/e2e/smoke.ui.spec.ts"]);
    expect(parsed.options.keepImage).toBe(true);
    expect(parsed.options.noCache).toBe(true);
    expect(parsed.playwrightArgs).toEqual(["tests/e2e/smoke.ui.spec.ts"]);
  });

  it("reads --artifact-root with its value", () => {
    const parsed = parseArgs(["--artifact-root", "/tmp/out", "--grep", "smoke"]);
    expect(parsed.options.artifactRoot).toBe("/tmp/out");
    expect(parsed.playwrightArgs).toEqual(["--grep", "smoke"]);
  });

  it("stops launcher parsing at the first non-flag token", () => {
    // Front-anchored parsing is what makes `--artifact-root` unambiguous. Once a
    // spec path appears, a later `--artifact-root` is Playwright's problem, not
    // a host directory selector.
    const parsed = parseArgs(["tests/e2e/smoke.ui.spec.ts", "--artifact-root", "/etc"]);
    expect(parsed.options.artifactRoot).toBeUndefined();
    expect(parsed.playwrightArgs).toEqual(["tests/e2e/smoke.ui.spec.ts", "--artifact-root", "/etc"]);
  });

  it("treats an explicit -- as the end of launcher flags and drops it", () => {
    const parsed = parseArgs(["--keep-image", "--", "--keep-container"]);
    expect(parsed.options.keepImage).toBe(true);
    expect(parsed.options.keepContainer).toBe(false);
    expect(parsed.playwrightArgs).toEqual(["--keep-container"]);
  });

  it("rejects --artifact-root without a value", () => {
    expect(() => parseArgs(["--artifact-root"])).toThrow(/requires a value/u);
    expect(() => parseArgs(["--artifact-root", "--keep-image"])).toThrow(/requires a value/u);
  });

  it("reads a prebuilt --image so CI can own the build cache", () => {
    const parsed = parseArgs(["--image", "dcaleon-e2e:ci", "--artifact-root", "/tmp/out"]);
    expect(parsed.options.image).toBe("dcaleon-e2e:ci");
    expect(parsed.options.artifactRoot).toBe("/tmp/out");
    expect(parsed.playwrightArgs).toEqual([]);
  });
});

describe("prebuilt image reference", () => {
  it.each([
    ["a plain name", "dcaleon-e2e"],
    ["a name and tag", "dcaleon-e2e:ci"],
    ["a registry path", "ghcr.io/owner/name:v1.2.3"],
    ["dots and underscores in the tag", "image:1.2_3-rc.1"],
  ])("accepts %s", (_label, value) => {
    expect(assertImageRef(value)).toBe(value);
  });

  // This value lands in `docker` argv. The risk is not that a registry would
  // reject it — it is that it could be read as another flag or carry shell
  // syntax into a later command.
  it.each([
    ["a leading dash that would read as a flag", "-rm"],
    ["a space", "image:tag other"],
    ["a semicolon", "image;rm -rf /"],
    ["command substitution", "image:$(whoami)"],
    ["a newline", "image:tag\n--privileged"],
    ["a null byte", "image:ta\u0000g"],
    ["a digest form we do not support", "image@sha256:abc"],
    ["uppercase in the name", "Image:tag"],
    ["an empty string", ""],
    ["two tags", "image:a:b"],
    ["not a string", 7],
  ])("rejects %s", (_label, value) => {
    expect(() => assertImageRef(value as string)).toThrow(/unsafe image reference/u);
  });

  it("rejects an unsafe --image before it can reach docker", () => {
    expect(() => parseArgs(["--image", "im age"])).toThrow(/unsafe image reference/u);
  });
});

describe("artifact destination", () => {
  it("defaults to a repo-local ignored directory", () => {
    expect(resolveArtifactRoot(undefined, "/repo")).toBe("/repo/docker-e2e-artifacts");
  });

  it("accepts an absolute override for CI upload steps", () => {
    expect(resolveArtifactRoot("/var/tmp/e2e", "/repo")).toBe("/var/tmp/e2e");
  });

  it("normalises a redundant override", () => {
    expect(resolveArtifactRoot("/var/tmp/./e2e/", "/repo")).toBe("/var/tmp/e2e");
  });

  // The launcher creates `<root>/<id>` and removes `<root>/<id>.staging`. A root
  // of `/` would put a recursive remove one path join away from the whole disk.
  it.each([
    ["the filesystem root", "/"],
    ["a relative path", "docker-e2e-artifacts"],
    ["a bare dot", "."],
    ["a home-relative path", "~/artifacts"],
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["a control character", "/tmp/a\u0000b"],
    ["a newline", "/tmp/a\nb"],
  ])("rejects %s as an artifact root", (_label, value) => {
    expect(() => resolveArtifactRoot(value, "/repo")).toThrow();
  });
});

describe("container security posture", () => {
  const args = dockerCreateArgs({
    runID: "20260826t023015z-abc12345",
    tag: "dcaleon-e2e:run-20260826t023015z-abc12345",
    sourceSHA: "f".repeat(40),
    playwrightArgs: ["tests/e2e/smoke.ui.spec.ts"],
  });

  function flagValue(flag: string): string | undefined {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  }

  it("creates rather than runs, so the stopped container can still be copied from", () => {
    expect(args[0]).toBe("create");
  });

  it("isolates the network", () => {
    // `none` still provides loopback, which is all the BFF and both mocks use.
    expect(flagValue("--network")).toBe("none");
  });

  it("drops all capabilities and blocks privilege escalation", () => {
    expect(flagValue("--cap-drop")).toBe("ALL");
    expect(flagValue("--security-opt")).toBe("no-new-privileges");
  });

  it("reaps orphans with an init process", () => {
    expect(args).toContain("--init");
  });

  it("gives Chromium private shared memory instead of host IPC", () => {
    expect(flagValue("--shm-size")).toBe("1g");
    expect(args).not.toContain("--ipc");
  });

  it("bounds the process count", () => {
    expect(Number(flagValue("--pids-limit"))).toBeGreaterThan(0);
  });

  // Each of these would hand the container a piece of the host. Asserting their
  // absence is the cheapest possible regression test for the security claims in
  // the pull request body, and it fails the moment somebody adds one to make a
  // browser launch.
  it.each([
    "-v",
    "--volume",
    "--mount",
    "--privileged",
    "--device",
    "-p",
    "--publish",
    "--user",
    "--cap-add",
    "--pid",
    "--userns",
    "--group-add",
  ])("never passes %s", (flag) => {
    expect(args).not.toContain(flag);
  });

  it("never mounts the Docker socket, host home or host tmp under any syntax", () => {
    const joined = args.join(" ");
    expect(joined).not.toContain("docker.sock");
    expect(joined).not.toContain(":/root");
    expect(joined).not.toContain("/var/run");
    expect(joined).not.toMatch(/--network[= ]host/u);
    expect(joined).not.toMatch(/--(pid|ipc)[= ]host/u);
  });

  it("injects only generated environment, never the host environment", () => {
    const injected = args.filter((arg, index) => args[index - 1] === "--env");
    expect(injected).toEqual([
      "CI=true",
      "E2E_RUN_ID=20260826t023015z-abc12345",
      `E2E_SOURCE_SHA=${"f".repeat(40)}`,
      "E2E_IMAGE_TAG=dcaleon-e2e:run-20260826t023015z-abc12345",
    ]);
    // A bare `--env NAME` copies that variable in from the host. Every entry
    // above assigns a value, so nothing is inherited.
    expect(injected.every((entry) => entry.includes("="))).toBe(true);
  });

  it("forces CI so the isolated profile cannot reuse a server", () => {
    expect(args).toContain("CI=true");
  });

  it("labels the container with its run id for stray-resource triage", () => {
    expect(flagValue("--label")).toBe(`${RESOURCE_PREFIX}.run=20260826t023015z-abc12345`);
  });

  it("puts the image immediately before the forwarded command", () => {
    expect(args.at(-2)).toBe("dcaleon-e2e:run-20260826t023015z-abc12345");
    expect(args.at(-1)).toBe("tests/e2e/smoke.ui.spec.ts");
  });

  it("names the container from the run id", () => {
    expect(flagValue("--name")).toBe(containerName("20260826t023015z-abc12345"));
  });

  it("refuses to build arguments for an unsafe run id", () => {
    expect(() =>
      dockerCreateArgs({
        runID: "../escape",
        tag: "t",
        sourceSHA: "s",
        playwrightArgs: [],
      }),
    ).toThrow(/unsafe e2e run id/u);
  });
});

describe("artifact export", () => {
  it("copies regular files and preserves the tree", () => {
    const root = fixtureRoot();
    const staging = path.join(root, "staging");
    const destination = path.join(root, "run");
    mkdirSync(path.join(staging, "logs"), { recursive: true });
    mkdirSync(path.join(staging, "playwright-report/data"), { recursive: true });
    writeFileSync(path.join(staging, "logs/container.txt"), "uid=1000\n");
    writeFileSync(path.join(staging, "playwright-report/index.html"), "<html></html>");
    writeFileSync(path.join(staging, "playwright-report/data/trace.zip"), "PK");

    const report = exportArtifacts(staging, destination);

    expect(report.files.map((file) => file.path)).toEqual([
      "logs/container.txt",
      "playwright-report/data/trace.zip",
      "playwright-report/index.html",
    ]);
    expect(report.rejected).toEqual([]);
    expect(readdirSync(path.join(destination, "playwright-report")).sort()).toEqual([
      "data",
      "index.html",
    ]);
  });

  it("refuses a symlink instead of following it out of the bundle", () => {
    // `docker cp` reproduces a container symlink AS a symlink on the host. Left
    // alone, `/artifacts/report -> /etc/passwd` becomes a host symlink that the
    // next reader — a CI upload step, a browser, a reviewer — follows straight
    // out of the run directory. So the link is dropped and recorded.
    const root = fixtureRoot();
    const staging = path.join(root, "staging");
    const outside = path.join(root, "outside");
    mkdirSync(staging, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "secret.txt"), "host secret");
    symlinkSync(path.join(outside, "secret.txt"), path.join(staging, "leak.txt"));
    writeFileSync(path.join(staging, "real.txt"), "ok");

    const report = exportArtifacts(staging, path.join(root, "run"));

    expect(report.files.map((file) => file.path)).toEqual(["real.txt"]);
    expect(report.rejected).toEqual([{ path: "leak.txt", reason: "symbolic link" }]);
    expect(readdirSync(path.join(root, "run"))).toEqual(["real.txt"]);
  });

  it("refuses a symlinked directory so the walk cannot leave the staging tree", () => {
    const root = fixtureRoot();
    const staging = path.join(root, "staging");
    const outside = path.join(root, "outside");
    mkdirSync(staging, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "secret.txt"), "host secret");
    symlinkSync(outside, path.join(staging, "escape"));

    const report = exportArtifacts(staging, path.join(root, "run"));

    expect(report.files).toEqual([]);
    expect(report.rejected).toEqual([{ path: "escape", reason: "symbolic link" }]);
  });

  it("bounds the file count", () => {
    const root = fixtureRoot();
    const staging = path.join(root, "staging");
    mkdirSync(staging, { recursive: true });
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(path.join(staging, `f${String(index)}.txt`), "x");
    }

    const report = exportArtifacts(staging, path.join(root, "run"), {
      ...ARTIFACT_LIMITS,
      maxFiles: 3,
    });

    expect(report.files).toHaveLength(3);
    expect(report.rejected).toHaveLength(2);
    expect(report.rejected[0]?.reason).toMatch(/exceeds 3 files/u);
  });

  it("bounds a single file", () => {
    const root = fixtureRoot();
    const staging = path.join(root, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "huge.zip"), "x".repeat(2048));
    writeFileSync(path.join(staging, "small.txt"), "x");

    const report = exportArtifacts(staging, path.join(root, "run"), {
      ...ARTIFACT_LIMITS,
      maxFileBytes: 1024,
    });

    expect(report.files.map((file) => file.path)).toEqual(["small.txt"]);
    expect(report.rejected[0]).toEqual({ path: "huge.zip", reason: "exceeds 1024 bytes" });
  });

  it("bounds the total size", () => {
    const root = fixtureRoot();
    const staging = path.join(root, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "a.txt"), "x".repeat(600));
    writeFileSync(path.join(staging, "b.txt"), "x".repeat(600));

    const report = exportArtifacts(staging, path.join(root, "run"), {
      ...ARTIFACT_LIMITS,
      maxTotalBytes: 1000,
    });

    expect(report.files.map((file) => file.path)).toEqual(["a.txt"]);
    expect(report.totalBytes).toBe(600);
    expect(report.rejected[0]?.reason).toMatch(/exceeds 1000 total bytes/u);
  });

  it("reports byte sizes so a summary can be trusted", () => {
    const root = fixtureRoot();
    const staging = path.join(root, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "a.txt"), "12345");

    const report = exportArtifacts(staging, path.join(root, "run"));
    expect(report).toMatchObject({ totalBytes: 5, files: [{ path: "a.txt", bytes: 5 }] });
  });

  it("creates the destination for an empty tree rather than failing the run", () => {
    // A container that died before Playwright wrote anything still needs a run
    // directory, because that is where summary.json records why.
    const root = fixtureRoot();
    const staging = path.join(root, "staging");
    mkdirSync(staging, { recursive: true });

    const report = exportArtifacts(staging, path.join(root, "run"));

    expect(report.files).toEqual([]);
    expect(readdirSync(path.join(root, "run"))).toEqual([]);
  });
});

describe("docker availability preflight", () => {
  it("accepts a daemon that reports a server version", () => {
    expect(classifyDockerProbe({ status: 0, stdout: "27.4.0\n" })).toEqual({
      available: true,
      serverVersion: "27.4.0",
    });
  });

  it("distinguishes a missing binary from a stopped daemon", () => {
    // These need different advice. Telling someone with no `docker` on PATH to
    // "start the daemon" sends them looking for something that is not there.
    expect(classifyDockerProbe({ error: { code: "ENOENT" }, status: null })).toMatchObject({
      available: false,
      reason: "missing-binary",
    });
    expect(
      classifyDockerProbe({
        status: 1,
        stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n",
      }),
    ).toMatchObject({ available: false, reason: "daemon-unreachable" });
  });

  it("carries the daemon's own first stderr line as the detail", () => {
    const availability = classifyDockerProbe({
      status: 1,
      stderr: "Cannot connect to the Docker daemon.\nmore noise\n",
    });
    expect(availability).toMatchObject({ detail: "Cannot connect to the Docker daemon." });
  });

  it("treats a zero exit with no version as unavailable", () => {
    // A CLI that succeeds but reports nothing has not proven a daemon exists,
    // and proceeding would fail later with a far less obvious message.
    expect(classifyDockerProbe({ status: 0, stdout: "  \n" })).toMatchObject({
      available: false,
      reason: "daemon-unreachable",
    });
  });

  it("treats a non-ENOENT spawn error as unreachable rather than throwing", () => {
    expect(classifyDockerProbe({ error: { code: "EACCES" }, status: null })).toMatchObject({
      available: false,
      reason: "daemon-unreachable",
    });
  });

  it("uses an exit code that cannot be confused with a test failure", () => {
    // Playwright exits 1 when tests fail. If the lane reused 1, a caller could
    // not tell "the suite is red" from "the suite never ran".
    expect(EXIT_DOCKER_UNAVAILABLE).toBe(69);
    expect(EXIT_DOCKER_UNAVAILABLE).not.toBe(0);
    expect(EXIT_DOCKER_UNAVAILABLE).not.toBe(1);
  });

  it("names the host override in the failure message", () => {
    // The operator should not have to find the README while their run is
    // broken, so the escape hatch is printed at the point of failure.
    const lines = unavailableMessage({
      available: false,
      reason: "daemon-unreachable",
      detail: "Cannot connect to the Docker daemon.",
    }).join("\n");
    expect(lines).toContain("npm run test:e2e:host");
    expect(lines).toContain("3410/4599/4600");
  });

  it("states that the fallback is not automatic and says why", () => {
    // Free ports do not prove exclusivity: a sibling worktree on another PORT
    // still writes the same /tmp fixtures. The message has to say so, because
    // that is the non-obvious reason the launcher refuses to decide.
    const lines = unavailableMessage({
      available: false,
      reason: "missing-binary",
      detail: "no `docker` executable on PATH",
    }).join("\n");
    expect(lines).toContain("No automatic fallback");
    expect(lines).toMatch(/different PORT/u);
  });

  it("tells someone without the binary to install it", () => {
    const lines = unavailableMessage({
      available: false,
      reason: "missing-binary",
      detail: "no `docker` executable on PATH",
    }).join("\n");
    expect(lines).toContain("Install Docker");
  });
});

describe("runtime user assertion", () => {
  it("reads the uid the container actually ran as", () => {
    expect(readRuntimeUID("run_id=x\nuser=node uid=1000 gid=1000\nnode=v22.0.0\n")).toBe(1000);
  });

  it("detects a root runtime, which would undo the non-root invariant", () => {
    expect(readRuntimeUID("user=root uid=0 gid=0\n")).toBe(0);
  });

  it("returns undefined when the container never wrote metadata", () => {
    expect(readRuntimeUID("")).toBeUndefined();
    expect(readRuntimeUID("run_id=x\n")).toBeUndefined();
  });
});
