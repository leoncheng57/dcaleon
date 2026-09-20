// One supervisor interface, two backends chosen by platform.
//
// macOS supervises with launchd; Linux supervises with a detached tmux session
// (see tmuxSupervisor.ts for why not systemd). The npm `service:*` scripts and
// scripts/deploy.sh both come through here, so neither has to know which host
// it is on.
//
// The platform decides the backend, not an environment variable. This matches
// the rule the runtime islands already follow (AGENTS.md decision 36): what a
// host *can* do is a property of the host, never an operator toggle. There is
// no launchd on Linux to select and no launchctl on macOS worth skipping.
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as launchd from "./launchd.js";
import { DEFAULT_SUPERVISED_PORT, parseSupervisedPort } from "./launchd.js";
import * as tmux from "./tmuxSupervisor.js";

export type SupervisorBackend = "launchd" | "tmux";

export interface BackendChoice {
  backend: SupervisorBackend | null;
  /** Why an unsupported platform cannot be supervised, for the error message. */
  reason: string | null;
}

/**
 * Pure so the dispatch is testable on whichever platform CI happens to run.
 * An unknown platform is refused rather than guessed at: silently picking tmux
 * on, say, win32 would fail later and further from the cause.
 */
export function chooseBackend(platform: NodeJS.Platform = process.platform): BackendChoice {
  if (platform === "darwin") return { backend: "launchd", reason: null };
  if (platform === "linux") return { backend: "tmux", reason: null };
  return {
    backend: null,
    reason: `no supervisor for platform '${platform}' — dcaleon supervises with launchd on macOS and tmux on Linux`,
  };
}

export function requireBackend(platform: NodeJS.Platform = process.platform): SupervisorBackend {
  const choice = chooseBackend(platform);
  if (!choice.backend) throw new Error(choice.reason ?? "unsupported platform");
  return choice.backend;
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function main(): void {
  const action = process.argv[2];
  const portArg = process.argv.find((value) => value.startsWith("--port="))?.slice("--port=".length);
  const forceActiveClaude = process.argv.includes("--force-active-claude");
  const port = parseSupervisedPort(portArg);
  const backend = requireBackend();
  const root = repoRoot();

  if (backend === "launchd") {
    if (action === "install") launchd.install(port, forceActiveClaude);
    else if (action === "status") launchd.status();
    else if (action === "logs") launchd.logs();
    else if (action === "uninstall") launchd.uninstall();
    else throw new Error(usage());
    return;
  }

  // --force-active-claude has no counterpart here: the tmux backend does not
  // query running Claude sessions before replacing the process. Saying so beats
  // accepting the flag and ignoring it.
  if (forceActiveClaude) {
    console.warn("Warning: --force-active-claude has no effect on the tmux backend; it does not check for active sessions.");
  }
  if (action === "install") tmux.install(root, port);
  else if (action === "status") tmux.status(root);
  else if (action === "logs") tmux.logs(root);
  else if (action === "uninstall") tmux.uninstall(root);
  else throw new Error(usage());
}

function usage(): string {
  return `usage: supervisor.ts <install|status|logs|uninstall> [--port=${DEFAULT_SUPERVISED_PORT}] [--force-active-claude]`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
