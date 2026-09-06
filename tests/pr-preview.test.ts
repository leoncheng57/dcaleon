import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";

import { packagePreview, validatePreviewBundle } from "../scripts/pr-preview.js";

const roots: string[] = [];
const SHA = "a".repeat(40);

function fixture(): { root: string; build: string; bundle: string } {
  const root = mkdtempSync(path.join(tmpdir(), "custom-dca-preview-"));
  roots.push(root);
  const build = path.join(root, "build");
  const bundle = path.join(root, "bundle");
  mkdirSync(path.join(build, "assets"), { recursive: true });
  writeFileSync(path.join(build, "index.html"), "<main>preview</main>");
  writeFileSync(path.join(build, "assets", "app.js"), "console.log('preview')");
  return { root, build, bundle };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PR preview bundles", () => {
  it("packages and validates an exact PR/SHA-scoped inventory", () => {
    const { build, bundle } = fixture();
    const manifest = packagePreview(build, bundle, 112, SHA, "/dcaleon/pr-previews/pr-112/");
    expect(manifest.files.map((file) => file.path)).toEqual(["assets/app.js", "index.html"]);
    expect(validatePreviewBundle(bundle, 112, SHA)).toEqual(manifest);
  });

  it("rejects tampered bytes and workflow identity mismatches", () => {
    const { build, bundle } = fixture();
    packagePreview(build, bundle, 112, SHA, "/dcaleon/pr-previews/pr-112/");
    writeFileSync(path.join(bundle, "site", "assets", "app.js"), "tampered");
    expect(() => validatePreviewBundle(bundle, 112, SHA)).toThrow("signed manifest inventory");
    expect(() => validatePreviewBundle(bundle, 113, SHA)).toThrow("identity");
  });

  it("rejects symlinks and a base path belonging to another PR", () => {
    const { root, build, bundle } = fixture();
    symlinkSync(path.join(build, "index.html"), path.join(build, "linked.html"));
    expect(() => packagePreview(build, bundle, 112, SHA, "/dcaleon/pr-previews/pr-112/"))
      .toThrow("symbolic link");
    rmSync(path.join(build, "linked.html"));
    expect(() => packagePreview(build, bundle, 112, SHA, "/dcaleon/pr-previews/pr-999/"))
      .toThrow("base path");
    expect(readFileSync(path.join(root, "build", "index.html"), "utf8")).toContain("preview");
  });
});
