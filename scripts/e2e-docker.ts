import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Host-side launcher for the isolated E2E lane (issue #204).
//
// Docker is OPTIONAL test infrastructure. The application stays host-native and
// nothing here runs during `npm run dev`, `npm start` or a deploy.
//
// What this owns, and why each piece is written the paranoid way:
//
//   run id      Generated here, never accepted from a caller, and constrained to
//               [a-z0-9-]. It is interpolated into a container name, an image
//               tag and a filesystem path, so path syntax must not be able to
//               enter it.
//   build       `docker build -f Dockerfile.e2e` over a `.dockerignore`
//               allowlist. No source bind mount exists at runtime, so the image
//               layer IS the sanitized snapshot.
//   run         `docker create` + `docker start --attach`, so the exit status
//               can be read from the container rather than inferred, and so the
//               stopped container still holds /artifacts for export.
//   export      `docker cp` into a staging directory, then validation, then a
//               copy of accepted regular files into the run directory. There is
//               deliberately NO writable artifact bind mount: the container
//               would then be able to write and delete host files directly.
//   cleanup     Exactly one container name and at most one image tag, both
//               generated above. Never a path or name supplied by test data.
//
// Non-goal, stated plainly: this is not a hostile-code sandbox. A pull request
// can edit Dockerfile.e2e, this file and the npm script that invokes it, so
// running an untrusted PR through `npm run test:e2e:docker` on a developer Mac
// is protected only by whatever that PR left in place. Reviewing untrusted code
// requires a launcher and image definition from outside the tested checkout.
// See docs/architecture.md and AGENTS.md decision 27.

/** Container name, image tag and artifact directory all embed the run id. */
export const RUN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Every generated resource shares this prefix so an operator can spot strays. */
export const RESOURCE_PREFIX = "dcaleon-e2e";

/** Bounds on the exported bundle. A run may not fill the host disk. */
export const ARTIFACT_LIMITS = {
  maxFiles: 5_000,
  maxFileBytes: 128 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
} as const;

/**
 * The lane could not run at all — distinct from "the tests failed".
 *
 * Playwright exits 1 when tests fail, and reusing 1 here would make those two
 * outcomes indistinguishable to any caller that does not parse stderr. An agent
 * seeing an undifferentiated 1 can plausibly conclude the suite is broken and
 * start debugging tests that never executed. 69 is sysexits' EX_UNAVAILABLE,
 * which is exactly this situation: the service this command depends on is not
 * there.
 */
export const EXIT_DOCKER_UNAVAILABLE = 69;

/** Launcher-only flags. Anything else is forwarded to Playwright untouched. */
const VALUED_FLAGS = new Set(["--artifact-root", "--image"]);
const BOOLEAN_FLAGS = new Set(["--keep-image", "--keep-container", "--no-cache"]);

/**
 * A Docker reference this launcher is willing to run.
 *
 * Only used for `--image`, where CI hands over a tag it built and cached itself.
 * Deliberately narrow: lowercase name components, an optional single tag, and no
 * whitespace, shell metacharacters or `@sha256:` digest form. The point is not
 * that a registry would reject a weirder string — it is that this value reaches
 * `docker` argv and must not be able to look like another flag.
 */
export const IMAGE_REF_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}(?::[A-Za-z0-9._-]{1,128})?$/;

export interface LauncherOptions {
  artifactRoot?: string;
  /** When set, the launcher runs this prebuilt image and never removes it. */
  image?: string;
  keepImage: boolean;
  keepContainer: boolean;
  noCache: boolean;
}

/** Throws unless `value` is a Docker reference safe to place in argv. */
export function assertImageRef(value: unknown): string {
  if (typeof value !== "string" || !IMAGE_REF_PATTERN.test(value)) {
    throw new Error(`unsafe image reference: ${JSON.stringify(value)}`);
  }
  return value;
}

export interface ParsedArgs {
  options: LauncherOptions;
  playwrightArgs: string[];
}

/**
 * Split launcher flags from Playwright arguments.
 *
 * Launcher flags are only recognised while they appear at the FRONT of argv.
 * The first token that is not a known launcher flag ends launcher parsing and
 * every remaining token — including that one — belongs to Playwright verbatim.
 * An explicit `--` also ends parsing and is itself dropped.
 *
 * Why front-anchored instead of a full scan: Playwright accepts free-form
 * positional filters and its own flags, and `npm run test:e2e:docker -- foo`
 * arrives here as plain `foo` because npm eats the separator. Scanning the whole
 * array would let a spec path or a Playwright flag be mistaken for a launcher
 * flag, and `--artifact-root` in particular selects a host directory. Stopping
 * at the first non-flag keeps that decision unambiguous.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const options: LauncherOptions = { keepImage: false, keepContainer: false, noCache: false };
  let index = 0;
  for (; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") {
      index += 1;
      break;
    }
    if (BOOLEAN_FLAGS.has(token)) {
      if (token === "--keep-image") options.keepImage = true;
      if (token === "--keep-container") options.keepContainer = true;
      if (token === "--no-cache") options.noCache = true;
      continue;
    }
    if (VALUED_FLAGS.has(token)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`${token} requires a value`);
      }
      if (token === "--artifact-root") options.artifactRoot = value;
      if (token === "--image") options.image = assertImageRef(value);
      index += 1;
      continue;
    }
    break;
  }
  return { options, playwrightArgs: argv.slice(index) };
}

/**
 * A sortable, collision-resistant run id: `<utc timestamp>-<random>`.
 *
 * The timestamp makes stray containers and artifact directories readable at a
 * glance; the random suffix is what actually prevents two simultaneous runs from
 * choosing the same name. Both inputs are injectable so the shape can be tested
 * without mocking the clock globally.
 */
export function createRunID(now: Date = new Date(), entropy: string = randomSuffix()): string {
  const stamp = now.toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z").toLowerCase();
  const id = `${stamp}-${entropy}`;
  return assertRunID(id);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/gu, "0").padEnd(8, "0");
}

/** Throws unless `value` is safe to embed in a container name, tag and path. */
export function assertRunID(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 64 || !RUN_ID_PATTERN.test(value)) {
    throw new Error(`unsafe e2e run id: ${JSON.stringify(value)}`);
  }
  return value;
}

export function containerName(runID: string): string {
  return `${RESOURCE_PREFIX}-${assertRunID(runID)}`;
}

export function imageTag(runID: string): string {
  return `${RESOURCE_PREFIX}:run-${assertRunID(runID)}`;
}

/**
 * Choose the host directory that will receive exported artifacts.
 *
 * The launcher creates `<root>/<run id>` and `<root>/<run id>.staging` and only
 * ever removes the staging path it just created. A caller-supplied root is
 * accepted because CI needs to place the bundle where the upload step can see
 * it, but it must be an absolute, syntactically ordinary path — and critically
 * it is never read from test output, container output or PR body data, only from
 * the command line of whoever launched the run.
 */
export function resolveArtifactRoot(value: string | undefined, repoRoot: string): string {
  if (value === undefined) return path.join(repoRoot, "docker-e2e-artifacts");
  if (!value.trim() || /[\u0000-\u001f]/u.test(value)) {
    throw new Error(`--artifact-root must be a plain path: ${JSON.stringify(value)}`);
  }
  if (!path.isAbsolute(value)) throw new Error(`--artifact-root must be absolute: ${value}`);
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw new Error(`--artifact-root must not be the filesystem root: ${resolved}`);
  }
  return resolved;
}

export interface CreateArgsInput {
  runID: string;
  tag: string;
  sourceSHA: string;
  playwrightArgs: readonly string[];
  shmSize?: string;
  pidsLimit?: number;
}

/**
 * Build the full argv for `docker create`.
 *
 * Exported so a test can assert the security posture as data rather than by
 * reading this file. The invariants worth stating out loud:
 *
 *   --network none            No route off the box. Loopback still exists, which
 *                             is all the BFF and both mocks need.
 *   --cap-drop ALL            Chromium runs without them under Playwright.
 *   --security-opt            no-new-privileges blocks setuid escalation.
 *   --init                    PID 1 reaps Chromium's orphans and forwards
 *                             `docker stop` to the entrypoint's exec'd process.
 *   --shm-size 1g             Chromium's default 64MB /dev/shm crashes tabs. This
 *                             is a PRIVATE shm, not host IPC.
 *   --pids-limit              Bounds a fork bomb; sized for ~6 workers of
 *                             node + multiprocess Chromium.
 *
 * Just as important is what never appears: no `-v`/`--mount` of any kind, so no
 * Docker socket, no host home, no credentials, no host /tmp, no writable source
 * and no writable artifact destination. No `-p`, so an ordinary headless run
 * publishes nothing to the host. No `--privileged`, `--pid=host`, `--ipc=host`,
 * `--network=host` or added capability. No host environment passthrough: only
 * the four variables below are injected, and all four are generated here.
 */
export function dockerCreateArgs(input: CreateArgsInput): string[] {
  const runID = assertRunID(input.runID);
  return [
    "create",
    "--name",
    containerName(runID),
    "--init",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--shm-size",
    input.shmSize ?? "1g",
    "--pids-limit",
    String(input.pidsLimit ?? 4096),
    "--label",
    `${RESOURCE_PREFIX}.run=${runID}`,
    "--env",
    "CI=true",
    "--env",
    `E2E_RUN_ID=${runID}`,
    "--env",
    `E2E_SOURCE_SHA=${input.sourceSHA}`,
    "--env",
    `E2E_IMAGE_TAG=${input.tag}`,
    input.tag,
    ...input.playwrightArgs,
  ];
}

export interface ArtifactEntry {
  path: string;
  bytes: number;
}

export interface ArtifactReport {
  files: ArtifactEntry[];
  totalBytes: number;
  rejected: { path: string; reason: string }[];
}

/**
 * Validate a `docker cp` staging tree, then copy what survived into `destination`.
 *
 * Everything in the staging tree was authored inside the container, so it is
 * treated as untrusted input even though the container is normally running our
 * own tests. `docker cp` reproduces symlinks as symlinks rather than following
 * them, which means a tree containing `report -> /etc/passwd` would otherwise
 * turn into a host symlink that a later reader follows straight out of the
 * bundle. So: lstat every entry, keep regular files only, and re-derive each
 * destination from the validated relative path instead of trusting the walk.
 *
 * Rejections are recorded and skipped rather than aborting the export, because
 * losing an entire failure report to one odd entry would be the worse outcome.
 * The caller surfaces the list.
 */
export function exportArtifacts(
  staging: string,
  destination: string,
  limits: typeof ARTIFACT_LIMITS = ARTIFACT_LIMITS,
): ArtifactReport {
  const report: ArtifactReport = { files: [], totalBytes: 0, rejected: [] };
  mkdirSync(destination, { recursive: true });

  const walk = (relative: string): void => {
    const absolute = path.join(staging, relative || ".");
    for (const name of readdirSync(absolute).sort()) {
      const childRelative = relative ? `${relative}/${name}` : name;
      const childAbsolute = path.join(staging, childRelative);

      // Containment: the joined path must still be inside staging. This catches
      // a name that is `..` or contains separators after a hostile archive.
      const contained = path.relative(staging, childAbsolute);
      if (contained.startsWith("..") || path.isAbsolute(contained)) {
        report.rejected.push({ path: childRelative, reason: "escapes the staging directory" });
        continue;
      }

      const stat = lstatSync(childAbsolute);
      if (stat.isSymbolicLink()) {
        report.rejected.push({ path: childRelative, reason: "symbolic link" });
        continue;
      }
      if (stat.isDirectory()) {
        walk(childRelative);
        continue;
      }
      if (!stat.isFile()) {
        report.rejected.push({ path: childRelative, reason: "not a regular file" });
        continue;
      }
      if (stat.size > limits.maxFileBytes) {
        report.rejected.push({ path: childRelative, reason: `exceeds ${limits.maxFileBytes} bytes` });
        continue;
      }
      if (report.files.length >= limits.maxFiles) {
        report.rejected.push({ path: childRelative, reason: `exceeds ${limits.maxFiles} files` });
        continue;
      }
      if (report.totalBytes + stat.size > limits.maxTotalBytes) {
        report.rejected.push({ path: childRelative, reason: `exceeds ${limits.maxTotalBytes} total bytes` });
        continue;
      }

      const target = path.join(destination, childRelative);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(childAbsolute, target);
      report.files.push({ path: childRelative, bytes: stat.size });
      report.totalBytes += stat.size;
    }
  };

  walk("");
  return report;
}

export type DockerAvailability =
  | { available: true; serverVersion: string }
  | { available: false; reason: "missing-binary" | "daemon-unreachable"; detail: string };

/**
 * Decide whether a `docker version` probe means the lane can run.
 *
 * Pure so the three outcomes can be tested without a daemon. Two distinct
 * failures are worth telling apart in the message the operator reads: Docker
 * not being installed needs a different response from Docker being installed
 * but stopped, and printing "is the daemon running?" to someone who has no
 * `docker` binary wastes their time.
 *
 * Anything non-zero that is not ENOENT is treated as `daemon-unreachable`. That
 * is the honest generalisation: the CLI ran and could not give us a server
 * version, and the raw stderr is carried in `detail` rather than being
 * classified further into guesses.
 */
export function classifyDockerProbe(result: {
  error?: { code?: string } | undefined;
  status: number | null;
  stdout?: string;
  stderr?: string;
}): DockerAvailability {
  if (result.error?.code === "ENOENT") {
    return { available: false, reason: "missing-binary", detail: "no `docker` executable on PATH" };
  }
  if (result.error) {
    return { available: false, reason: "daemon-unreachable", detail: `could not run docker: ${String(result.error.code ?? "unknown error")}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim().split("\n")[0] ?? "";
    return {
      available: false,
      reason: "daemon-unreachable",
      detail: stderr || `docker version exited ${String(result.status)}`,
    };
  }
  const serverVersion = (result.stdout ?? "").trim();
  if (!serverVersion) {
    return { available: false, reason: "daemon-unreachable", detail: "docker reported no server version" };
  }
  return { available: true, serverVersion };
}

/** Ask the daemon for its version; `--format` keeps the output to one line. */
function probeDocker(): DockerAvailability {
  const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  return classifyDockerProbe({
    error: result.error as ({ code?: string } | undefined),
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

/**
 * What to print when the lane cannot start.
 *
 * The override is named here, at the moment it is needed, rather than only in
 * the README: somebody whose daemon is down should not have to go find the
 * documentation to learn that `npm run test:e2e:host` exists.
 *
 * There is deliberately no automatic fallback. The launcher cannot verify the
 * one condition that would make the host lane safe. Free ports are not proof:
 * a sibling worktree running on a different PORT leaves 3410 unbound while
 * still writing the same /tmp fixtures, which is precisely the failure this
 * lane exists to prevent. So the choice is handed to the operator, who knows
 * things the launcher cannot observe.
 */
export function unavailableMessage(availability: Extract<DockerAvailability, { available: false }>): string[] {
  return [
    `Docker is not available: ${availability.detail}`,
    availability.reason === "missing-binary"
      ? "Install Docker, or run the host lane below."
      : "Start Docker and re-run, or run the host lane below.",
    "Override: `npm run test:e2e:host` runs the same suite on the host.",
    "  It writes the shared /tmp fixtures and binds 3410/4599/4600.",
    "  Safe only if no other e2e run is active — including a sibling worktree",
    "  on a different PORT, which still shares those fixtures.",
    "No automatic fallback: the launcher cannot verify that condition.",
  ];
}

/** `uid=0` in the container metadata would silently undo a stated invariant. */
export function readRuntimeUID(metadata: string): number | undefined {
  const match = /^user=\S+\s+uid=(\d+)\b/mu.exec(metadata);
  return match ? Number(match[1]) : undefined;
}

// --------------------------------------------------------------------------
// Process plumbing
// --------------------------------------------------------------------------

function run(command: string, args: readonly string[], label: string): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit ${String(result.status)}`);
}

function capture(command: string, args: readonly string[]): string | undefined {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** Best-effort; a stray container must not turn a passing run into a failure. */
function attempt(args: readonly string[]): void {
  spawnSync("docker", args, { stdio: "ignore" });
}

function main(): void {
  const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const { options, playwrightArgs } = parseArgs(process.argv.slice(2));
  const runID = createRunID();
  // With `--image`, CI already built and cached the image; the launcher borrows
  // it and must not delete something it does not own.
  const tag = options.image ?? imageTag(runID);
  const ownsImage = options.image === undefined && !options.keepImage;
  const container = containerName(runID);
  const artifactRoot = resolveArtifactRoot(options.artifactRoot, repoRoot);
  const destination = path.join(artifactRoot, runID);
  const staging = path.join(artifactRoot, `${runID}.staging`);
  const sourceSHA = capture("git", ["-C", repoRoot, "rev-parse", "HEAD"]) ?? "unknown";

  console.log(`[e2e-docker] run ${runID}`);
  console.log(`[e2e-docker] source ${sourceSHA}`);
  console.log(`[e2e-docker] playwright args ${JSON.stringify(playwrightArgs)}`);
  console.log(`[e2e-docker] artifacts ${destination}`);

  const timings: Record<string, number> = {};
  const started = Date.now();
  let exitCode = 1;
  let created = false;
  let interrupted: string | undefined;
  let failure: string | undefined;
  let failureKind: "docker-unavailable" | "launcher" | undefined;

  // Checked before the build, and before the `--image` path too: reusing a
  // prebuilt tag still needs a daemon to create and start a container.
  const availability = probeDocker();
  if (!availability.available) {
    for (const line of unavailableMessage(availability)) console.error(`[e2e-docker] ${line}`);
    writeSummary(destination, {
      runID,
      sourceSHA,
      imageTag: tag,
      container,
      playwrightArgs,
      lane: "container",
      exitCode: EXIT_DOCKER_UNAVAILABLE,
      failure: availability.detail,
      failureKind: "docker-unavailable",
      dockerReason: availability.reason,
      timings: { totalMs: Date.now() - started },
    });
    console.log(`[e2e-docker] exit ${String(EXIT_DOCKER_UNAVAILABLE)}`);
    process.exit(EXIT_DOCKER_UNAVAILABLE);
  }
  console.log(`[e2e-docker] docker server ${availability.serverVersion}`);

  try {
    // BuildKit gives the lockfile and browser layers a real cache across runs.
    const buildStarted = Date.now();
    if (options.image === undefined) {
      run(
        "docker",
        [
          "build",
          ...(options.noCache ? ["--no-cache"] : []),
          "-f",
          path.join(repoRoot, "Dockerfile.e2e"),
          "-t",
          tag,
          repoRoot,
        ],
        "docker build",
      );
    } else {
      console.log(`[e2e-docker] reusing prebuilt image ${tag}`);
    }
    timings.buildMs = Date.now() - buildStarted;

    run("docker", dockerCreateArgs({ runID, tag, sourceSHA, playwrightArgs }), "docker create");
    created = true;

    const testStarted = Date.now();
    const outcome = startAndAttach(container);
    exitCode = outcome.exitCode;
    interrupted = outcome.interrupted;
    timings.testMs = Date.now() - testStarted;
  } catch (error) {
    // A build or create failure is a launcher failure, not a test result. Report
    // it as exit 1 with the message rather than letting an unhandled throw print
    // a stack the reader has to interpret.
    //
    // Deliberately NOT EXIT_DOCKER_UNAVAILABLE: the daemon answered the probe
    // above, so a failure here is a real defect in the image, the Dockerfile or
    // the source — exactly the thing that must not be waved away as an
    // environment problem.
    failure = error instanceof Error ? error.message : String(error);
    failureKind = "launcher";
    exitCode = 1;
    console.error(`[e2e-docker] ${failure}`);
  } finally {
    let report: ArtifactReport | undefined;
    let uid: number | undefined;

    if (created) {
      const exportStarted = Date.now();
      try {
        mkdirSync(staging, { recursive: true });
        // `/artifacts/.` copies the CONTENTS, so the staging tree mirrors the
        // container tree instead of nesting an extra directory.
        attempt(["cp", `${container}:/artifacts/.`, staging]);
        report = exportArtifacts(staging, destination);
      } catch (error) {
        console.error(`[e2e-docker] artifact export failed: ${String(error)}`);
      } finally {
        // Only ever the staging path this run created, under the resolved root.
        rmSync(staging, { recursive: true, force: true });
      }
      timings.exportMs = Date.now() - exportStarted;

      const metadata = readMetadata(destination);
      uid = metadata === undefined ? undefined : readRuntimeUID(metadata);

      for (const entry of report?.rejected ?? []) {
        console.error(`[e2e-docker] rejected artifact ${entry.path}: ${entry.reason}`);
      }
      if (uid === 0) {
        console.error("[e2e-docker] WARNING: container ran as root — Dockerfile.e2e USER regressed");
      }
      console.log(
        `[e2e-docker] exported ${String(report?.files.length ?? 0)} files (${String(report?.totalBytes ?? 0)} bytes)`,
      );
    }

    // Written whether or not a container was created. A run that died during
    // build still leaves a machine-readable record of why, which is the only
    // thing a caller has to go on once the console output is gone.
    timings.totalMs = Date.now() - started;
    writeSummary(destination, {
      runID,
      sourceSHA,
      imageTag: tag,
      container,
      playwrightArgs,
      lane: "container",
      exitCode,
      interrupted,
      failure,
      failureKind,
      timings,
      runtimeUID: uid,
      nonRoot: uid !== undefined && uid !== 0,
      artifacts: report?.files ?? [],
      artifactBytes: report?.totalBytes ?? 0,
      rejected: report?.rejected ?? [],
    });
    console.log(`[e2e-docker] timings ${JSON.stringify(timings)}`);

    if (created) {
      // Exact resources only: one generated container name, and the image tag
      // only when this run is the thing that created it.
      if (!options.keepContainer) attempt(["rm", "-f", container]);
      if (ownsImage) attempt(["rmi", tag]);
    }
  }

  console.log(`[e2e-docker] exit ${String(exitCode)}`);
  process.exit(exitCode);
}

/** One writer for summary.json so every exit path produces the same shape. */
function writeSummary(destination: string, summary: Record<string, unknown>): void {
  try {
    mkdirSync(destination, { recursive: true });
    writeFileSync(path.join(destination, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    // Never let bookkeeping mask the run's real outcome.
    console.error(`[e2e-docker] could not write summary.json: ${String(error)}`);
  }
}

function readMetadata(destination: string): string | undefined {
  try {
    return readFileSync(path.join(destination, "logs/container.txt"), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Start the container, stream its output, and return the container's own exit
 * status.
 *
 * The status is read back with `docker inspect` rather than taken from the CLI's
 * own exit code: `docker start --attach` does propagate it, but if the attach
 * itself fails we would otherwise report the CLI's error as a test result. The
 * container is the authority on whether the suite passed.
 *
 * Signals: `docker start --attach` proxies SIGINT/SIGTERM into the container by
 * default, and `--init` forwards them to the exec'd Playwright process, so Ctrl-C
 * stops the tests rather than orphaning them. The local listeners exist to
 * override Node's default "die immediately" behaviour — they let this process
 * survive long enough to reach the caller's `finally`, which is what exports the
 * artifacts of an interrupted run instead of discarding them.
 */
function startAndAttach(container: string): { exitCode: number; interrupted?: string } {
  let interrupted: string | undefined;
  const note = (signal: NodeJS.Signals): void => {
    interrupted = signal;
  };
  process.on("SIGINT", note);
  process.on("SIGTERM", note);
  try {
    spawnSync("docker", ["start", "--attach", container], { stdio: "inherit" });
  } finally {
    process.off("SIGINT", note);
    process.off("SIGTERM", note);
  }

  // A proxied signal can leave the container in the middle of shutting down;
  // give it a bounded stop so the exit code below is final.
  if (interrupted) attempt(["stop", "--timeout", "10", container]);

  const inspected = capture("docker", ["inspect", "-f", "{{.State.ExitCode}}", container]);
  const parsed = inspected === undefined ? Number.NaN : Number(inspected);
  return { exitCode: Number.isInteger(parsed) ? parsed : 1, interrupted };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
