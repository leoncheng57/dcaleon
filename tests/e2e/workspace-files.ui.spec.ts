import { expect, test } from "@playwright/test";

// The fixture project this file owns. It is read-only here: nothing in this
// spec mutates BFF or mock state, so it cannot flip anything under the other
// spec files Playwright runs in parallel.
//
// The realpath spelling matters. Session directories come back from the BFF
// already canonicalised, and the fixture's structured attachment embeds that
// same canonical path — a `/tmp` spelling on macOS would make the attachment
// look like it points outside the project.
const DIR = process.platform === "darwin" ? "/private/tmp/mock-files-project" : "/tmp/mock-files-project";
const conversation = `/sessions/ses_mock_files?directory=${encodeURIComponent(DIR)}`;

test.describe("workspace file references", () => {
  test.beforeEach(async ({ page }) => {
    // Permission and question fixtures are seeded per directory and owned by
    // other spec files; this one asserts on the transcript, not on banners.
    await page.route("**/api/permission-requests?**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ requests: [] }) }),
    );
    await page.route("**/api/sessions/ses_mock_files/questions?**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ requests: [] }) }),
    );
  });

  test("opens a cited line in the drawer without changing route or transcript position", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(conversation);
    await expect(page.getByTestId("opencode-agent-message")).toBeVisible();

    const reference = page.getByTestId("opencode-file-reference").filter({ hasText: "src/index.ts:12" });
    await expect(reference).toHaveAttribute("data-path", "src/index.ts");
    await expect(reference).toHaveAccessibleName("Open src/index.ts line 12 in the workspace file viewer");

    const urlBefore = page.url();
    const scrollBefore = await page.getByTestId("opencode-transcript").evaluate((element) => element.scrollTop);

    await reference.click();

    await expect(page.getByTestId("opencode-workspace-panels")).toBeVisible();
    await expect(page.getByTestId("opencode-workspace-files-panel")).toBeVisible();
    const viewer = page.getByTestId("opencode-code-viewer");
    await expect(viewer).toHaveAttribute("data-path", "src/index.ts");
    await expect(viewer).toContainText("export const DEFAULT_PORT = 3210;");
    // Line numbers come from the gutter, not from the text.
    await expect(viewer.locator(".cm-lineNumbers .cm-gutterElement").filter({ hasText: /^12$/ })).toBeVisible();
    const banded = viewer.locator(".cm-referenced-line");
    await expect(banded).toHaveCount(1);
    await expect(banded).toHaveText("export const DEFAULT_PORT = 3210;");
    await expect(page.getByTestId("opencode-file-target")).toHaveText("Showing line 12");

    // The reader keeps their place: the drawer is an overlay, not a route.
    expect(page.url()).toBe(urlBefore);
    expect(await page.getByTestId("opencode-transcript").evaluate((element) => element.scrollTop)).toBe(scrollBefore);
  });

  test("keeps the dark syntax palette distinct and readable", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("theme", "dark"));
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(conversation);
    await page.getByTestId("opencode-file-reference").filter({ hasText: "src/index.ts:12" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);

    const palette = await page.getByTestId("opencode-code-viewer").locator(".cm-content").evaluate((content) => {
      const parseColor = (value: string): [number, number, number] => {
        const hex = value.trim().match(/^#([\da-f]{6})$/i)?.[1];
        if (hex) return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)];
        const components = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
        if (!components || components.length !== 3) throw new Error(`Unsupported color: ${value}`);
        return components as [number, number, number];
      };
      const luminance = ([red, green, blue]: [number, number, number]) => {
        const channel = (value: number) => {
          const normalized = value / 255;
          return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
      };
      const rootStyle = getComputedStyle(document.documentElement);
      const background = luminance(parseColor(rootStyle.getPropertyValue("--color-background-surface")));
      const colors = [...new Set([...content.querySelectorAll("span")]
        .filter((element) => element.textContent?.trim())
        .map((element) => getComputedStyle(element).color))];
      return colors.map((color) => {
        const foreground = luminance(parseColor(color));
        return { color, contrast: (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05) };
      });
    });

    expect(palette.length).toBeGreaterThanOrEqual(5);
    expect(palette.map(({ color }) => color)).not.toContain("rgb(0, 0, 255)");
    expect(palette.map(({ color }) => color)).not.toContain("rgb(119, 0, 136)");
    for (const token of palette) expect(token.contrast, token.color).toBeGreaterThanOrEqual(4.5);
  });

  test("bands a whole cited range and re-targets an already open file", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(conversation);
    await page.getByTestId("opencode-file-reference").filter({ hasText: "src/index.ts:12" }).click();
    await expect(page.getByTestId("opencode-code-viewer").locator(".cm-referenced-line")).toHaveCount(1);

    await page.getByTestId("opencode-workspace-close").click();
    await page.getByTestId("opencode-file-reference").filter({ hasText: "src/index.ts:8-11" }).click();
    const banded = page.getByTestId("opencode-code-viewer").locator(".cm-referenced-line");
    await expect(banded).toHaveCount(4);
    await expect(banded.first()).toHaveText("export const DEFAULTS: FixtureOptions = {");
    await expect(page.getByTestId("opencode-file-target")).toHaveText("Showing lines 8 to 11");
    // Only one tab: re-targeting the same file must not open a second copy.
    await expect(page.getByTestId("opencode-file-tab")).toHaveCount(1);
  });

  test("makes only verified candidates interactive", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(conversation);
    const message = page.getByTestId("opencode-agent-message");
    await expect(message).toBeVisible();

    // Two ranges on src/index.ts, a git-style range, an explicit local link,
    // and the nested file. Everything else in the fixture stays text.
    await expect(message.getByTestId("opencode-file-reference")).toHaveCount(5);
    await expect(message.getByTestId("opencode-file-reference").filter({ hasText: "the guide" })).toHaveAttribute(
      "data-path",
      "docs/guide.md",
    );

    for (const inert of ["src/missing.ts", "../../etc/passwd", ".env", "generated.txt", "npm test", "https://example.test/src/index.ts"]) {
      await expect(message.getByTestId("opencode-file-reference").filter({ hasText: inert })).toHaveCount(0);
      await expect(message.locator("code").filter({ hasText: inert }).first()).toBeVisible();
    }

    // A path inside a fenced example is documentation, not a destination.
    const fenced = message.locator(".prose-markdown pre");
    await expect(fenced).toContainText("src/index.ts:12");
    await expect(fenced.getByTestId("opencode-file-reference")).toHaveCount(0);

    // Bare prose is never linked, even when the same path is verified above.
    await expect(message.locator("p").filter({ hasText: "A prose mention of src/index.ts" }).getByTestId("opencode-file-reference")).toHaveCount(0);
  });

  test("validates every candidate in one batched request", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const posts: Array<{ paths: string[] }> = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/api/workspace/references")) {
        posts.push(request.postDataJSON() as { paths: string[] });
      }
    });

    await page.goto(conversation);
    await expect(page.getByTestId("opencode-file-reference").first()).toBeVisible();
    await page.waitForTimeout(500);

    expect(posts).toHaveLength(1);
    // Deduplicated: src/index.ts is cited twice and attached once.
    expect(posts[0].paths.filter((path) => path === "src/index.ts")).toHaveLength(1);
    expect(posts[0].paths).toContain("docs/guide.md");
    expect(posts[0].paths).toContain("src/deep/nested.ts");
    // Rejected client-side, so the server is never asked about them.
    expect(posts[0].paths).not.toContain("../../etc/passwd");
    expect(posts[0].paths).not.toContain("npm test");
  });

  test("opens a structured attachment as a workspace file", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(conversation);
    const attachment = page.getByTestId("opencode-attachment-reference");
    await expect(attachment).toHaveAttribute("data-path", "src/index.ts");
    await attachment.click();
    await expect(page.getByTestId("opencode-code-viewer")).toHaveAttribute("data-path", "src/index.ts");
    // No line was cited, so nothing is banded.
    await expect(page.getByTestId("opencode-code-viewer").locator(".cm-referenced-line")).toHaveCount(0);
  });
});

test.describe("workspace files tab", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/permission-requests?**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ requests: [] }) }),
    );
    await page.route("**/api/sessions/ses_mock_files/questions?**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ requests: [] }) }),
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(conversation);
  });

  // `opencode-mobile-workspace-open` is the only workspace opener at every
  // breakpoint since the session actions were aligned across widths (#144);
  // the id keeps its historical name.
  test("browses lazily, keeps tabs and breadcrumbs, and marks changed files", async ({ page }) => {
    const listings: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url(), "http://127.0.0.1");
      if (url.pathname === "/api/workspace/tree") listings.push(url.searchParams.get("path") ?? "");
    });

    await page.getByTestId("opencode-mobile-workspace-open").click();
    const tree = page.getByTestId("opencode-file-tree");
    await expect(tree.getByTestId("opencode-tree-directory")).toHaveCount(3);
    await expect(tree.getByTestId("opencode-tree-file").filter({ hasText: "README.md" })).toBeVisible();
    // The BFF withholds these; they must never appear in the tree.
    await expect(tree.getByTestId("opencode-tree-file").filter({ hasText: ".env" })).toHaveCount(0);
    await expect(tree.getByTestId("opencode-tree-file").filter({ hasText: "generated.txt" })).toHaveCount(0);
    // Only the root has been listed: a tree that walked the repository would
    // spend an upstream call per directory to render three rows.
    expect(listings).toEqual([""]);

    await tree.getByTestId("opencode-tree-directory").filter({ hasText: "src" }).click();
    await expect(tree.getByTestId("opencode-tree-file").filter({ hasText: "index.ts" })).toBeVisible();
    expect(listings).toEqual(["", "src"]);
    await expect(
      tree.getByTestId("opencode-tree-file").filter({ hasText: "index.ts" }).getByTestId("opencode-file-change-indicator"),
    ).toHaveText("M");

    await tree.getByTestId("opencode-tree-file").filter({ hasText: "index.ts" }).click();
    await expect(page.getByTestId("opencode-code-viewer")).toHaveAttribute("data-path", "src/index.ts");
    await expect(page.getByTestId("opencode-file-breadcrumbs")).toContainText("src");
    await expect(page.getByTestId("opencode-breadcrumb-file")).toHaveText("index.ts");

    await tree.getByTestId("opencode-tree-file").filter({ hasText: "README.md" }).click();
    await expect(page.getByTestId("opencode-file-tab")).toHaveCount(2);
    await expect(page.getByTestId("opencode-code-viewer")).toHaveAttribute("data-path", "README.md");

    await page.getByTestId("opencode-file-tab").filter({ hasText: "index.ts" }).click();
    await expect(page.getByTestId("opencode-code-viewer")).toHaveAttribute("data-path", "src/index.ts");

    // A breadcrumb directory returns to the tree with that directory expanded.
    await page.getByTestId("opencode-breadcrumb-directory").filter({ hasText: "src" }).click();
    await expect(tree.getByTestId("opencode-tree-file").filter({ hasText: "index.ts" })).toBeVisible();

    await page.getByTestId("opencode-file-tab-close").first().click();
    await expect(page.getByTestId("opencode-file-tab")).toHaveCount(1);
  });

  test("shows file-type icons and compact rows", async ({ page }) => {
    await page.getByTestId("opencode-mobile-workspace-open").click();
    const tree = page.getByTestId("opencode-file-tree");
    const readme = tree.getByTestId("opencode-tree-file").filter({ hasText: "README.md" });
    const readmeIcon = readme.getByTestId("opencode-file-icon");
    await expect(readmeIcon).toHaveAttribute("data-kind", "markdown");
    await expect(readmeIcon).toHaveAttribute("aria-hidden", "true");
    await expect(readme).toHaveAccessibleName("README.md");
    const readmeBox = await readme.boundingBox();
    expect(readmeBox).not.toBeNull();
    expect(readmeBox!.height).toBeLessThanOrEqual(28);

    const src = tree.getByTestId("opencode-tree-directory").filter({ hasText: "src" });
    await expect(src.getByTestId("opencode-file-icon")).toHaveAttribute("data-kind", "folder");
    await src.click();
    await expect(src.getByTestId("opencode-file-icon")).toHaveAttribute("data-kind", "folder-open");
    await expect(
      tree.getByTestId("opencode-tree-file").filter({ hasText: "index.ts" }).getByTestId("opencode-file-icon"),
    ).toHaveAttribute("data-kind", "code");

    await tree.getByTestId("opencode-tree-directory").filter({ hasText: "assets" }).click();
    await expect(
      tree.getByTestId("opencode-tree-file").filter({ hasText: "logo.bin" }).getByTestId("opencode-file-icon"),
    ).toHaveAttribute("data-kind", "file");
  });

  // A flex item defaults to `min-width: auto`, so CodeMirror's intrinsic line
  // width once pushed this toolbar 93px past the drawer's edge. Nothing
  // scrolled to reveal it and the drawer clipped it silently, so `Wrap` was
  // simply unreachable — invisible to an overflow assertion on the document.
  test("keeps every viewer control inside the drawer at desktop width", async ({ page }) => {
    await page.getByTestId("opencode-mobile-workspace-open").click();
    const tree = page.getByTestId("opencode-file-tree");
    await tree.getByTestId("opencode-tree-directory").filter({ hasText: "src" }).click();
    await tree.getByTestId("opencode-tree-file").filter({ hasText: "index.ts" }).click();
    await expect(page.getByTestId("opencode-code-viewer")).toBeVisible();

    const drawerRight = await page
      .getByTestId("opencode-workspace-panels")
      .evaluate((element) => element.getBoundingClientRect().right);
    for (const id of ["opencode-copy-path", "opencode-copy-content", "opencode-code-wrap", "opencode-code-search"]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, id).not.toBeNull();
      expect(box!.x + box!.width, `${id} must stay inside the drawer`).toBeLessThanOrEqual(drawerRight + 1);
    }
    // The editor scrolls its own long lines rather than widening the pane.
    const paneOverflow = await page
      .getByTestId("opencode-file-pane")
      .evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(paneOverflow).toBeLessThanOrEqual(1);
  });

  test("filters loaded entries and states that the search is scoped", async ({ page }) => {
    await page.getByTestId("opencode-mobile-workspace-open").click();
    const tree = page.getByTestId("opencode-file-tree");
    await tree.getByTestId("opencode-tree-directory").filter({ hasText: "docs" }).click();
    await expect(tree.getByTestId("opencode-tree-file").filter({ hasText: "guide.md" })).toBeVisible();

    await page.getByTestId("opencode-file-filter").fill("guide");
    await expect(page.getByTestId("opencode-filter-results").getByTestId("opencode-tree-file")).toHaveCount(1);
    await page.getByTestId("opencode-filter-results").getByTestId("opencode-tree-file").click();
    await expect(page.getByTestId("opencode-code-viewer")).toHaveAttribute("data-path", "docs/guide.md");

    await page.getByTestId("opencode-file-filter").fill("nothing-here");
    await expect(page.getByTestId("opencode-filter-empty")).toContainText("Expand more directories");
  });

  test("reports a file that cannot be read instead of rendering an empty viewer", async ({ page }) => {
    await page.route("**/api/workspace/file?**", (route) => {
      const path = new URL(route.request().url()).searchParams.get("path");
      return path === "README.md"
        ? route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "workspace path not found" }) })
        : route.fallback();
    });

    await page.getByTestId("opencode-mobile-workspace-open").click();
    await page.getByTestId("opencode-file-tree").getByTestId("opencode-tree-file").filter({ hasText: "README.md" }).click();
    await expect(page.getByTestId("opencode-file-error")).toContainText("Could not open README.md");
    await expect(page.getByTestId("opencode-code-viewer")).toHaveCount(0);
  });

  test("says so rather than rendering a binary file", async ({ page }) => {
    await page.getByTestId("opencode-mobile-workspace-open").click();
    const tree = page.getByTestId("opencode-file-tree");
    await tree.getByTestId("opencode-tree-directory").filter({ hasText: "assets" }).click();
    await tree.getByTestId("opencode-tree-file").filter({ hasText: "logo.bin" }).click();
    await expect(page.getByTestId("opencode-file-binary")).toContainText("Binary file");
    await expect(page.getByTestId("opencode-code-viewer")).toHaveCount(0);
  });

  test("keeps Changes and Preview working alongside the new Files tab", async ({ page }) => {
    await page.getByTestId("opencode-mobile-workspace-open").click();
    await page.getByTestId("opencode-workspace-changes").click();
    await expect(page.getByTestId("opencode-diff-viewer")).toContainText("+new");
    await page.getByTestId("opencode-workspace-preview").click();
    await expect(page.getByTestId("opencode-preview-frame")).toBeVisible();
    // Returning to Files keeps the tab mounted rather than rebuilding it.
    await page.getByTestId("opencode-workspace-files").click();
    await expect(page.getByTestId("opencode-file-tree")).toBeVisible();
  });
});

test.describe("workspace files on a phone", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/permission-requests?**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ requests: [] }) }),
    );
    await page.route("**/api/sessions/ses_mock_files/questions?**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ requests: [] }) }),
    );
    await page.setViewportSize({ width: 390, height: 740 });
  });

  test("keeps file rows reachable and shows their icons", async ({ page }) => {
    await page.goto(conversation);
    await page.getByTestId("opencode-mobile-workspace-open").click();

    const readme = page
      .getByTestId("opencode-file-tree")
      .getByTestId("opencode-tree-file")
      .filter({ hasText: "README.md" });
    const box = await readme.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await expect(readme.getByTestId("opencode-file-icon")).toBeVisible();
  });

  test("moves between Tree and File with an accessible back action", async ({ page }) => {
    await page.goto(conversation);
    await page.getByTestId("opencode-mobile-workspace-open").click();
    // A phone starts on the tree: a two-column split at 390px gives neither
    // pane enough width to read.
    await expect(page.getByTestId("opencode-file-tree")).toBeVisible();
    await expect(page.getByTestId("opencode-file-pane")).toBeHidden();

    await page.getByTestId("opencode-file-tree").getByTestId("opencode-tree-directory").filter({ hasText: "docs" }).click();
    await page.getByTestId("opencode-file-tree").getByTestId("opencode-tree-file").filter({ hasText: "guide.md" }).click();
    await expect(page.getByTestId("opencode-file-pane")).toBeVisible();
    await expect(page.getByTestId("opencode-file-tree")).toBeHidden();
    await expect(page.getByTestId("opencode-code-viewer")).toContainText("Fixture guide");

    const back = page.getByTestId("opencode-files-back");
    await expect(back).toBeVisible();
    await back.click();
    await expect(page.getByTestId("opencode-file-tree")).toBeVisible();
    await expect(page.getByTestId("opencode-file-pane")).toBeHidden();

    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });

  test("follows a transcript reference straight to the file view", async ({ page }) => {
    await page.goto(conversation);
    const reference = page.getByTestId("opencode-file-reference").filter({ hasText: "src/index.ts:12" });
    await reference.scrollIntoViewIfNeeded();
    await reference.click();

    await expect(page.getByTestId("opencode-file-pane")).toBeVisible();
    await expect(page.getByTestId("opencode-file-tree")).toBeHidden();
    await expect(page.getByTestId("opencode-code-viewer").locator(".cm-referenced-line")).toHaveText(
      "export const DEFAULT_PORT = 3210;",
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });
});
