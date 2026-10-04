import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const servers: ReturnType<typeof createServer>[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })));
});

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port probe did not bind a TCP port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

interface PreflightOptions {
  password?: string;
  /** Value written into the fake `EXPECTED_SERVER_VERSION` pin. */
  pinVersion?: string;
  /** Value the fake OpenCode health endpoint reports. */
  serverVersion?: string;
  /** Set when the run is expected to warn on stderr. */
  allowStderr?: boolean;
  /** Invoking-shell NOTIFICATION_DELIVERY; undefined deletes it from the env. */
  deliveryEnv?: string;
  /** Contents for a temp file pointed at by DCA_ENV_FILE (default: missing file). */
  envFile?: string;
}

async function runPreflight(
  passwordOrOptions?: string | PreflightOptions,
): Promise<{ authorization?: string; requests: number; stdout: string; stderr: string }> {
  const options: PreflightOptions = typeof passwordOrOptions === "string"
    ? { password: passwordOrOptions }
    : passwordOrOptions ?? {};
  const { password, pinVersion = "1.18.21", serverVersion = "1.18.21", allowStderr = false, deliveryEnv, envFile } = options;
  let authorization: string | undefined;
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    authorization = req.headers.authorization;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ healthy: true, version: serverVersion }));
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock health server did not bind a TCP port");

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "custom-dca-dev-script-"));
  tempRoots.push(tempRoot);
  await mkdir(path.join(tempRoot, "scripts"));
  await mkdir(path.join(tempRoot, "server", "opencode"), { recursive: true });
  await copyFile(path.join(root, "scripts", "dev.sh"), path.join(tempRoot, "scripts", "dev.sh"));
  await writeFile(path.join(tempRoot, "server", "opencode", "client.ts"), `const EXPECTED_SERVER_VERSION = "${pinVersion}";\n`);
  await writeFile(path.join(tempRoot, ".env"), "OPENCODE_URL=http://127.0.0.1:1\nOPENCODE_SERVER_PASSWORD=conflicting\n");

  const env = { ...process.env };
  delete env.OPENCODE_SERVER_PASSWORD;
  delete env.OPENCODE_SERVER_USERNAME;
  delete env.NOTIFICATION_DELIVERY;
  let envFilePath = path.join(tempRoot, "missing.env");
  if (envFile !== undefined) {
    envFilePath = path.join(tempRoot, "custom.env");
    await writeFile(envFilePath, envFile);
  }
  Object.assign(env, {
    BASH_COMPAT: "32",
    DCA_ENV_FILE: envFilePath,
    ...(deliveryEnv !== undefined ? { NOTIFICATION_DELIVERY: deliveryEnv } : {}),
    DEV_HEALTHCHECK_ONLY: "1",
    OPENCODE_URL: `http://127.0.0.1:${address.port}`,
    PORT: String(await availablePort()),
    ...(password ? { OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: "tester" } : {}),
  });

  const child = spawn("/bin/bash", ["scripts/dev.sh"], { cwd: tempRoot, env });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close") as [number | null];
  expect(allowStderr ? { code } : { code, stderr }).toEqual(allowStderr ? { code: 0 } : { code: 0, stderr: "" });
  return { authorization, requests, stdout, stderr };
}

describe("scripts/dev.sh health preflight", () => {
  it("works without an auth argument under Bash 3.2 compatibility", async () => {
    const result = await runPreflight();
    expect(result.requests).toBe(1);
    expect(result.authorization).toBeUndefined();
    expect(result.stdout).toContain('"version":"1.18.21"');
  });

  it("passes Basic auth when a password is configured", async () => {
    const result = await runPreflight("s3cret");
    expect(result.requests).toBe(1);
    expect(result.authorization).toBe(`Basic ${Buffer.from("tester:s3cret").toString("base64")}`);
  });

  // The fork binary reports SemVer build metadata. Comparing only
  // MAJOR.MINOR.PATCH would drop `+dca.<n>` from the pin and warn on every
  // start, training the reader to ignore the one signal that catches an
  // accidental fallback to a stock binary.
  it("does not report skew when the pin and server agree on build metadata", async () => {
    const result = await runPreflight({ pinVersion: "1.18.23+dca.2", serverVersion: "1.18.23+dca.2" });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('"version":"1.18.23+dca.2"');
  });

  it("still reports skew when only the build metadata differs", async () => {
    const result = await runPreflight({ pinVersion: "1.18.23+dca.2", serverVersion: "1.18.23", allowStderr: true });
    expect(result.stderr).toContain("version skew");
    expect(result.stderr).toContain("1.18.23+dca.2");
  });

  it("defaults notification delivery to off for a dev stack", async () => {
    const result = await runPreflight();
    expect(result.stdout).toContain("notification delivery: off");
  });

  it("honours NOTIFICATION_DELIVERY=on from the invoking shell", async () => {
    const result = await runPreflight({ deliveryEnv: "on" });
    expect(result.stdout).toContain("notification delivery: on");
  });

  it("ignores NOTIFICATION_DELIVERY set in the shared .env", async () => {
    // The .env describes the supervised BFF; a value in it must not opt a dev
    // stack into delivery (#320).
    const result = await runPreflight({ envFile: "NOTIFICATION_DELIVERY=on\n" });
    expect(result.stdout).toContain("notification delivery: off");
  });
});
