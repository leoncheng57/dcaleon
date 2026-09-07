import { describe, expect, it } from "vitest";

import { selectPhoneUrl } from "../client/lib/phoneTransfer.js";
import { conversationUrl, eventClickUrl, parsePublicAppUrl } from "../server/publicAppUrl.js";

describe("phone transfer URL", () => {
  it("normalizes a configured HTTP(S) origin", () => {
    expect(parsePublicAppUrl(" https://ide.example.test:8443/ ")).toBe("https://ide.example.test:8443");
    expect(parsePublicAppUrl("http://100.64.0.1")).toBe("http://100.64.0.1");
  });

  it("falls back to the current browser origin when unset", () => {
    expect(parsePublicAppUrl("  ")).toBeNull();
    expect(selectPhoneUrl(null, "http://localhost:5173/path")).toBe("http://localhost:5173");
  });

  it("targets the active conversation and directory", () => {
    expect(
      selectPhoneUrl(
        "https://ide.example.test",
        "http://localhost:3410/sessions/ses%2Fone?directory=%2Ftmp%2Fproject+one",
      ),
    ).toBe("https://ide.example.test/sessions/ses%2Fone?directory=%2Ftmp%2Fproject+one");
  });

  it("keeps non-conversation transfers at the app root", () => {
    expect(selectPhoneUrl("https://ide.example.test", "http://localhost:3410/settings?directory=%2Ftmp%2Fproject")).toBe(
      "https://ide.example.test",
    );
  });

  it.each([
    "ftp://ide.example.test",
    "https://user:secret@ide.example.test",
    "https://ide.example.test/app",
    "https://ide.example.test/?token=secret",
    "https://ide.example.test/#session",
    "not a url",
  ])("rejects non-origin value %s", (value) => {
    expect(() => parsePublicAppUrl(value)).toThrow(/PUBLIC_APP_URL/);
  });

  it("prefers the configured public origin", () => {
    expect(selectPhoneUrl("https://ide.example.test", "http://localhost:3410")).toBe("https://ide.example.test");
  });
});

describe("notification links", () => {
  it("builds an encoded conversation link from the trusted origin", () => {
    expect(conversationUrl("https://ide.example.test", "ses/a", "/tmp/project one")).toBe(
      "https://ide.example.test/sessions/ses%2Fa?directory=%2Ftmp%2Fproject+one",
    );
  });

  it("falls back to the configured origin and ignores unrelated events", () => {
    expect(eventClickUrl("https://ide.example.test", { type: "session.idle", properties: {} })).toBe("https://ide.example.test");
    // A Claude runtime session has its own surface and carries no directory scope.
    expect(conversationUrl("https://ide.example.test", "claude-0f3c", "/tmp/project")).toBe("https://ide.example.test/claude/sessions/claude-0f3c");
    expect(eventClickUrl("https://ide.example.test", { type: "session.idle", directory: "/tmp/p", properties: { sessionID: "claude-0f3c" } }))
      .toBe("https://ide.example.test/claude/sessions/claude-0f3c");
    expect(eventClickUrl("https://ide.example.test", { type: "message.updated", properties: {} })).toBeUndefined();
  });
});
