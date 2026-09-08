const DEFAULT_BASE_URL = "https://rest.ripplingapis.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

type Query = Record<string, string | number | undefined>;

// Rippling has shipped several response envelopes across API versions; list
// endpoints may return a bare array, {results}, or {data}.
function unwrapList(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    for (const key of ["results", "data", "items"]) {
      const value = (body as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

export class RipplingApiError extends Error {
  status: number;
  path: string;

  constructor(status: number, path: string, body: string) {
    super(RipplingApiError.describe(status, path, body));
    this.name = "RipplingApiError";
    this.status = status;
    this.path = path;
  }

  private static describe(status: number, path: string, body: string): string {
    const detail = body.slice(0, 400).trim();
    const hint =
      status === 401
        ? " Token may be expired — Rippling tokens lapse after 30 days of inactivity. Regenerate it in the admin console."
        : status === 403
          ? " The token authenticated but lacks scope for this resource. Check its granted read scopes."
          : "";
    return `Rippling API error ${status} on GET ${path}.${hint}${detail ? ` Response: ${detail}` : ""}`;
  }
}

export class RipplingClient {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor() {
    const token = process.env.RIPPLING_API_TOKEN;
    if (!token) {
      throw new Error(
        "RIPPLING_API_TOKEN is not set. Generate a token in the Rippling admin console and pass it via the MCP server's env block.",
      );
    }
    this.token = token;
    this.baseUrl = (process.env.RIPPLING_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  private async request(path: string, query: Query = {}): Promise<unknown> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
    });

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After")) || 2;
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
      });
    }

    if (!response.ok) {
      throw new RipplingApiError(response.status, path, await response.text());
    }
    return response.json();
  }

  async getOne(path: string, id: string): Promise<unknown> {
    return this.request(`${path}/${encodeURIComponent(id)}`);
  }

  async get(path: string, query: Query = {}): Promise<unknown[]> {
    return unwrapList(await this.request(path, query));
  }

  async getAll(path: string, query: Query = {}, cap = PAGE_SIZE * MAX_PAGES): Promise<unknown[]> {
    const collected: unknown[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const limit = Math.min(PAGE_SIZE, cap - collected.length);
      if (limit <= 0) break;

      const batch = unwrapList(
        await this.request(path, { ...query, limit, offset: page * PAGE_SIZE }),
      );
      collected.push(...batch);
      if (batch.length < limit) break;
    }
    return collected;
  }
}
