import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createGalleryManifest, galleryComment, galleryFilename, validateGallery, validateScenarios, GALLERY_MARKER } from "../scripts/review-gallery.js";
import { reviewScenario, selectReviewScenarios } from "../scripts/review-scenarios.js";
import { assertAssetPushSafe, assertPublishTarget, publishGallery, updateGalleryComment } from "../scripts/review-github.js";
import { createManifest, normalizeScreenshotRequests, parseScreenshotBlock, validateAndPublishBundle } from "../scripts/pr-screenshots.js";

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const sha = "a".repeat(40);
const scenario = reviewScenario("hub-projects");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/eYAAAAASUVORK5CYII=", "base64");
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "review-gallery-test-")); temporary.push(directory);
  for (const theme of ["light", "dark"]) for (const viewport of ["desktop", "mobile"]) writeFileSync(path.join(directory, galleryFilename(scenario.id, theme, viewport)), png);
  const manifest = createGalleryManifest(directory, sha, [scenario]);
  writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  return { directory, manifest };
}

describe("review coverage", () => {
  it("skips docs, covers page changes and flags shared components for local judgment", () => {
    expect(selectReviewScenarios(["README.md", "tests/foo.test.ts"]).ids).toEqual([]);
    expect(selectReviewScenarios(["client/pages/Planning.tsx"]).ids).toEqual(["planning-page", "planning-create"]);
    expect(selectReviewScenarios(["client/pages/DesignComponents.tsx"]).ids).toEqual(["design-gallery", "design-panel"]);
    expect(validateScenarios([reviewScenario("design-gallery"), reviewScenario("design-panel")])).toHaveLength(2);
    expect(selectReviewScenarios(["client/ds/button.tsx"])).toMatchObject({ ids: ["hub-projects", "session-todo"], needsLocalReview: true });
    expect(selectReviewScenarios(["server/new-feature.ts"]).needsLocalReview).toBe(true);
  });
  it("permits curated scenarios in the existing block, alongside route captures", () => {
    const { requests } = parseScreenshotBlock("```screenshots\nscenario:hub-projects\n/opencode?directory=/tmp/mock-project\n```");
    expect(requests).toHaveLength(2);
    expect(requests[0].scenarioId).toBe("hub-projects");
    expect(() => parseScreenshotBlock("```screenshots\nscenario:unknown\n```")).toThrow("unknown review scenario");
    expect(() => normalizeScreenshotRequests([{ scenarioId: "hub-projects", requestedRoute: "/settings" }])).toThrow("trusted catalogue");
  });
  it.each(["//evil.test", "/%2fexample.com", "/foo/../bar", "/foo/%252e%252e/bar", "/foo\\bar", "https://evil.test", "/foo%0abar"])("rejects unsafe local state route %s", route => {
    expect(() => validateScenarios([{ ...scenario, route }])).toThrow();
  });
  it("rejects unknown actions, duplicate IDs, missing final assertions, and unsafe locators", () => {
    expect(() => validateScenarios([scenario, scenario])).toThrow("duplicate");
    expect(() => validateScenarios([{ ...scenario, steps: [{ action: "eval", testId: "body" }] }])).toThrow("unknown");
    expect(() => validateScenarios([{ ...scenario, steps: [{ action: "click", testId: "button" }] }])).toThrow("last step");
    expect(() => validateScenarios([{ ...scenario, target: 'a"]' }])).toThrow("target");
    expect(validateScenarios([{ ...scenario, steps: [{ action: "text", testId: "refusal", value: "Access denied" }] }])).toHaveLength(1);
  });
});

describe("gallery artifact validation", () => {
  it("accepts exact inventory and rejects stale, modified, extra and linked files", () => {
    const { directory } = fixture();
    expect(validateGallery(directory, sha).images).toHaveLength(4);
    expect(() => validateGallery(directory, "b".repeat(40))).toThrow("identity");
    writeFileSync(path.join(directory, "unlisted.txt"), "unlisted");
    expect(() => validateGallery(directory, sha)).toThrow("unexpected");
    rmSync(path.join(directory, "unlisted.txt"));
    const file = path.join(directory, "hub-projects--light--desktop.png");
    writeFileSync(file, Buffer.concat([png, Buffer.from("tampered")]));
    expect(() => validateGallery(directory, sha)).toThrow("metadata");
    rmSync(file); symlinkSync(path.join(directory, "hub-projects--dark--desktop.png"), file);
    expect(() => validateGallery(directory, sha)).toThrow("regular file");
  });
  it("trusted CI validation recognizes element dimensions only for known scenarios", () => {
    const { directory } = fixture();
    for (const entry of JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8")).images) rmSync(path.join(directory, entry.filename));
    const requests = normalizeScreenshotRequests([{ scenarioId: "hub-projects" }]);
    for (const filename of Object.values(requests[0].filenames)) writeFileSync(path.join(directory, filename), png);
    const manifest = createManifest(directory, requests, 123, sha);
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
    const dest = `${directory}-published`; temporary.push(dest);
    expect(validateAndPublishBundle(directory, dest, 123, sha).screenshots[0].scenarioId).toBe("hub-projects");
    manifest.screenshots[0].scenarioId = "untrusted-new-route";
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
    expect(() => validateAndPublishBundle(directory, dest, 123, sha)).toThrow("unknown");
  });
  it("escapes labels and requires immutable HTML image links", () => {
    const { manifest } = fixture();
    manifest.scenarios[0].title = '<img src="attack">';
    const urls = Object.fromEntries(manifest.images.map(i => [i.filename, `https://raw.githubusercontent.com/o/r/${sha}/${i.filename}`]));
    const comment = galleryComment(manifest, urls, "artifacts/pr-123-review");
    expect(comment).toContain("&lt;img");
    expect(comment).not.toContain('<img src="attack">');
    expect(comment.match(/<img /g)).toHaveLength(4);
    expect(() => galleryComment(manifest, {}, "branch")).toThrow("immutable");
  });
});

describe("local publisher safety and lifecycle", () => {
  const repo = "owner/repo";
  function fake() {
    const calls: Array<{ endpoint: string; method: string; payload: any }> = [];
    let head = sha;
    const api = async (endpoint: string, method = "GET", payload?: any) => {
      calls.push({ endpoint, method, payload });
      if (endpoint === "user") return { id: 1 };
      if (endpoint.endsWith("/pulls/123")) return { state: "open", head: { sha: head, repo: { full_name: repo } } };
      if (endpoint === `repos/${repo}`) return { private: false, default_branch: "main" };
      if (endpoint.includes("/comments?")) return [{ id: 77, user: { id: 1 }, body: `${GALLERY_MARKER}\nOld images` }, { id: 88, user: { id: 99 }, body: GALLERY_MARKER }];
      if (endpoint.includes("/.github/workflows?")) return [{ type: "file", name: "ci.yml" }];
      if (endpoint.includes("/.github/workflows/ci.yml")) return { encoding: "base64", content: Buffer.from("on:\n  push:\n    branches: [main]\n").toString("base64") };
      if (method === "PUT") return { commit: { sha: "b".repeat(40) } };
      if (endpoint.includes("/contents/")) return { sha: "existing" };
      return {};
    };
    return { calls, api, setHead: (value: string) => { head = value; } };
  }
  it("updates only the actor-owned marker after every URL is verified", async () => {
    const { directory } = fixture(); const mock = fake(); const verified: string[] = [];
    await publishGallery({ directory, repository: repo, pr: 123, sha, api: mock.api, verifyUrl: async url => { verified.push(url); } });
    expect(verified).toHaveLength(4);
    expect(mock.calls.filter(c => c.method === "PUT")).toHaveLength(4);
    expect(mock.calls.at(-1)).toMatchObject({ endpoint: `repos/${repo}/issues/comments/77`, method: "PATCH" });
    expect(mock.calls.at(-1)!.payload.body).toContain('<img src=');
    expect(mock.calls.some(c => c.endpoint.includes("gh-pages"))).toBe(false);
  });
  it("does not post partial galleries or publish stale captures", async () => {
    const { directory } = fixture(); const mock = fake();
    await expect(publishGallery({ directory, repository: repo, pr: 123, sha, api: mock.api, verifyUrl: async () => { throw new Error("unavailable image"); } })).rejects.toThrow("unavailable");
    expect(mock.calls.some(c => c.method === "PATCH")).toBe(false);
    mock.setHead("c".repeat(40));
    await expect(updateGalleryComment(mock.api, repo, 123, sha, "new")).rejects.toThrow("stale");
  });
  it("rechecks the PR head after upload", async () => {
    const { directory } = fixture(); const mock = fake();
    await expect(publishGallery({ directory, repository: repo, pr: 123, sha, api: mock.api, verifyUrl: async () => { mock.setHead("c".repeat(40)); } })).rejects.toThrow("stale");
    expect(mock.calls.some(c => c.method === "PATCH")).toBe(false);
  });
  it("refuses forks, private repositories and closed PRs before writes", async () => {
    for (const kind of ["fork", "private", "closed"]) {
      const api = async (endpoint: string) => endpoint.endsWith("/pulls/123") ? { state: kind === "closed" ? "closed" : "open", head: { sha, repo: { full_name: kind === "fork" ? "other/fork" : repo } } } : { private: kind === "private" };
      await expect(assertPublishTarget(api, repo, 123, sha)).rejects.toThrow();
    }
  });
  it("structurally verifies asset push triggers and read-only CI permission separation", () => {
    expect(() => assertAssetPushSafe("on: [push, pull_request]")).toThrow();
    expect(() => assertAssetPushSafe("on:\n  push:\n    branches: ['**']")).toThrow();
    expect(() => assertAssetPushSafe("on:\n  push:\n    paths: ['**/*.png']")).toThrow();
    expect(() => assertAssetPushSafe("on:\n  push:\n    branches: [main]")).not.toThrow();
    const workflow = parse(readFileSync(new URL("../.github/workflows/pr-screenshots.yml", import.meta.url), "utf8"));
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.on.pull_request).toBeDefined();
    expect(workflow.on.pull_request_target).toBeUndefined();
    expect(workflow.concurrency["cancel-in-progress"]).toBe(true);
  });
});
