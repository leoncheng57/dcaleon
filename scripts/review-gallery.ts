import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pngDimensions, MAX_PNG_BYTES, VIEWPORTS } from "./pr-screenshots.js";
import type { ReviewScenario } from "./review-scenarios.js";

export const GALLERY_MARKER = "<!-- local-playwright-review -->";
export const THEMES = ["light", "dark"] as const;
export const GALLERY_LIMITS = { scenarios: 8, steps: 20, totalBytes: 40 * 1024 * 1024, pixels: 26_000_000, manifestBytes: 128 * 1024 };
export interface GalleryImage { scenario: string; theme: "light" | "dark"; viewport: "desktop" | "mobile"; filename: string; bytes: number; sha256: string; width: number; height: number }
export interface GalleryManifest { schemaVersion: 1; sourceSha: string; capturedAt: string; scenarios: ReviewScenario[]; images: GalleryImage[] }
export const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
export const galleryFilename = (id: string, theme: string, viewport: string): string => `${id}--${theme}--${viewport}.png`;

/** Local state files are bounded declarative data. No eval, scripts, CSS, or external URLs. */
export function validateScenarios(raw: unknown): ReviewScenario[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > GALLERY_LIMITS.scenarios) throw new Error("request must contain 1–8 scenarios");
  const ids = new Set<string>();
  const testid = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(value);
  return raw.map(item => {
    if (!item || typeof item !== "object" || !/^[a-z][a-z0-9-]{0,59}$/.test(item.id) || ids.has(item.id)) throw new Error("invalid or duplicate scenario id");
    ids.add(item.id);
    if (typeof item.title !== "string" || !item.title.trim() || item.title.length > 160) throw new Error("invalid scenario title");
    if (typeof item.route !== "string" || item.route.length > 2048 || !item.route.startsWith("/") || item.route.startsWith("//")) throw new Error("scenario route must be local");
    let decoded = item.route;
    for (let i = 0; i < 5; i++) { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; }
    if (/[\s\\\u0000-\u001f\u007f]/u.test(decoded) || decoded.startsWith("//") || decoded.split(/[?#]/)[0].split("/").some((s: string) => s === "." || s === "..")) throw new Error("unsafe scenario route");
    if (new URL(item.route, "http://review.invalid").origin !== "http://review.invalid") throw new Error("external scenario route");
    if (item.target !== undefined && !testid(item.target)) throw new Error("invalid target testid");
    if (!Array.isArray(item.steps) || !item.steps.length || item.steps.length > GALLERY_LIMITS.steps) throw new Error("scenario needs 1–20 steps, including a settled-state assertion");
    const steps = item.steps.map((step: Record<string, unknown>) => {
      if (!step || !testid(step.testId) || !["click", "fill", "visible", "text"].includes(String(step.action))) throw new Error("unknown interaction or testid");
      if (["fill", "text"].includes(String(step.action)) && (typeof step.value !== "string" || !step.value.length || step.value.length > 2000)) throw new Error("interaction needs a bounded value");
      return { testId: step.testId, action: step.action, ...(typeof step.value === "string" ? { value: step.value } : {}) };
    });
    if (!["visible", "text"].includes(steps.at(-1).action)) throw new Error("last step must assert settled content, empty state, or alert");
    return { id: item.id, title: item.title, route: item.route, steps, ...(item.target ? { target: item.target } : {}) } as ReviewScenario;
  });
}

export function createGalleryManifest(directory: string, sourceSha: string, rawScenarios: unknown): GalleryManifest {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error("source SHA must identify a commit");
  const scenarios = validateScenarios(rawScenarios);
  const images: GalleryImage[] = [];
  let total = 0;
  for (const scenario of scenarios) for (const theme of THEMES) for (const viewport of ["desktop", "mobile"] as const) {
    const filename = galleryFilename(scenario.id, theme, viewport);
    const file = path.join(directory, filename);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PNG_BYTES) throw new Error("image must be a bounded regular file");
    const bytes = readFileSync(file);
    total += bytes.length;
    const { width, height } = pngDimensions(bytes);
    if (width < 1 || height < 1 || width > VIEWPORTS[viewport].width || height > 20_000 || width * height > GALLERY_LIMITS.pixels || total > GALLERY_LIMITS.totalBytes) throw new Error("gallery dimensions or bytes exceed limits");
    images.push({ scenario: scenario.id, theme, viewport, filename, bytes: bytes.length, sha256: digest(bytes), width, height });
  }
  return { schemaVersion: 1, sourceSha, capturedAt: new Date().toISOString(), scenarios, images };
}

/** Reconstruct expected filenames; never use an artifact's path as an upload target. */
export function validateGallery(directory: string, expectedSha: string): GalleryManifest {
  if (lstatSync(directory).isSymbolicLink()) throw new Error("gallery directory cannot be a symlink");
  const file = path.join(directory, "manifest.json");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > GALLERY_LIMITS.manifestBytes) throw new Error("invalid manifest file");
  const raw = JSON.parse(readFileSync(file, "utf8")) as GalleryManifest;
  if (raw.schemaVersion !== 1 || raw.sourceSha !== expectedSha || !Number.isFinite(Date.parse(raw.capturedAt))) throw new Error("gallery source identity mismatch");
  const actual = createGalleryManifest(directory, expectedSha, raw.scenarios);
  if (JSON.stringify(actual.images) !== JSON.stringify(raw.images)) throw new Error("gallery image metadata mismatch");
  const expected = new Set(["manifest.json", ...actual.images.map(i => i.filename)]);
  if (readdirSync(directory).some(name => !expected.has(name)) || readdirSync(directory).length !== expected.size) throw new Error("unexpected gallery files");
  return raw;
}

const html = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export function galleryComment(manifest: GalleryManifest, urls: Record<string, string>, branch: string): string {
  const lines = [GALLERY_MARKER, "## Playwright review gallery", "", `Source commit: \`${manifest.sourceSha}\` · ${manifest.capturedAt}`, "", "Deterministic mock data. Appearance evidence, not a claim that all interactions pass.", ""];
  for (const scenario of manifest.scenarios) {
    lines.push(`### ${html(scenario.title)}`, "", `<code>${html(scenario.route)}</code>`, "", "| Appearance | Desktop | Mobile |", "| --- | --- | --- |");
    for (const theme of THEMES) {
      const cells = ["desktop", "mobile"].map(viewport => {
        const url = urls[galleryFilename(scenario.id, theme, viewport)];
        if (!url || !/^https:\/\/raw\.githubusercontent\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[a-f0-9]{40}\//.test(url)) throw new Error("gallery needs immutable public image URLs");
        return `<a href="${html(url)}"><img src="${html(url)}" width="${viewport === "desktop" ? 500 : 220}" alt="${html(`${scenario.title} — ${theme} ${viewport}`)}" /></a>`;
      });
      lines.push(`| ${theme} | ${cells.join(" | ")} |`);
    }
    lines.push("");
  }
  lines.push(`Assets retained on \`${branch}\` for review history. This branch is intentionally NOT deleted by Pages cleanup. Explicitly delete it only when this evidence is no longer needed; SHA URLs are not guaranteed after Git garbage collection.`, "", "New commits require a new local gallery. Compare the source SHA above with the PR head; automatic CI evidence has a separate comment.");
  return lines.join("\n");
}
