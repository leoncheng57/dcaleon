import { expect, test } from "@playwright/test";

for (const width of [320, 390, 1440]) {
  test(`design gallery is usable in the public simulator at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    const featureRequests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (/\/api\/(browser|minichats|terminal)\//.test(request.url())) featureRequests.push(request.url());
    });
    await page.goto("./#/design-components");
    await expect(page.getByTestId("opencode-design-components")).toBeVisible();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: testInfo.outputPath(`gallery-${width}-${colorScheme}.png`) });
      await page.getByTestId("design-panel-open").click();
      const panel = page.getByTestId("design-panel");
      await expect(panel).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`panel-${width}-${colorScheme}.png`) });
      await page.getByTestId("design-panel-close").click();
      await expect(page.getByTestId("design-panel-open")).toBeFocused();
      await page.getByTestId("opencode-design-components").evaluate((element) => element.scrollTo(0, 0));
    }
    await page.reload();
    await expect(page.getByTestId("opencode-design-components")).toBeVisible();
    expect(featureRequests).toEqual([]);
    expect(errors).toEqual([]);
  });
}
