import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isMermaidClassName, isSafeHref, linkAttributes } from "../client/ds/markdown.js";
import { DOCS, getDoc, rewriteDocLinks } from "../client/lib/docs.js";
import { MANAGED_CHILD_AGENT_IDS } from "../server/opencode/sessions.js";

describe("documentation catalogue", () => {
  it("uses unique slugs and source paths", () => {
    expect(new Set(DOCS.map((doc) => doc.slug)).size).toBe(DOCS.length);
    expect(new Set(DOCS.map((doc) => doc.sourcePath)).size).toBe(DOCS.length);
    expect(getDoc("architecture")?.sourcePath).toBe("docs/architecture.md");
    expect(getDoc("pr-previews")?.sourcePath).toBe("docs/pr-previews.md");
    expect(getDoc("missing")).toBeUndefined();
  });

  it("catalogues the sub-agent guide under architecture", () => {
    const doc = getDoc("subagents");
    expect(doc?.sourcePath).toBe("docs/subagents.md");
    expect(doc?.category).toBe("architecture");
  });

  it("keeps the capability matrix in step with the retained Managed Child agents", () => {
    const markdown = readFileSync(
      fileURLToPath(new URL("../docs/subagents.md", import.meta.url)),
      "utf8",
    );
    const matrixRows = markdown
      .split("\n")
      .filter((line) => /^\|\s*`[a-z-]+`\s*\|/u.test(line))
      .map((line) => /^\|\s*`([a-z-]+)`\s*\|/u.exec(line)?.[1]);
    expect(matrixRows).toEqual([...MANAGED_CHILD_AGENT_IDS]);
  });

  it("routes catalogued relative links in-app and unknown files to GitHub", () => {
    const source = [
      "[Contributing](../CONTRIBUTING.md)",
      "[Audit](opencode-1.18.21-api-audit.md#result)",
      "[Previews](pr-previews.md#artifact-trust-boundary)",
      "[Implementation](internal/detail.md)",
      "[External](https://example.com/docs)",
    ].join("\n");

    expect(rewriteDocLinks(source, "docs/architecture.md")).toBe([
      "[Contributing](/docs/contributing)",
      "[Audit](/docs/opencode-api-audit#result)",
      "[Previews](/docs/pr-previews#artifact-trust-boundary)",
      "[Implementation](https://github.com/leoncheng57/dcaleon/blob/main/docs/internal/detail.md)",
      "[External](https://example.com/docs)",
    ].join("\n"));
  });

  it("publishes the complete PR preview diagram and stub guide", async () => {
    const source = await getDoc("pr-previews")!.load();
    expect(source.match(/```mermaid/gu)).toHaveLength(6);
    expect(source).toContain("## Per-commit deployment flow");
    expect(source).toContain("## Shared publication concurrency");
    expect(source).toContain("## Changed files and responsibilities");
    expect(source).toContain("## BFF simulator request flow");
    expect(source).toContain("### Stubbed endpoint families");
    expect(source).toContain("## Close cleanup flow");
  });
});

describe("documentation markdown links", () => {
  it("recognizes only Mermaid fenced-code language classes", () => {
    expect(isMermaidClassName("language-mermaid")).toBe(true);
    expect(isMermaidClassName("language-mermaid hljs")).toBe(true);
    expect(isMermaidClassName("language-text")).toBe(false);
    expect(isMermaidClassName(undefined)).toBe(false);
  });

  it("keeps app links in this tab without changing external link behavior", () => {
    expect(linkAttributes("/docs/architecture", true)).toEqual({});
    expect(linkAttributes("#result", true)).toEqual({});
    expect(linkAttributes("https://example.com", true)).toEqual({ target: "_blank", rel: "noreferrer" });
    // Without the opt-in even an in-app target opens in a new tab, which is
    // what every other markdown surface still does.
    expect(linkAttributes("/docs/architecture")).toEqual({ target: "_blank", rel: "noreferrer" });
  });

  it("permits only navigable link protocols", () => {
    expect(isSafeHref("https://example.com")).toBe(true);
    expect(isSafeHref("mailto:someone@example.com")).toBe(true);
    expect(isSafeHref("/docs/architecture")).toBe(true);
    expect(isSafeHref("docs/architecture.md")).toBe(true);
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("  javascript:alert(1)")).toBe(false);
    expect(isSafeHref("data:text/html,<script>")).toBe(false);
  });
});
