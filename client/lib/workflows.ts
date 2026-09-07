// Composer workflows, client side (issue #167). A workflow attached to a
// message travels inside the message content wrapped in a sentinel tag whose
// body the SERVER resolved from the workflow id — the browser never authors
// it. The transcript pulls the block back out so the bubble shows what was
// typed and the trusted injector renders separately.
//
// `splitWorkflowTags` deliberately duplicates server/workflows/workflows.ts.
// Sharing the server module would cross the browser/server seam for one regex;
// drift is prevented by tests/workflows.test.ts running one case table against
// BOTH copies. Keep the regex and body byte-identical.

export interface SplitWorkflowMessage {
  text: string;
  workflows: Array<{ name: string; body: string }>;
}

const WORKFLOW_TAG_RE = /\n*<workflow name="([a-z0-9]+(?:-[a-z0-9]+)*)">\n?([\s\S]*?)\n?<\/workflow>/g;

export function splitWorkflowTags(input: string): SplitWorkflowMessage {
  const workflows: Array<{ name: string; body: string }> = [];
  const text = input.replace(WORKFLOW_TAG_RE, (_match, name: string, body: string) => {
    workflows.push({ name, body: body.trim() });
    return "";
  });
  return { text: text.trim(), workflows };
}

// ── Workflow ids (must match the server catalogue) ──────────────────────────

import type { WorkflowSummary } from "./api.js";

export const PLAYWRIGHT_REVIEW_WORKFLOW_ID = "playwright-ui-review";
export const SESSION_UPDATE_WORKFLOW_ID = "session-update";
export const MANAGED_CHILD_WORKFLOW_ID = "managed-child";
export const START_DCA_SESSION_WORKFLOW_ID = "start-dca-session";
export const PR_SNIPPET_REVIEW_WORKFLOW_ID = "pr-snippet-review";
export const DESIGN_DOC_PROTOTYPE_WORKFLOW_ID = "design-doc-prototype";

// Six semantic groups covering the whole catalogue, in catalogue order. The
// sixteen ported procedures are named as literals rather than as exported
// constants: unlike the five above they are not referenced anywhere else,
// because they need no bespoke branch — the generic argument field renders all
// of them.
//
// Two seams were redrawn after the 22-item catalogue made them load-bearing.
// "Coordinate" had grown to six and was quietly two ideas — creating a new
// agent and messaging one that already exists — so **Delegate** now owns
// everything that brings a new session into being, and Coordinate keeps only
// the two that report to something already there (one machine, one human).
// "Ship" held two whose seam with Execute was soft: verifying and wrapping up
// are the end of doing the work here, not a separate act, so they fold into
// **Execute** rather than keeping a heading they did not earn.
//
// Nothing should land in the "Other" bucket `groupWorkflows` appends. That
// bucket exists for a workflow a newer server ships that this build has never
// heard of, not as a home for one this build forgot to place.
export const WORKFLOW_GROUPS = [
  { label: "Review", ids: [PLAYWRIGHT_REVIEW_WORKFLOW_ID, PR_SNIPPET_REVIEW_WORKFLOW_ID] },
  { label: "Execute", ids: ["goal", "dca", "leaving-now-wrap-up"] },
  {
    label: "Delegate",
    ids: [
      MANAGED_CHILD_WORKFLOW_ID,
      START_DCA_SESSION_WORKFLOW_ID,
      "session-handoff",
    ],
  },
  { label: "Coordinate", ids: [SESSION_UPDATE_WORKFLOW_ID, "standup"] },
  { label: "Document", ids: [DESIGN_DOC_PROTOTYPE_WORKFLOW_ID, "docs-preview", "mini-design-doc", "system-design-artifacts"] },
] as const;

export interface WorkflowGroup {
  label: string;
  workflows: WorkflowSummary[];
}

export function groupWorkflows(catalogue: WorkflowSummary[]): WorkflowGroup[] {
  const grouped: WorkflowGroup[] = WORKFLOW_GROUPS.map(({ label, ids }) => ({
    label,
    workflows: ids.flatMap((id) => {
      const workflow = catalogue.find((candidate) => candidate.id === id);
      return workflow ? [workflow] : [];
    }),
  })).filter(({ workflows }) => workflows.length > 0);
  const knownIds = new Set<string>(WORKFLOW_GROUPS.flatMap(({ ids }) => ids));
  const other = catalogue.filter((workflow) => !knownIds.has(workflow.id));
  if (other.length) grouped.push({ label: "Other", workflows: other });
  return grouped;
}

export const KNOWN_APP_ROUTES = [
  "/",
  "/opencode",
  "/claude",
  "/settings",
  "/settings/notifications",
  "/tools",
  "/planning",
  "/observability",
  "/docs",
  "/playbooks",
  "/playbooks/reminders",
] as const;

export function isKnownAppRoute(value: string): boolean {
  const route = value.trim();
  if (!route.startsWith("/") || route.startsWith("//") || /[\s\u0000-\u001f\u007f\\]/u.test(route)) return false;
  try {
    const url = new URL(route, "http://workflow.invalid");
    return url.origin === "http://workflow.invalid" && [
      /^\/$/,
      /^\/opencode$/,
      /^\/settings$/,
      /^\/settings\/notifications$/,
      /^\/tools$/,
      /^\/planning$/,
      /^\/observability$/,
      /^\/docs(?:\/[A-Za-z0-9_-]+)?$/,
      /^\/playbooks(?:\/(?:workflows|reminders)(?:\/[A-Za-z0-9_-]+)?)?$/,
      /^\/sessions\/[A-Za-z0-9_-]+$/,
      /^\/dsh(?:\/sessions\/[A-Za-z0-9_-]+)?$/,
      /^\/claude(?:\/sessions\/[A-Za-z0-9_-]+)?$/,
    ].some((pattern) => pattern.test(url.pathname));
  } catch {
    return false;
  }
}

// ── Generic argument workflows ──────────────────────────────────────────────
//
// A workflow that declares an `argument` collects one free-text field whose
// typed value IS the visible prompt, exactly as "Send an update to another
// session" and "Launch a Managed Child" already behave. A workflow that
// declares neither an argument nor a fixed `prompt` has nothing to send, which
// is why `genericWorkflowPrompt` can return an empty string and
// `genericWorkflowValid` refuses it.

/** The visible prompt for a workflow with no bespoke builder. */
export function genericWorkflowPrompt(workflow: Pick<WorkflowSummary, "argument" | "prompt">, typed: string): string {
  return workflow.argument ? typed.trim() : (workflow.prompt ?? "");
}

/**
 * Whether the generic form may advance. An optional argument left blank is
 * allowed by the spec, but a send whose whole prompt would be empty is not:
 * the resulting message would be the trusted injector with nothing to apply it
 * to, and the prompt route rejects empty text anyway.
 */
export function genericWorkflowValid(workflow: Pick<WorkflowSummary, "argument" | "prompt">, typed: string): boolean {
  const { argument } = workflow;
  if (argument && argument.required && (typed.trim() === "" || typed.length > argument.maxLength)) return false;
  if (argument && typed.length > argument.maxLength) return false;
  return genericWorkflowPrompt(workflow, typed).trim() !== "";
}

// ── Pull request review prompt generation ───────────────────────────────────

/** GitHub's own ceiling is far lower; this only bounds the field. */
const MAX_PULL_REQUEST_NUMBER = 9_999_999;

/**
 * Accept the three things a human actually has to hand — `253`, `#253`, or a
 * pasted pull request URL — and reduce all of them to a number.
 *
 * Only the NUMBER survives. A pasted URL's owner, repository and host are
 * deliberately discarded rather than parsed out and used: the repository comes
 * from the session's project directory, so a link copied from somewhere else
 * can never redirect the review (or the posted comment) at another repository.
 */
export function parsePullRequestNumber(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const direct = /^#?(\d{1,7})$/u.exec(trimmed);
  const fromUrl = /^https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/(\d{1,7})(?:[/?#].*)?$/u.exec(trimmed);
  const digits = direct?.[1] ?? fromUrl?.[1];
  if (digits === undefined) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_PULL_REQUEST_NUMBER ? value : null;
}

export function buildPrSnippetReviewPrompt(pullRequest: number): string {
  return [
    `Post a snippet-by-snippet review of pull request #${pullRequest} in this repository.`,
    "",
    "Walk it as an ordered sequence of explained snippets so it can be read top to bottom, then post it as a single GitHub comment.",
  ].join("\n");
}

// ── Playwright review prompt generation ─────────────────────────────────────
//
// The visible prompt is generated in the browser because the user reviews and
// may edit it before sending — only the injector must be server-authored.

export const PLAYWRIGHT_CAPTURE_SCOPES = [
  { id: "interaction", label: "Focused interaction check (assertions only)" },
  { id: "targeted-screenshots", label: "Targeted screenshots of the affected UI" },
] as const;

export type PlaywrightCaptureScope = (typeof PLAYWRIGHT_CAPTURE_SCOPES)[number]["id"];

export function captureScopeLabel(scope: PlaywrightCaptureScope): string {
  return PLAYWRIGHT_CAPTURE_SCOPES.find((option) => option.id === scope)?.label ?? scope;
}

export function buildPlaywrightReviewPrompt(fields: {
  route: string;
  target: string;
  scope: PlaywrightCaptureScope;
}): string {
  return [
    "Review a UI change with Playwright.",
    "",
    `Route or component: ${fields.route.trim()}`,
    `Desired state or interaction: ${fields.target.trim()}`,
    `Capture scope: ${captureScopeLabel(fields.scope)}`,
  ].join("\n");
}
