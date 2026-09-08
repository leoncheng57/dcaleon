import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const ALLOY_LABEL = "ai.custom-dca-opencode.alloy";

export interface GrafanaCloudConfig {
  url: string;
  username: string;
  token: string;
  logDirectory: string;
}

function alloyString(value: string): string {
  return JSON.stringify(value);
}

export function renderAlloyConfig(config: GrafanaCloudConfig): string {
  return `local.file_match "bff" {
  path_targets = [{
    __path__ = ${alloyString(path.join(config.logDirectory, "bff.launchd.*.log"))},
    job = "custom-dca-opencode-bff",
  }]
}

loki.source.file "bff" {
  targets    = local.file_match.bff.targets
  forward_to = [loki.process.bff.receiver]
}

loki.process "bff" {
  forward_to = [loki.write.grafana_cloud.receiver]

  stage.json {
    expressions = { level = "level", service = "service" }
  }

  stage.labels {
    values = { level = "", service = "" }
  }
}

loki.write "grafana_cloud" {
  endpoint {
    url = ${alloyString(config.url)}
    basic_auth {
      username = ${alloyString(config.username)}
      password = ${alloyString(config.token)}
    }
  }
}
`;
}

function root(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function paths(repoRoot: string) {
  const stateDir = path.join(repoRoot, ".state", "observability");
  return {
    config: path.join(stateDir, "grafana-alloy.config.alloy"),
    log: path.join(repoRoot, ".state", "logs", "grafana-alloy.launchd.log"),
    plist: path.join(os.homedir(), "Library", "LaunchAgents", `${ALLOY_LABEL}.plist`),
  };
}

function userDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Grafana Alloy LaunchAgent requires a POSIX user id");
  return `gui/${uid}`;
}

function command(name: string, args: string[], inherit = true): boolean {
  const result = spawnSync(name, args, { stdio: inherit ? "inherit" : "ignore" });
  return result.status === 0;
}

function plist(alloy: string, config: string, log: string): string {
  const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${ALLOY_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(alloy)}</string><string>run</string><string>${xml(config)}</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>`;
}

function install(): void {
  const repoRoot = root();
  dotenv.config({ path: path.join(repoRoot, ".env") });
  const alloy = process.env.GRAFANA_ALLOY_BINARY || "/opt/homebrew/bin/alloy";
  const url = process.env.GRAFANA_CLOUD_LOKI_URL;
  const username = process.env.GRAFANA_CLOUD_LOKI_USERNAME;
  const token = process.env.GRAFANA_CLOUD_LOKI_TOKEN;
  if (!url || !username || !token) throw new Error("GRAFANA_CLOUD_LOKI_URL, GRAFANA_CLOUD_LOKI_USERNAME, and GRAFANA_CLOUD_LOKI_TOKEN are required");
  if (!existsSync(alloy)) throw new Error(`Grafana Alloy not found at ${alloy}; install it or set GRAFANA_ALLOY_BINARY`);
  if (!/^https:\/\//.test(url)) throw new Error("GRAFANA_CLOUD_LOKI_URL must use https");

  const servicePaths = paths(repoRoot);
  mkdirSync(path.dirname(servicePaths.config), { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(servicePaths.log), { recursive: true, mode: 0o700 });
  writeFileSync(servicePaths.config, renderAlloyConfig({ url, username, token, logDirectory: path.dirname(servicePaths.log) }), { mode: 0o600 });
  chmodSync(servicePaths.config, 0o600);
  writeFileSync(servicePaths.plist, plist(alloy, servicePaths.config, servicePaths.log), { mode: 0o644 });
  const domain = userDomain();
  if (command("launchctl", ["print", `${domain}/${ALLOY_LABEL}`], false)) command("launchctl", ["bootout", `${domain}/${ALLOY_LABEL}`]);
  if (!command("launchctl", ["bootstrap", domain, servicePaths.plist])) throw new Error("could not start Grafana Alloy");
  console.log(`Grafana Alloy is shipping BFF logs to Grafana Cloud. Config: ${servicePaths.config}`);
}

function status(): void {
  command("launchctl", ["print", `${userDomain()}/${ALLOY_LABEL}`]);
}

function uninstall(): void {
  const servicePaths = paths(root());
  command("launchctl", ["bootout", `${userDomain()}/${ALLOY_LABEL}`], false);
  rmSync(servicePaths.plist, { force: true });
  console.log("Grafana Alloy LaunchAgent removed; the credential-bearing config was preserved.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const action = process.argv[2];
  if (action === "install") install();
  else if (action === "status") status();
  else if (action === "uninstall") uninstall();
  else throw new Error("usage: observability.ts <install|status|uninstall>");
}
