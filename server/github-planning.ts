// server/github-planning.ts — planning feed and issue creation for ONE fixed repository.
//
// This is deliberately not project-scoped. Every other instance route threads
// ?directory=, but the planning page is a developer page about *this* app, so the
// repository is a constant here and the browser cannot name one. That removes the
// whole class of "browser points the server's token at an arbitrary repo" bugs
// that the existing forge routes are exposed to, since they authorize by URL.
//
// GitHub's Issues API returns pull requests too (a PR is an issue with a
// `pull_request` member). We keep both and label them, because the planning view
// wants one backlog, but the distinction has to survive normalization.

export const PLANNING_REPOSITORY = {
  owner: "leoncheng57",
  repo: "dcaleon",
  url: "https://github.com/leoncheng57/dcaleon",
} as const;

export const PLANNING_LIMITS = {
  perPage: 100,
  /** Bounded fan-out: at most 500 records, then we report truncation. */
  pages: 5,
  labels: 100,
  createLabels: 20,
  titleCharacters: 300,
  timeoutMs: 10_000,
  cacheMs: 60_000,
  labelCacheMs: 5 * 60_000,
  createTitleCharacters: 256,
  createBodyCharacters: 65_536,
  labelNameCharacters: 100,
  detailBodyCharacters: 20_000,
  commentBodyCharacters: 8_000,
  comments: 50,
  /**
   * Parent/child ("epic") edges cost one extra request per parent, because the
   * list endpoint reports a child *count* but never a parent link. These three
   * bound that fan-out: how many epics we will resolve at all, how many of
   * those requests may be open at once, and how many children we read from any
   * single epic.
   */
  epics: 25,
  epicConcurrency: 4,
  epicChildren: 100,
} as const;

export type PlanningItemType = "issue" | "pull_request";
export type PlanningItemState = "open" | "closed";
export type PlanningError = "Authentication unavailable" | "Rate limited" | "Rejected by GitHub" | "Unavailable";

export interface PlanningLabel { name: string; description: string | null }
export interface CreatePlanningIssueInput { title: string; body: string; labels: string[] }
export interface UpdatePlanningLabelsInput { labels: string[] }
export interface PlanningComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  bodyTruncated: boolean;
}

export class PlanningInputError extends Error {}

export interface PlanningItem {
  id: string;
  number: number;
  type: PlanningItemType;
  title: string;
  state: PlanningItemState;
  /** Only ever true for a merged pull request. */
  merged: boolean;
  /** Label *names* only — see planningErrorMessage's note on colors. */
  labels: string[];
  author: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  commentCount: number;
  /** `sub_issues_summary.total`; 0 for anything that is not an epic. */
  childCount: number;
  /** `sub_issues_summary.completed`, clamped to at most `childCount`. */
  completedChildCount: number;
  /**
   * Resolved by the snapshot's bounded `/sub_issues` fan-out, never by the
   * list endpoint, which carries no parent link at all. `null` means either
   * top-level or an edge we did not spend a request to discover.
   */
  parentNumber: number | null;
}

export interface PlanningSnapshot {
  repository: { owner: string; repo: string; url: string };
  items: PlanningItem[];
  /** True when more records exist than PLANNING_LIMITS allows us to fetch. */
  truncated: boolean;
  /** True when more epics were discovered than PLANNING_LIMITS.epics resolves. */
  epicsTruncated: boolean;
  fetchedAt: string;
}

export interface PlanningItemDetails {
  item: PlanningItem;
  itemLabelsTruncated: boolean;
  body: string;
  bodyTruncated: boolean;
  comments: PlanningComment[];
  commentsTruncated: boolean;
  commentsError: PlanningError | null;
}

class PlanningFetchError extends Error {
  constructor(readonly safeMessage: PlanningError, readonly status: number) {
    super(safeMessage);
  }
}

/**
 * Upstream failures are reduced to three coarse strings. The token and any raw
 * upstream body must never reach the browser, and the caller only needs to know
 * whether to retry, re-authenticate, or wait.
 */
export function planningErrorMessage(error: unknown): PlanningError {
  return error instanceof PlanningFetchError ? error.safeMessage : "Unavailable";
}

export function planningErrorStatus(error: unknown): number {
  return error instanceof PlanningFetchError ? error.status : 502;
}

function githubApi(): URL {
  return new URL(process.env.GITHUB_API_URL || "https://api.github.com");
}

function pageUrl(page: number): URL {
  const url = new URL(
    `/repos/${encodeURIComponent(PLANNING_REPOSITORY.owner)}/${encodeURIComponent(PLANNING_REPOSITORY.repo)}/issues`,
    githubApi(),
  );
  url.searchParams.set("state", "all");
  url.searchParams.set("per_page", String(PLANNING_LIMITS.perPage));
  url.searchParams.set("page", String(page));
  url.searchParams.set("sort", "updated");
  url.searchParams.set("direction", "desc");
  return url;
}

function labelsUrl(page: number): URL {
  const url = new URL(
    `/repos/${encodeURIComponent(PLANNING_REPOSITORY.owner)}/${encodeURIComponent(PLANNING_REPOSITORY.repo)}/labels`,
    githubApi(),
  );
  url.searchParams.set("per_page", String(PLANNING_LIMITS.perPage));
  url.searchParams.set("page", String(page));
  return url;
}

function createUrl(): URL {
  return new URL(
    `/repos/${encodeURIComponent(PLANNING_REPOSITORY.owner)}/${encodeURIComponent(PLANNING_REPOSITORY.repo)}/issues`,
    githubApi(),
  );
}

function itemUrl(number: number): URL {
  return new URL(
    `/repos/${encodeURIComponent(PLANNING_REPOSITORY.owner)}/${encodeURIComponent(PLANNING_REPOSITORY.repo)}/issues/${number}`,
    githubApi(),
  );
}

function commentsUrl(number: number): URL {
  const url = new URL(`${itemUrl(number).pathname}/comments`, githubApi());
  url.searchParams.set("per_page", String(PLANNING_LIMITS.comments + 1));
  url.searchParams.set("page", "1");
  return url;
}

/**
 * The only endpoint that names an epic's children. The list endpoint carries
 * `sub_issues_summary` but no parent link, and the single-issue endpoint's
 * `parent_issue_url` would cost one request *per item* rather than per parent.
 */
function subIssuesUrl(number: number): URL {
  const url = new URL(`${itemUrl(number).pathname}/sub_issues`, githubApi());
  url.searchParams.set("per_page", String(PLANNING_LIMITS.epicChildren));
  return url;
}

/**
 * GitHub signals an exhausted rate limit with 403 plus a zero remaining header
 * far more often than with 429, so both have to map to "Rate limited" or the UI
 * tells the user to fix their credentials when they only need to wait.
 */
function classifiedError(response: Response): PlanningFetchError {
  if (response.status === 429 || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")))) {
    return new PlanningFetchError("Rate limited", 429);
  }
  if (response.status === 401 || response.status === 403) return new PlanningFetchError("Authentication unavailable", 503);
  if (response.status === 400 || response.status === 422) return new PlanningFetchError("Rejected by GitHub", 422);
  return new PlanningFetchError("Unavailable", 502);
}

interface PlanningPage {
  items: Array<Record<string, unknown>>;
  hasNext: boolean;
}

async function fetchPage(page: number): Promise<PlanningPage> {
  const token = process.env.GITHUB_TOKEN;
  let response: Response;
  try {
    response = await fetch(pageUrl(page), {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "dcaleon",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(PLANNING_LIMITS.timeoutMs),
    });
  } catch {
    throw new PlanningFetchError("Unavailable", 502);
  }
  if (!response.ok) throw classifiedError(response);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PlanningFetchError("Unavailable", 502);
  }
  if (!Array.isArray(body)) throw new PlanningFetchError("Unavailable", 502);
  const link = response.headers.get("link") ?? "";
  return {
    items: body as Array<Record<string, unknown>>,
    hasNext: /(?:^|,)\s*<[^>]+>;\s*rel="next"(?:\s*[,;]|$)/u.test(link),
  };
}

async function fetchLabelsPage(page: number): Promise<PlanningPage> {
  let response: Response;
  try {
    response = await fetch(labelsUrl(page), {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "dcaleon",
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(PLANNING_LIMITS.timeoutMs),
    });
  } catch {
    throw new PlanningFetchError("Unavailable", 502);
  }
  if (!response.ok) throw classifiedError(response);
  let body: unknown;
  try { body = await response.json(); } catch { throw new PlanningFetchError("Unavailable", 502); }
  if (!Array.isArray(body)) throw new PlanningFetchError("Unavailable", 502);
  return {
    items: body as Array<Record<string, unknown>>,
    hasNext: /(?:^|,)\s*<[^>]+>;\s*rel="next"(?:\s*[,;]|$)/u.test(response.headers.get("link") ?? ""),
  };
}

export function validatePlanningNumber(value: unknown): number {
  const source = typeof value === "number" ? String(value) : value;
  if (typeof source !== "string" || !/^[1-9]\d*$/u.test(source)) throw new PlanningInputError("Issue number is invalid");
  const number = Number(source);
  if (!Number.isSafeInteger(number)) throw new PlanningInputError("Issue number is invalid");
  return number;
}

export function validatePlanningLabels(value: unknown, limit: number = PLANNING_LIMITS.labels): string[] {
  if (!Array.isArray(value)) throw new PlanningInputError("Labels must be a list");
  const labels: string[] = [];
  const normalized = new Set<string>();
  const priorities = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") throw new PlanningInputError("Every label must be text");
    const label = raw.trim();
    if (!label || label.length > PLANNING_LIMITS.labelNameCharacters) throw new PlanningInputError("Label is invalid or too long");
    const key = label.toLocaleLowerCase();
    if (!normalized.has(key)) {
      normalized.add(key);
      labels.push(label);
    }
    if (["priority:high", "priority:medium", "priority:low"].includes(key)) priorities.add(key);
    if (labels.length > limit) throw new PlanningInputError(`At most ${limit} labels may be selected`);
  }
  if (priorities.size > 1) throw new PlanningInputError("Select at most one priority label");
  return labels;
}

export function validateCreatePlanningIssue(value: unknown): CreatePlanningIssueInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PlanningInputError("Issue must be an object");
  const source = value as Record<string, unknown>;
  const allowed = new Set(["title", "body", "labels"]);
  if (Object.keys(source).some((key) => !allowed.has(key))) throw new PlanningInputError("Issue contains an unknown field");
  if (typeof source.title !== "string") throw new PlanningInputError("Title is required");
  const title = source.title.trim();
  if (!title) throw new PlanningInputError("Title is required");
  if (title.length > PLANNING_LIMITS.createTitleCharacters) throw new PlanningInputError(`Title must be ${PLANNING_LIMITS.createTitleCharacters} characters or fewer`);
  if (/[\r\n\0]/u.test(title)) throw new PlanningInputError("Title must be one line");
  if (source.body !== undefined && typeof source.body !== "string") throw new PlanningInputError("Description must be text");
  const body = String(source.body ?? "");
  if (body.length > PLANNING_LIMITS.createBodyCharacters || body.includes("\0")) throw new PlanningInputError("Description is invalid or too long");
  const labels = validatePlanningLabels(source.labels ?? [], PLANNING_LIMITS.createLabels);
  return { title, body, labels };
}

export function validateUpdatePlanningLabels(value: unknown): UpdatePlanningLabelsInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PlanningInputError("Label update must be an object");
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => key !== "labels") || !("labels" in source)) throw new PlanningInputError("Label update must contain only labels");
  return { labels: validatePlanningLabels(source.labels) };
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    const name = typeof entry === "string" ? entry : String((entry as { name?: unknown } | null)?.name ?? "");
    if (name) names.push(name);
    if (names.length >= PLANNING_LIMITS.labels) break;
  }
  return names;
}

/** Only http(s) survives, so the client can link without re-validating. */
function webUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

/** Absent, malformed, fractional and negative counters all read as zero. */
function counter(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export function normalizePlanningItem(raw: Record<string, unknown>): PlanningItem | null {
  const number = Number(raw.number);
  if (!Number.isSafeInteger(number) || number <= 0) return null;

  const pull = raw.pull_request;
  const isPull = !!pull && typeof pull === "object";
  const mergedAt = isPull ? (pull as { merged_at?: unknown }).merged_at : undefined;
  const title = String(raw.title ?? "");

  const rawSummary = raw.sub_issues_summary;
  const summary = rawSummary && typeof rawSummary === "object" && !Array.isArray(rawSummary)
    ? (rawSummary as Record<string, unknown>)
    : {};
  const childCount = counter(summary.total);

  return {
    id: String(raw.id ?? `${isPull ? "pull" : "issue"}-${number}`),
    number,
    type: isPull ? "pull_request" : "issue",
    title: title.slice(0, PLANNING_LIMITS.titleCharacters),
    state: raw.state === "closed" ? "closed" : "open",
    merged: isPull && typeof mergedAt === "string" && mergedAt.length > 0,
    labels: labelNames(raw.labels),
    author: typeof (raw.user as { login?: unknown } | null)?.login === "string"
      ? String((raw.user as { login: string }).login)
      : null,
    url: webUrl(raw.html_url),
    createdAt: String(raw.created_at ?? ""),
    updatedAt: String(raw.updated_at ?? ""),
    commentCount: Number.isFinite(Number(raw.comments)) ? Math.max(0, Math.trunc(Number(raw.comments))) : 0,
    childCount,
    completedChildCount: Math.min(childCount, counter(summary.completed)),
    // Only the snapshot fan-out may set this; a single record never knows.
    parentNumber: null,
  };
}

function boundedText(value: unknown, limit: number): { value: string; truncated: boolean } {
  const source = typeof value === "string" ? value : "";
  return { value: source.slice(0, limit), truncated: source.length > limit };
}

export function normalizePlanningComment(raw: Record<string, unknown>): PlanningComment {
  const body = boundedText(raw.body, PLANNING_LIMITS.commentBodyCharacters);
  return {
    id: String(raw.id ?? ""),
    author: typeof (raw.user as { login?: unknown } | null)?.login === "string"
      ? String((raw.user as { login: string }).login)
      : "unknown",
    body: body.value,
    createdAt: String(raw.created_at ?? ""),
    bodyTruncated: body.truncated,
  };
}

async function planningRequest(target: URL, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  headers.set("User-Agent", "dcaleon");
  if (process.env.GITHUB_TOKEN) headers.set("Authorization", `Bearer ${process.env.GITHUB_TOKEN}`);
  let response: Response;
  try {
    response = await fetch(target, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(PLANNING_LIMITS.timeoutMs),
    });
  } catch {
    throw new PlanningFetchError("Unavailable", 502);
  }
  if (!response.ok) throw classifiedError(response);
  try {
    return await response.json();
  } catch {
    throw new PlanningFetchError("Unavailable", 502);
  }
}

function trustedPlanningItem(raw: Record<string, unknown>): PlanningItem | null {
  const item = normalizePlanningItem(raw);
  if (!item) return null;
  item.url = `${PLANNING_REPOSITORY.url}/${item.type === "pull_request" ? "pull" : "issues"}/${item.number}`;
  return item;
}

export async function getPlanningItemDetails(value: unknown): Promise<PlanningItemDetails> {
  const number = validatePlanningNumber(value);
  const [itemResult, commentsResult] = await Promise.allSettled([
    planningRequest(itemUrl(number)),
    planningRequest(commentsUrl(number)),
  ]);
  if (itemResult.status === "rejected") throw itemResult.reason;
  if (!itemResult.value || typeof itemResult.value !== "object" || Array.isArray(itemResult.value)) {
    throw new PlanningFetchError("Unavailable", 502);
  }
  const raw = itemResult.value as Record<string, unknown>;
  const item = trustedPlanningItem(raw);
  if (!item || item.number !== number) throw new PlanningFetchError("Unavailable", 502);
  const body = boundedText(raw.body, PLANNING_LIMITS.detailBodyCharacters);

  let comments: PlanningComment[] = [];
  let commentsTruncated = false;
  let commentsError: PlanningError | null = null;
  if (commentsResult.status === "fulfilled" && Array.isArray(commentsResult.value)) {
    commentsTruncated = commentsResult.value.length > PLANNING_LIMITS.comments;
    comments = commentsResult.value
      .slice(0, PLANNING_LIMITS.comments)
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry))
      .map(normalizePlanningComment);
  } else {
    commentsError = commentsResult.status === "rejected" ? planningErrorMessage(commentsResult.reason) : "Unavailable";
  }

  return {
    item,
    itemLabelsTruncated: Array.isArray(raw.labels) && raw.labels.length > PLANNING_LIMITS.labels,
    body: body.value,
    bodyTruncated: body.truncated,
    comments,
    commentsTruncated,
    commentsError,
  };
}

/** Runs `worker` over every index with at most `limit` in flight. No dependency. */
async function withConcurrency(count: number, limit: number, worker: (index: number) => Promise<void>): Promise<void> {
  if (count <= 0) return;
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, count)) }, async () => {
    while (cursor < count) {
      const index = cursor;
      cursor += 1;
      await worker(index);
    }
  });
  await Promise.all(lanes);
}

/**
 * Resolves parent/child edges for the snapshot and reports whether more epics
 * existed than we were willing to spend requests on.
 *
 * Fails open per parent, exactly like the comments fetch in
 * getPlanningItemDetails: an epic whose `/sub_issues` rejects or answers with
 * something other than an array simply contributes no edges. One unlucky epic
 * must never blank a backlog that is mostly about other work.
 *
 * Requests run concurrently but assignments are applied afterwards in parent
 * order, so a child claimed by two parents always lands on the same one.
 */
async function resolveEpicEdges(items: PlanningItem[]): Promise<boolean> {
  const byNumber = new Map(items.map((item) => [item.number, item]));
  // Pull requests never have sub-issues, so they are never candidate parents.
  const candidates = items
    .filter((item) => item.type === "issue" && item.childCount > 0)
    .sort((left, right) => right.number - left.number);
  const epicsTruncated = candidates.length > PLANNING_LIMITS.epics;
  const parents = epicsTruncated ? candidates.slice(0, PLANNING_LIMITS.epics) : candidates;
  if (parents.length === 0) return false;

  const responses: unknown[] = new Array(parents.length).fill(null);
  await withConcurrency(parents.length, PLANNING_LIMITS.epicConcurrency, async (index) => {
    try {
      responses[index] = await planningRequest(subIssuesUrl(parents[index].number));
    } catch {
      responses[index] = null;
    }
  });

  parents.forEach((parent, index) => {
    const body = responses[index];
    if (!Array.isArray(body)) return;
    for (const entry of body.slice(0, PLANNING_LIMITS.epicChildren)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const number = Number((entry as { number?: unknown }).number);
      if (!Number.isSafeInteger(number) || number === parent.number) continue;
      const child = byNumber.get(number);
      // Unknown numbers are children outside the fetched window; keep the edge unresolved.
      if (!child || child.parentNumber !== null) continue;
      child.parentNumber = parent.number;
    }
  });

  return epicsTruncated;
}

async function loadSnapshot(): Promise<PlanningSnapshot> {
  const items: PlanningItem[] = [];
  let truncated = false;
  for (let page = 1; page <= PLANNING_LIMITS.pages; page += 1) {
    const result = await fetchPage(page);
    for (const entry of result.items) {
      const item = normalizePlanningItem(entry);
      if (item) items.push(item);
    }
    if (!result.hasNext) break;
    if (page === PLANNING_LIMITS.pages) truncated = true;
  }
  const epicsTruncated = await resolveEpicEdges(items);
  return { repository: { ...PLANNING_REPOSITORY }, items, truncated, epicsTruncated, fetchedAt: new Date().toISOString() };
}

let cached: { snapshot: PlanningSnapshot; expiresAt: number } | null = null;
let inFlight: Promise<PlanningSnapshot> | null = null;
let cacheGeneration = 0;
let labelsCached: { labels: PlanningLabel[]; truncated: boolean; expiresAt: number } | null = null;
let labelsInFlight: Promise<{ labels: PlanningLabel[]; truncated: boolean }> | null = null;

function invalidatePlanningSnapshot(): void {
  cacheGeneration += 1;
  cached = null;
  inFlight = null;
}

/** Tests only. Module-level cache would otherwise leak between cases. */
export function resetPlanningCache(): void {
  cached = null;
  inFlight = null;
  cacheGeneration += 1;
  labelsCached = null;
  labelsInFlight = null;
}

/**
 * Cached for PLANNING_LIMITS.cacheMs and coalesced while in flight: the page
 * polls, and several browser tabs must not multiply into several GitHub calls
 * against a shared rate limit.
 */
export function getPlanningSnapshot(refresh = false): Promise<PlanningSnapshot> {
  if (!refresh && cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.snapshot);
  if (inFlight) return inFlight;
  const generation = cacheGeneration;
  const request = loadSnapshot()
    .then((snapshot) => {
      if (generation === cacheGeneration) cached = { snapshot, expiresAt: Date.now() + PLANNING_LIMITS.cacheMs };
      return snapshot;
    })
    .finally(() => {
      if (inFlight === request) inFlight = null;
    });
  inFlight = request;
  return request;
}

async function loadLabels(): Promise<{ labels: PlanningLabel[]; truncated: boolean }> {
  const labels: PlanningLabel[] = [];
  let truncated = false;
  for (let page = 1; page <= PLANNING_LIMITS.pages; page += 1) {
    const result = await fetchLabelsPage(page);
    for (const raw of result.items) {
      const name = typeof raw.name === "string" ? raw.name : "";
      if (name) labels.push({ name, description: typeof raw.description === "string" ? raw.description : null });
    }
    if (!result.hasNext) break;
    if (page === PLANNING_LIMITS.pages) truncated = true;
  }
  return { labels, truncated };
}

export function getPlanningLabels(): Promise<{ labels: PlanningLabel[]; truncated: boolean }> {
  if (labelsCached && labelsCached.expiresAt > Date.now()) return Promise.resolve({ labels: labelsCached.labels, truncated: labelsCached.truncated });
  if (labelsInFlight) return labelsInFlight;
  const request = loadLabels().then((result) => {
    labelsCached = { ...result, expiresAt: Date.now() + PLANNING_LIMITS.labelCacheMs };
    return result;
  }).finally(() => { if (labelsInFlight === request) labelsInFlight = null; });
  labelsInFlight = request;
  return request;
}

export async function updatePlanningItemLabels(numberValue: unknown, value: unknown): Promise<PlanningItem> {
  const number = validatePlanningNumber(numberValue);
  const input = validateUpdatePlanningLabels(value);
  if (!process.env.GITHUB_TOKEN) throw new PlanningFetchError("Authentication unavailable", 503);
  const catalogue = await getPlanningLabels();
  if (catalogue.truncated) throw new PlanningInputError("Label catalogue is too large to update safely");
  const canonicalLabels = new Map(catalogue.labels.map((label) => [label.name.toLocaleLowerCase(), label.name]));
  input.labels = input.labels.map((label) => {
    const canonical = canonicalLabels.get(label.toLocaleLowerCase());
    if (!canonical) throw new PlanningInputError(`Unknown label: ${label}`);
    return canonical;
  });
  const current = await planningRequest(itemUrl(number));
  if (!current || typeof current !== "object" || Array.isArray(current)) throw new PlanningFetchError("Unavailable", 502);
  const currentLabels = (current as Record<string, unknown>).labels;
  if (Array.isArray(currentLabels) && currentLabels.length > PLANNING_LIMITS.labels) {
    throw new PlanningInputError("Item has too many labels to update safely");
  }
  const raw = await planningRequest(itemUrl(number), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PlanningFetchError("Unavailable", 502);
  const item = trustedPlanningItem(raw as Record<string, unknown>);
  if (!item || item.number !== number) throw new PlanningFetchError("Unavailable", 502);
  invalidatePlanningSnapshot();
  return item;
}

export async function createPlanningIssue(value: unknown): Promise<PlanningItem> {
  const input = validateCreatePlanningIssue(value);
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new PlanningFetchError("Authentication unavailable", 503);
  let response: Response;
  try {
    response = await fetch(createUrl(), {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "dcaleon",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(input),
      redirect: "error",
      signal: AbortSignal.timeout(PLANNING_LIMITS.timeoutMs),
    });
  } catch {
    throw new PlanningFetchError("Unavailable", 502);
  }
  if (response.status !== 201) throw classifiedError(response);
  let raw: unknown;
  try { raw = await response.json(); } catch { throw new PlanningFetchError("Unavailable", 502); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PlanningFetchError("Unavailable", 502);
  const issue = trustedPlanningItem(raw as Record<string, unknown>);
  if (!issue || issue.type !== "issue") throw new PlanningFetchError("Unavailable", 502);
  invalidatePlanningSnapshot();
  return issue;
}
