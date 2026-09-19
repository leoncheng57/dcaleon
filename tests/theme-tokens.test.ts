// tests/theme-tokens.test.ts
//
// Guards the two properties the paper theme (issue #518) was accepted on, by
// parsing the *shipped* `client/theme/tokens.css` rather than a copy of its
// values — a duplicated palette would drift from the file it claims to check.
//
// 1. Contrast. Light mode moved off #ffffff onto a warm beige field, which
//    raises the luminance floor under every foreground at once. "It looked
//    fine" is not a check, and the regression is silent: a token nudged a
//    shade lighter still renders, just below AA. So every text token is
//    asserted against every surface it can actually land on, including the
//    translucent `--color-background-muted` chip composited over each of them.
//
// 2. The file's own stated rule — every `:root` token has a `.dark`
//    counterpart. That rule was previously enforced by reading the file
//    carefully, which is exactly the kind of enforcement that lapses under a
//    palette-wide edit.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const TOKENS_CSS = path.resolve(__dirname, "../client/theme/tokens.css");

/** WCAG 2.1 minimum for body text. */
const AA_TEXT = 4.5;
/** WCAG 2.1 minimum for UI components and focus indicators (1.4.11). */
const AA_NON_TEXT = 3;

type Rgb = readonly [number, number, number];

/** Parse the declarations of one top-level block (`:root` or `.dark`). */
function readBlock(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in tokens.css`);
  const end = css.indexOf("\n}", start);
  const body = css.slice(start, end);
  const tokens = new Map<string, string>();
  for (const [, name, value] of body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) {
    tokens.set(name, value.trim());
  }
  return tokens;
}

function hexToRgb(hex: string): Rgb {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ] as const;
}

function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Composite `color-mix(in oklab, <ink> P%, transparent)` over an opaque
 * background. Mixing an opaque colour with `transparent` yields that colour at
 * alpha P, whatever the interpolation space, and the browser then composites
 * it over the backdrop in sRGB — so the space does not affect the result and
 * a plain source-over is exact.
 */
function mixOver(ink: Rgb, percent: number, backdrop: Rgb): Rgb {
  const a = percent / 100;
  return [0, 1, 2].map((i) => Math.round(ink[i] * a + backdrop[i] * (1 - a))) as unknown as Rgb;
}

const css = readFileSync(TOKENS_CSS, "utf8");
const root = readBlock(css, ":root");
const dark = readBlock(css, ".dark");

/** Resolve a token to RGB, following one level of `var()` indirection. */
function color(tokens: Map<string, string>, name: string): Rgb {
  const raw = tokens.get(name);
  if (!raw) throw new Error(`missing token ${name}`);
  const indirect = /^var\((--[\w-]+)\)$/.exec(raw);
  if (indirect) return color(tokens, indirect[1]);
  if (!raw.startsWith("#")) throw new Error(`token ${name} is not a hex color: ${raw}`);
  return hexToRgb(raw);
}

describe("tokens.css structure", () => {
  // The file's rule is about values that *depend on appearance*. A radius does
  // not, and duplicating it into `.dark` would invite the two to disagree, so
  // the geometry tokens are excluded by name rather than by pattern.
  const APPEARANCE_INDEPENDENT = new Set(["--border-radius-8", "--border-radius-12"]);

  it("gives every appearance-dependent :root token a .dark counterpart", () => {
    const missing = [...root.keys()].filter(
      (name) => !dark.has(name) && !APPEARANCE_INDEPENDENT.has(name),
    );
    expect(missing).toEqual([]);
  });

  it("defines no .dark token that :root does not", () => {
    // The reverse direction matters too: a dark-only token is a value with no
    // light equivalent, which renders as `unset` for half the users.
    const orphans = [...dark.keys()].filter((name) => !root.has(name));
    expect(orphans).toEqual([]);
  });

  it("keeps the light accent green, with no orange in the palette", () => {
    // Issue #518 is explicit that the warm field must not arrive with Claude's
    // orange accent. Hue is the check, not a hex allowlist: "no orange" has to
    // survive someone picking a different shade of the same wrong colour.
    const accents = [
      "--color-background-action-primary",
      "--color-background-action-primary-hover",
      "--color-border-focus",
      "--color-text-success",
    ];
    for (const name of accents) {
      const [r, g, b] = color(root, name);
      expect(g, `${name} should be green-dominant`).toBeGreaterThan(r);
      expect(g, `${name} should be green-dominant`).toBeGreaterThan(b);
    }
  });
});

/**
 * Surfaces a foreground can land on, per appearance. `--color-background-muted`
 * is translucent, so it contributes one composited surface per opaque surface
 * it can sit on rather than a single colour of its own.
 */
function surfacesFor(tokens: Map<string, string>, mixPercent: number): Map<string, Rgb> {
  const opaque: Record<string, string> = {
    surface: "--color-background-surface",
    raised: "--color-background-surface-raised",
    "neutral-muted": "--color-background-surface-neutral-muted",
    "row-hover": "--hh-row-hover",
    "info-muted": "--color-background-surface-info-muted",
    "success-muted": "--color-background-surface-success-muted",
    "warning-muted": "--color-background-surface-warning-muted",
    "danger-muted": "--color-background-surface-danger-muted",
  };
  const all = new Map<string, Rgb>();
  for (const [label, token] of Object.entries(opaque)) all.set(label, color(tokens, token));

  const ink = color(tokens, "--color-text-default");
  // A chip nested inside an already-muted panel is the darkest light surface
  // the app produces, and the one a palette edit is most likely to push under
  // AA, so it is asserted rather than assumed rare.
  for (const base of ["surface", "raised", "neutral-muted"]) {
    all.set(`background-muted over ${base}`, mixOver(ink, mixPercent, all.get(base) as Rgb));
  }
  return all;
}

const TEXT_TOKENS = [
  "--color-text-default",
  "--color-text-muted",
  "--color-text-info",
  "--color-text-success",
  "--color-text-warning",
  "--color-text-danger",
] as const;

describe("light mode (warm paper) contrast", () => {
  const surfaces = surfacesFor(root, 8);

  it("passes AA for every text token on every surface", () => {
    const failures: string[] = [];
    for (const [surfaceName, surface] of surfaces) {
      for (const token of TEXT_TOKENS) {
        const ratio = contrast(color(root, token), surface);
        if (ratio < AA_TEXT) failures.push(`${token} on ${surfaceName}: ${ratio.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps the focus ring visible on every surface it can be drawn over", () => {
    // The old #16a34a scored 3.00 against white and 2.67 against a muted fill.
    // On beige that ring is the accessibility failure the repaint could most
    // easily have shipped, so it gets its own assertion.
    const ring = color(root, "--color-border-focus");
    const failures: string[] = [];
    for (const [surfaceName, surface] of surfaces) {
      const ratio = contrast(ring, surface);
      if (ratio < AA_NON_TEXT) failures.push(`focus ring on ${surfaceName}: ${ratio.toFixed(2)}`);
    }
    expect(failures).toEqual([]);
  });

  it("passes AA for label text on the solid primary action fill", () => {
    const label = hexToRgb("#ffffff");
    for (const token of [
      "--color-background-action-primary",
      "--color-background-action-primary-hover",
    ]) {
      expect(contrast(label, color(root, token)), token).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it("keeps every syntax color legible on the surfaces code renders on", () => {
    // The syntax family was tuned against #ffffff and is the part of the
    // repaint most likely to degrade quietly: a diff still renders, it just
    // stops being readable. Code appears on the muted fill (`prose-markdown
    // pre`, transcript chips) far more often than on the bare field, so the
    // muted beds are the ones that decide these values.
    const failures: string[] = [];
    for (const [surfaceName, surface] of surfaces) {
      for (const token of [
        "--color-syntax-comment",
        "--color-syntax-keyword",
        "--color-syntax-name",
        "--color-syntax-string",
        "--color-syntax-number",
        "--color-syntax-punctuation",
      ]) {
        const ratio = contrast(color(root, token), surface);
        if (ratio < AA_TEXT) failures.push(`${token} on ${surfaceName}: ${ratio.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps the raised surface lighter than the paper field", () => {
    // Paper inverts the white theme's elevation trick: there, a card could
    // only separate from #ffffff by going grey. Here it lifts toward white,
    // and a regression that swaps them would read as a dent, not a card.
    const field = relativeLuminance(color(root, "--color-background-surface"));
    const raised = relativeLuminance(color(root, "--color-background-surface-raised"));
    expect(raised).toBeGreaterThan(field);
  });

  it("uses a warm field and warm ink rather than the old cool greys", () => {
    // Warmth is the whole point of the issue, and it is the property a later
    // "just tidy the palette" edit would quietly undo. Red channel above blue
    // is the minimal statement of it.
    for (const token of [
      "--color-background-surface",
      "--color-background-surface-raised",
      "--color-background-surface-neutral-muted",
      "--hh-row-hover",
      "--color-border-default",
      "--color-text-default",
      "--color-text-muted",
    ]) {
      const [r, , b] = color(root, token);
      expect(r, `${token} should be warm (red channel above blue)`).toBeGreaterThan(b);
    }
  });
});

describe("dark mode contrast", () => {
  // Dark keeps its character under #518, but it shares the text tokens and the
  // newly added raised surface, so it is held to the same floor.
  const surfaces = surfacesFor(dark, 10);

  it("passes AA for every text token on every opaque surface", () => {
    const failures: string[] = [];
    for (const [surfaceName, surface] of surfaces) {
      if (surfaceName.startsWith("background-muted over")) continue;
      for (const token of TEXT_TOKENS) {
        const ratio = contrast(color(dark, token), surface);
        if (ratio < AA_TEXT) failures.push(`${token} on ${surfaceName}: ${ratio.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps the focus ring visible against the dark field", () => {
    const ring = color(dark, "--color-border-focus");
    expect(contrast(ring, color(dark, "--color-background-surface"))).toBeGreaterThanOrEqual(
      AA_NON_TEXT,
    );
  });

  it("keeps the raised surface lighter than the dark field", () => {
    const field = relativeLuminance(color(dark, "--color-background-surface"));
    const raised = relativeLuminance(color(dark, "--color-background-surface-raised"));
    expect(raised).toBeGreaterThan(field);
  });
});

describe("playbooks catalogue", () => {
  it("draws its palette from the global tokens in both appearances", () => {
    // The catalogue was the one page already on paper, and the exception the
    // rest of the app contradicted. Collapsing it means these are aliases; if
    // one is reintroduced as a literal the page silently diverges again.
    const aliased = [
      "--playbooks-paper",
      "--playbooks-surface",
      "--playbooks-ink",
      "--playbooks-muted",
      "--playbooks-line",
      "--playbooks-accent",
      "--playbooks-accent-soft",
      "--playbooks-shadow",
    ];
    for (const tokens of [root, dark]) {
      for (const name of aliased) {
        expect(tokens.get(name), name).toMatch(/^var\(--color-/);
      }
    }
  });

  it("keeps the terminal panel dark in both appearances", () => {
    // The terminal depicts a terminal, so it does not follow the field. In
    // light mode that makes it the one place the shared ink would be invisible.
    for (const tokens of [root, dark]) {
      const panel = relativeLuminance(color(tokens, "--playbooks-terminal"));
      const ink = color(tokens, "--playbooks-terminal-ink");
      expect(panel).toBeLessThan(0.1);
      expect(contrast(ink, color(tokens, "--playbooks-terminal"))).toBeGreaterThanOrEqual(AA_TEXT);
      expect(
        contrast(color(tokens, "--playbooks-terminal-muted"), color(tokens, "--playbooks-terminal")),
      ).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});
