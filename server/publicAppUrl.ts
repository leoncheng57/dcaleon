export function parsePublicAppUrl(value: string | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("PUBLIC_APP_URL must be a valid HTTP(S) origin");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PUBLIC_APP_URL must use http or https");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PUBLIC_APP_URL must be an origin without credentials, a path, query, or fragment");
  }
  return url.origin;
}

/**
 * Claude runtime sessions are minted as `claude-<uuid>` (server/claude/store.ts)
 * and live under their own route with no `?directory=` scope. The prefix is
 * the discriminator the client's `sessionRoute` uses too; keep the two in step.
 */
export function isClaudeSessionId(sessionID: unknown): sessionID is string {
  return typeof sessionID === "string" && sessionID.startsWith("claude-");
}

export function conversationUrl(publicAppUrl: string | null, sessionID?: unknown, directory?: unknown): string | undefined {
  if (!publicAppUrl) return undefined;
  if (isClaudeSessionId(sessionID)) return new URL(`/claude/sessions/${encodeURIComponent(sessionID)}`, publicAppUrl).toString();
  if (typeof sessionID !== "string" || !sessionID || typeof directory !== "string" || !directory) return publicAppUrl;
  const url = new URL(`/sessions/${encodeURIComponent(sessionID)}`, publicAppUrl);
  url.searchParams.set("directory", directory);
  return url.toString();
}

export function eventClickUrl(
  publicAppUrl: string | null,
  event: { type: string; properties: Record<string, unknown>; directory?: string },
): string | undefined {
  if (!["question.asked", "permission.asked", "session.idle", "session.error"].includes(event.type)) return undefined;
  return conversationUrl(publicAppUrl, event.properties.sessionID, event.directory);
}
