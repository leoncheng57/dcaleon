import { getClaudeOAuthToken, clearCachedToken } from "./auth.js";

export interface UsageBucket {
  utilization: number;
  resetsAt: string | null;
}

export interface ClaudeUsageResponse {
  available: true;
  session: UsageBucket;
  weekly: UsageBucket;
  weeklyByModel: Record<string, UsageBucket>;
  subscriptionType: string | null;
  rateLimitTier: string | null;
}

export interface ClaudeUsageUnavailable {
  available: false;
  reason: string;
}

export type ClaudeUsage = ClaudeUsageResponse | ClaudeUsageUnavailable;

export const CACHE_TTL_MS = 30_000;
let cachedUsage: { data: ClaudeUsageResponse; fetchedAt: number } | null = null;

export function clearCachedUsage(): void {
  cachedUsage = null;
}

async function fetchUsageRaw(token: string, cliVersion: string): Promise<Response> {
  return fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": `dca-claude-usage/${cliVersion}`,
    },
  });
}

export function parseBucket(raw: unknown): UsageBucket {
  const obj = raw as Record<string, unknown> | undefined;
  return {
    utilization: typeof obj?.utilization === "number" ? obj.utilization : 0,
    resetsAt: typeof obj?.resets_at === "string" ? obj.resets_at : null,
  };
}

export function parseResponse(body: Record<string, unknown>): ClaudeUsageResponse {
  const weeklyByModel: Record<string, UsageBucket> = {};
  const models = body.models ?? body.weekly_by_model;
  if (models && typeof models === "object") {
    for (const [key, value] of Object.entries(models as Record<string, unknown>)) {
      weeklyByModel[key] = parseBucket(value);
    }
  }

  return {
    available: true,
    session: parseBucket(body.session ?? body.current_session),
    weekly: parseBucket(body.weekly ?? body.all_models),
    weeklyByModel,
    subscriptionType: typeof body.subscription_type === "string" ? body.subscription_type : null,
    rateLimitTier: typeof body.rate_limit_tier === "string" ? body.rate_limit_tier : null,
  };
}

export async function fetchClaudeUsage(cliVersion: string): Promise<ClaudeUsage> {
  if (cachedUsage && Date.now() - cachedUsage.fetchedAt < CACHE_TTL_MS) {
    return cachedUsage.data;
  }

  let token: string;
  try {
    token = await getClaudeOAuthToken();
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : "Failed to read OAuth token" };
  }

  let res: Response;
  try {
    res = await fetchUsageRaw(token, cliVersion);
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : "Fetch failed" };
  }

  if (res.status === 401) {
    clearCachedToken();
    try {
      token = await getClaudeOAuthToken();
      res = await fetchUsageRaw(token, cliVersion);
    } catch {
      return cachedUsage ? cachedUsage.data : { available: false, reason: "Token refresh failed" };
    }
  }

  if (res.status === 429) {
    return cachedUsage ? cachedUsage.data : { available: false, reason: "Rate limited" };
  }

  if (!res.ok) {
    return { available: false, reason: `HTTP ${res.status}` };
  }

  try {
    const body = (await res.json()) as Record<string, unknown>;
    const data = parseResponse(body);
    cachedUsage = { data, fetchedAt: Date.now() };
    return data;
  } catch {
    return { available: false, reason: "Failed to parse usage response" };
  }
}
