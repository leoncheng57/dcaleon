import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ALL_INTERFACES, LOOPBACK, chooseBindHost, describeBindHost } from "../server/bindHost.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("bind host selection", () => {
  // The Coder workspace pod sits on the corporate tailnet, and this app has no
  // authentication of its own — so on Linux every interface but loopback is a
  // way around Coder's owner-private port gate.
  it("binds loopback on Linux and every interface on macOS", () => {
    expect(chooseBindHost("linux", {})).toBe(LOOPBACK);
    expect(chooseBindHost("darwin", {})).toBe(ALL_INTERFACES);
  });

  // The macOS deployment reaches the app from a phone over the tailnet; that
  // is the original design and this change must not narrow it.
  it("does not narrow the macOS tailnet deployment", () => {
    expect(chooseBindHost("darwin", {})).not.toBe(LOOPBACK);
  });

  it("lets BIND_HOST override the default on either platform", () => {
    expect(chooseBindHost("linux", { BIND_HOST: "0.0.0.0" })).toBe("0.0.0.0");
    expect(chooseBindHost("darwin", { BIND_HOST: "127.0.0.1" })).toBe("127.0.0.1");
    expect(chooseBindHost("linux", { BIND_HOST: "  10.0.0.5  " })).toBe("10.0.0.5");
  });

  // An empty or whitespace override is a misconfiguration, not a request to
  // bind the empty string (which Node reads as every interface).
  it("ignores a blank BIND_HOST rather than binding everything", () => {
    expect(chooseBindHost("linux", { BIND_HOST: "" })).toBe(LOOPBACK);
    expect(chooseBindHost("linux", { BIND_HOST: "   " })).toBe(LOOPBACK);
  });

  it("says why the bind was chosen so a refused connection is diagnosable", () => {
    expect(describeBindHost(LOOPBACK, {})).toContain("loopback only");
    expect(describeBindHost("0.0.0.0", { BIND_HOST: "0.0.0.0" })).toContain("BIND_HOST");
  });

  // Regression guard: the whole point is that the listen call stops hardcoding
  // a wide bind. A future edit that inlines it again should fail here.
  it("keeps server/index.ts from hardcoding a bind address", () => {
    const source = readFileSync(path.join(repoRoot, "server", "index.ts"), "utf8");
    const listen = source.match(/app\.listen\([^)]*\)/u)?.[0] ?? "";
    expect(listen).toContain("bindHost");
    expect(listen).not.toContain("0.0.0.0");
  });
});
