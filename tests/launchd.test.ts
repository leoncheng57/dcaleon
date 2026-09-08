import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BFF_LABEL,
  DEFAULT_SUPERVISED_PORT,
  assertSupportedNodeVersion,
  activeClaudeSessions,
  assertInstallablePlist,
  escapePlistString,
  parseSupervisedPort,
  parseBffPlistPort,
  renderBffPlist,
} from "../scripts/launchd.js";

describe("LaunchAgent plist generation", () => {
  it("escapes every XML-sensitive character", () => {
    expect(escapePlistString(`a & b < c > d "quoted" 'single'`)).toBe(
      "a &amp; b &lt; c &gt; d &quot;quoted&quot; &apos;single&apos;",
    );
  });

  it("preserves argument boundaries for repository paths containing spaces", () => {
    const plist = renderBffPlist({
      repoRoot: "/Users/Example/Projects/Agent & UI",
      nodePath: "/opt/Node <current>/bin/node",
      home: "/Users/Example",
      pathValue: "/opt/Node <current>/bin:/usr/bin:/bin",
      port: 3210,
      stdoutPath: "/Users/Example/Projects/Agent & UI/.state/logs/out.log",
      stderrPath: "/Users/Example/Projects/Agent & UI/.state/logs/err.log",
    });

    expect(plist).toContain(`<string>${BFF_LABEL}</string>`);
    expect(plist).toContain("/Users/Example/Projects/Agent &amp; UI/dist/server/index.js");
    expect(plist).toContain("/opt/Node &lt;current&gt;/bin/node");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain("<key>NODE_ENV</key>\n    <string>production</string>");
    expect(plist).toContain("<key>WorkingDirectory</key>");
    expect(plist).not.toContain("OPENCODE_SERVER_PASSWORD");
    expect(parseBffPlistPort(plist)).toBe(3210);
    expect(() => assertInstallablePlist(plist)).not.toThrow();
  });

  it("defaults away from the dev port and rejects port 3000", () => {
    expect(parseSupervisedPort(undefined)).toBe(DEFAULT_SUPERVISED_PORT);
    expect(DEFAULT_SUPERVISED_PORT).not.toBe(3000);
    expect(() => parseSupervisedPort("3000")).toThrow("conflicts with the development default");
  });

  it("rejects Node versions older than the supported runtime", () => {
    expect(() => assertSupportedNodeVersion("21.7.0")).toThrow("Node 22 or newer is required");
    expect(() => assertSupportedNodeVersion("22.0.0")).not.toThrow();
  });

  it("finds only running Claude sessions for the deploy guard", () => {
    expect(activeClaudeSessions({ sessions: [
      { id: "claude-busy", title: "Finish the PR", running: true },
      { id: "claude-idle", title: "Done", running: false },
      { title: "Malformed", running: true },
    ] })).toEqual([{ id: "claude-busy", title: "Finish the PR" }]);
    expect(activeClaudeSessions({ sessions: "bad" })).toEqual([]);
  });

  it("keeps the optional OpenCode unit direct and impossible to install unresolved", () => {
    const template = readFileSync(new URL("../deploy/ai.opencode.serve.plist", import.meta.url), "utf8");
    expect(template).not.toContain("/usr/bin/env");
    expect(template).not.toContain("<string>node</string>");
    expect(template).not.toContain("OPENCODE_SERVER_PASSWORD");
    expect(() => assertInstallablePlist(template)).toThrow("unresolved plist placeholder");

    const resolved = template
      .replaceAll("REPLACE_WITH_ABSOLUTE_OPENCODE_BINARY", "/Users/Example/.opencode/bin/opencode")
      .replaceAll("REPLACE_WITH_OPENCODE_PORT", "4097")
      .replaceAll("REPLACE_WITH_HOME_DIRECTORY", "/Users/Example")
      .replaceAll("REPLACE_WITH_LAUNCHD_PATH", "/Users/Example/.local/bin:/usr/bin:/bin")
      .replaceAll("REPLACE_WITH_LOG_DIRECTORY", "/Users/Example/Library/Logs/OpenCode");
    expect(resolved).not.toContain("REPLACE_WITH_");
    expect(() => assertInstallablePlist(resolved)).not.toThrow();
  });
});
