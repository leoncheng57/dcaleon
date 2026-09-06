import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "@playwright/test";

import { VIEWPORTS, type ScreenshotViewport } from "./pr-screenshots.js";

function option(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

const input = option("--input");
if (!input || !input.endsWith(".html")) throw new Error("provide --input <path-to-mockup.html>");
const inputPath = path.resolve(input);

const out = path.resolve(option("--out", input.replace(/\.html$/, ".png"))!);
const theme = option("--theme");
if (theme && theme !== "light" && theme !== "dark") throw new Error("--theme must be light or dark");

const selector = option("--selector");
const viewportName = option("--viewport") as ScreenshotViewport | undefined;
if (viewportName && !(viewportName in VIEWPORTS)) throw new Error(`--viewport must be one of ${Object.keys(VIEWPORTS).join(", ")}`);
const width = Number(option("--width", String(viewportName ? VIEWPORTS[viewportName].width : VIEWPORTS.desktop.width)));
const height = Number(option("--height", String(viewportName ? VIEWPORTS[viewportName].height : VIEWPORTS.desktop.height)));
const fullPage = flag("--full-page");

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(pathToFileURL(inputPath).href);
  if (theme) await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
  await page.evaluate(() => document.fonts.ready);

  mkdirSync(path.dirname(out), { recursive: true });
  const target = selector ? page.locator(selector) : page.locator("#mockup-root");
  if (selector || (await target.count()) > 0) {
    await target.screenshot({ path: out });
  } else {
    await page.screenshot({ path: out, fullPage });
  }
} finally {
  await browser.close();
}

console.log(`Wrote ${out}`);
