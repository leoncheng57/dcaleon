// tests/e2e-evidence.test.ts
//
// Issues #394/#395: every Playwright lane shares one failure-evidence profile
// (trace, screenshot, video). The preview lane must get it without importing
// playwright.config.ts, whose module scope prepares E2E state files and git
// fixtures.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { VIDEO_SIZE, evidenceUse, videoMode } from "./e2e/evidence.js";

vi.mock("./e2e/state-files.js", () => {
  const forbidden = () => {
    throw new Error("preview lane must not touch E2E state files");
  };
  return { e2eStateFiles: forbidden, prepareE2EStateFiles: forbidden };
});
vi.mock("./e2e/git-fixture.js", () => ({
  ensureGitFixture: () => {
    throw new Error("preview lane must not repair git fixtures");
  },
}));

const ROOT = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

describe("videoMode", () => {
  it("is off for a plain local run", () => {
    expect(videoMode({})).toBe("off");
  });

  it("records only the first retry in CI, so a green run encodes nothing", () => {
    expect(videoMode({ CI: "true" })).toBe("on-first-retry");
  });

  it("lets E2E_VIDEO=1 opt in to retain-on-failure locally and in CI", () => {
    expect(videoMode({ E2E_VIDEO: "1" })).toBe("retain-on-failure");
    expect(videoMode({ E2E_VIDEO: "1", CI: "true" })).toBe("retain-on-failure");
  });

  it("ignores E2E_VIDEO values other than 1", () => {
    expect(videoMode({ E2E_VIDEO: "0" })).toBe("off");
    expect(videoMode({ E2E_VIDEO: "true", CI: "true" })).toBe("on-first-retry");
  });
});

describe("evidenceUse", () => {
  it("keeps trace and screenshot on failure and sizes video explicitly", () => {
    expect(evidenceUse({ CI: "true" })).toEqual({
      trace: "retain-on-failure",
      screenshot: "only-on-failure",
      video: { mode: "on-first-retry", size: { width: 1280, height: 720 } },
    });
    expect(VIDEO_SIZE).toEqual({ width: 1280, height: 720 });
  });
});

describe("playwright config wiring", () => {
  it("spreads the shared profile into baseUse", () => {
    expect(read("playwright.config.ts")).toMatch(/export const baseUse = \{\n[^\n]*\n  \.\.\.evidenceUse\(\),\n\} as const;/);
  });

  it("lets the docker lane inherit video through baseUse only", () => {
    const docker = read("playwright.docker.config.ts");
    expect(docker).toContain("use: { ...baseUse }");
    expect(docker).not.toMatch(/\bvideo\b/);
  });

  it("gives the preview lane the profile and an HTML report without E2E setup", async () => {
    expect(read("playwright.preview.config.ts")).not.toMatch(/from "\.\/playwright\.config/);

    const { default: preview } = await import("../playwright.preview.config.js");

    expect(preview.use).toMatchObject(evidenceUse());
    expect(preview.reporter).toContainEqual([
      "html",
      { open: "never", outputFolder: "playwright-report/preview" },
    ]);
  });
});
