import { expect, test, type Page, type Route } from "@playwright/test";

const RIGHT_TOOLS_DIR = process.platform === "darwin"
  ? "/private/tmp/mock-right-tools-project"
  : "/tmp/mock-right-tools-project";
const conversation = `/sessions/ses_mock_right_tools?directory=${encodeURIComponent(RIGHT_TOOLS_DIR)}`;
const FRAME = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

interface BrowserFixture {
  inputs: Array<Record<string, unknown>>;
  requests: string[];
}

async function mockBrowser(page: Page): Promise<BrowserFixture> {
  const fixture: BrowserFixture = { inputs: [], requests: [] };
  let url = "https://example.com/";
  const state = () => ({
    sessionID: "ses_mock_right_tools",
    url,
    title: "Example Domain",
    canGoBack: false,
    canGoForward: false,
    loading: false,
    pendingPopup: null,
  });
  await page.route("**/api/browser/**", async (route: Route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    fixture.requests.push(`${request.method()} ${pathname}`);
    if (pathname.endsWith("/stream")) {
      await route.fulfill({ status: 200, contentType: "image/png", body: FRAME });
      return;
    }
    if (pathname.endsWith("/input")) {
      fixture.inputs.push(request.postDataJSON() as Record<string, unknown>);
      await route.fulfill({ status: 204 });
      return;
    }
    if (pathname.endsWith("/navigate")) {
      const body = request.postDataJSON() as { action: string; url?: string };
      if (body.action === "goto" && body.url) url = body.url.startsWith("http") ? body.url : `https://${body.url}`;
      await route.fulfill({ json: state() });
      return;
    }
    if (request.method() === "DELETE") {
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({ json: state() });
  });
  return fixture;
}

test.describe("desktop right tools panel", () => {
  test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false });
  test("keeps the panel usable beside tall permission and question banners", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockBrowser(page);
    await page.goto("/sessions/ses_mock_done?directory=/tmp/mock-project");
    await page.getByTestId("opencode-live-browser-open").click();
    const panel = page.getByTestId("opencode-right-tools-panel");
    await expect(page.getByTestId("opencode-live-browser-frame")).toBeVisible();
    expect((await panel.boundingBox())!.height).toBeGreaterThan(240);
    await page.getByTestId("opencode-right-tools-close").click();
    await expect(page.getByTestId("opencode-session-inspector")).toBeVisible();
  });

  for (const [status, message] of [[403, "live browser is disabled"], [409, "browser page capacity reached"], [502, "Chromium unavailable"]] as const) {
    test(`keeps the selector usable after an open failure (${status})`, async ({ page }) => {
      await page.route("**/api/browser/**", (route) => route.fulfill({ status, json: { error: message } }));
      await page.goto(conversation);
      await page.getByTestId("opencode-live-browser-open").click();
      await expect(page.getByTestId("opencode-live-browser-error")).toContainText(message);
      await page.getByTestId("opencode-right-tools-selector").focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("opencode-minichats-wip")).toBeVisible();
    });
  }

  test("replaces the Inspector with an in-flow Browser and restores focus on close", async ({ page }) => {
    await mockBrowser(page);
    await page.goto(conversation);

    const inspector = page.getByTestId("opencode-session-inspector");
    const opener = page.getByTestId("opencode-live-browser-open");
    await expect(inspector).toBeVisible();
    await opener.click();

    const panel = page.getByTestId("opencode-right-tools-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("role", "complementary");
    await expect(panel).not.toHaveAttribute("aria-modal", "true");
    await expect(inspector).toBeHidden();
    await expect(page.getByTestId("opencode-live-browser-frame")).toBeVisible();
    await page.getByTestId("opencode-live-browser-frame").focus();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("opencode-live-browser-frame")).not.toBeFocused();
    expect((await panel.boundingBox())?.width).toBeCloseTo(672, 0);

    await page.getByTestId("opencode-live-browser-address").fill("example.org/docs");
    await page.getByTestId("opencode-live-browser-address").press("Enter");
    await expect(page.getByTestId("opencode-live-browser-address")).toHaveValue("https://example.org/docs");

    await page.getByTestId("opencode-right-tools-close").click();
    await expect(panel).toHaveCount(0);
    await expect(inspector).toBeVisible();
    await expect(opener).toBeFocused();
  });

  test("switches among Browser and honest WIP destinations", async ({ page }) => {
    const fixture = await mockBrowser(page);
    await page.goto(conversation);
    await page.getByTestId("opencode-live-browser-open").click();
    await expect(page.getByTestId("opencode-live-browser-frame")).toBeVisible();

    await page.getByTestId("opencode-right-tools-selector").click();
    await expect(page.getByTestId("opencode-right-tools-menu")).toBeVisible();
    await page.getByTestId("opencode-right-tools-minichats").click();
    await expect(page.getByTestId("opencode-minichats-wip")).toContainText("Work in progress");
    await expect(page.getByTestId("opencode-minichats-wip")).toContainText("Follow issue #56");
    await expect(page.getByTestId("opencode-live-browser")).toHaveCount(0);

    const requestCount = fixture.requests.length;
    await page.waitForTimeout(250);
    expect(fixture.requests).toHaveLength(requestCount);

    await page.getByTestId("opencode-right-tools-selector").click();
    await page.getByTestId("opencode-right-tools-terminal").click();
    await expect(page.getByTestId("opencode-terminal-wip")).toContainText("Follow issue #59");
    expect((await page.getByTestId("opencode-right-tools-panel").boundingBox())?.width).toBeCloseTo(448, 0);

    await page.getByTestId("opencode-right-tools-selector").click();
    await page.getByTestId("opencode-right-tools-browser").click();
    await expect(page.getByTestId("opencode-live-browser-frame")).toBeVisible();
    expect(fixture.requests.filter((request) => request.endsWith("/open"))).toHaveLength(2);
  });
});

test.describe("phone right tools panel", () => {
  test.use({ viewport: { width: 390, height: 740 }, hasTouch: true });

  test("uses a full-screen safe surface and forwards viewport, touch and text input", async ({ page }) => {
    const fixture = await mockBrowser(page);
    await page.goto(conversation);
    await page.getByTestId("opencode-live-browser-open").tap();

    const panel = page.getByTestId("opencode-right-tools-panel");
    await expect(panel).toHaveAttribute("role", "dialog");
    await expect(panel).toHaveAttribute("aria-modal", "true");
    const box = await panel.boundingBox();
    expect(box).toMatchObject({ x: 0, y: 0, width: 390, height: 740 });

    // aria-modal is backed by an actual focus boundary, not just a label.
    await expect(panel).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByTestId("opencode-live-browser-mobile-type").getByLabel("Text to type into page")).toBeFocused();

    await expect.poll(() => fixture.inputs.some((input) => input.type === "viewport")).toBe(true);
    const frameBox = await page.getByTestId("opencode-live-browser-frame").boundingBox();
    expect(frameBox).not.toBeNull();
    await page.touchscreen.tap(frameBox!.x + frameBox!.width / 2, frameBox!.y + frameBox!.height / 2);
    await expect.poll(() => fixture.inputs.some((input) => input.type === "touch" && input.phase === "start")).toBe(true);
    await expect.poll(() => fixture.inputs.some((input) => input.type === "touch" && input.phase === "end")).toBe(true);
    await page.getByTestId("opencode-live-browser-frame").dispatchEvent("wheel", { deltaY: 120, clientX: 100, clientY: 200 });
    await expect.poll(() => fixture.inputs.some((input) => input.type === "scroll")).toBe(true);
    await page.setViewportSize({ width: 430, height: 820 });
    await expect(panel).toHaveCSS("width", "430px");
    await expect.poll(() => fixture.inputs.filter((input) => input.type === "viewport").length).toBeGreaterThan(1);

    const mobileType = page.getByTestId("opencode-live-browser-mobile-type");
    await expect(mobileType).toBeVisible();
    await mobileType.getByLabel("Text to type into page").fill("hello from phone");
    await mobileType.getByRole("button", { name: "Type" }).tap();
    await expect.poll(() => fixture.inputs.some((input) => input.type === "type" && input.text === "hello from phone")).toBe(true);

    await page.getByTestId("opencode-right-tools-selector").tap();
    await page.getByTestId("opencode-right-tools-minichats").tap();
    await expect(page.getByTestId("opencode-minichats-wip")).toBeVisible();
    await page.getByTestId("opencode-right-tools-close").tap();
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId("opencode-live-browser-open")).toBeFocused();
  });
});
