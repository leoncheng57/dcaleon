import { stat } from "node:fs/promises";

import { credentialSource, credentialsFilePath, getClaudeOAuthToken, type TokenOptions } from "./auth.js";

// What is worth waking someone for, and what is not.
//
// The tempting alert is "the access token expires soon". It is the wrong one.
// The `claude` CLI holds a short-lived access token — about eight hours on the
// cloud box — beside a refresh token, and refreshes lazily, when a turn next
// needs it. So:
//
//   * A threshold of days is tripped permanently. The token is *always* inside
//     it.
//   * A lapsed `expiresAt` is routine on an idle host. Nothing refreshed it
//     because nothing asked. The next turn will, and will succeed.
//
// Neither distinguishes a healthy quiet box from a broken one, and an alert
// that fires on a healthy box is worse than no alert: it trains you to ignore
// it. What *is* unambiguous is the store becoming unreadable — the file gone,
// the JSON malformed, no `accessToken` in it. That state never resolves on its
// own, it stops every turn, and on a headless host nothing else reports it.
//
// So `missing` is the alert. `stale` is reported and never alerted on.

export type CredentialState =
  /** Readable, and the access token has not lapsed. */
  | "ok"
  /** Readable, but `expiresAt` has passed. Normal on an idle host. */
  | "stale"
  /** Unreadable, unparseable, or carrying no access token. This is the alert. */
  | "missing"
  /** Not checked — the Claude island is unavailable on this host. */
  | "unchecked";

export interface CredentialHealth {
  state: CredentialState;
  source: "keychain" | "file" | null;
  /** Where the credentials live, so a failure names its own diagnosis. */
  path: string | null;
  expiresAt: string | null;
  /** Negative once the access token has lapsed. */
  expiresInMs: number | null;
  /** When the store was last rewritten — a refresh touches it. */
  refreshedAt: string | null;
  reason: string | null;
}

/** Only `missing` is worth an alert; see the note above. */
export function isAlertable(state: CredentialState): boolean {
  return state === "missing";
}

export interface ClassifyInput {
  expiresAt?: number | null;
  now: number;
}

/**
 * Pure, so the state machine is testable without a credential store. Splitting
 * `ok` from `stale` on the clock alone is deliberate: the distinction is
 * informational, and neither is an alert.
 */
export function classifyReadable(input: ClassifyInput): "ok" | "stale" {
  const expiresAt = input.expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return "ok";
  return expiresAt <= input.now ? "stale" : "ok";
}

export interface CredentialHealthOptions extends TokenOptions {
  now?: number;
  /** Absent on a host that does not run the Claude island. */
  available?: boolean;
}

/**
 * Never throws. A health probe that can fail is a health probe that takes the
 * BFF down with it, and this one runs on a timer.
 */
export async function readCredentialHealth(options: CredentialHealthOptions = {}): Promise<CredentialHealth> {
  const now = options.now ?? Date.now();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const source = credentialSource(platform);
  const location = source === "file" ? credentialsFilePath(env) : "Keychain: Claude Code-credentials";

  if (options.available === false) {
    return { state: "unchecked", source: null, path: null, expiresAt: null, expiresInMs: null, refreshedAt: null, reason: "the Claude island is unavailable on this host" };
  }

  const base = { source, path: location } as const;

  let expiresAt: number | null = null;
  try {
    // Reads through the same cache the usage panel uses, so a healthy box does
    // not re-read the Keychain once an hour just to be told what it knows.
    await getClaudeOAuthToken({ platform, env });
    expiresAt = await readExpiry({ platform, env });
  } catch (err) {
    return {
      ...base,
      state: "missing",
      expiresAt: null,
      expiresInMs: null,
      refreshedAt: null,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    ...base,
    state: classifyReadable({ expiresAt, now }),
    expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
    expiresInMs: expiresAt === null ? null : expiresAt - now,
    refreshedAt: source === "file" ? await lastWritten(credentialsFilePath(env)) : null,
    reason: null,
  };
}

/**
 * The cached token in auth.ts does not expose its own expiry, and widening that
 * module's contract for a diagnostic is not worth it — so the file is read
 * again here. On macOS the Keychain is not re-shelled for this: expiry there is
 * reported as unknown rather than paying a `security` call every probe.
 */
async function readExpiry(options: TokenOptions): Promise<number | null> {
  if (credentialSource(options.platform ?? process.platform) !== "file") return null;
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(credentialsFilePath(options.env ?? process.env), "utf8");
  const parsed = JSON.parse(raw) as { claudeAiOauth?: { expiresAt?: number } };
  const expiresAt = parsed.claudeAiOauth?.expiresAt;
  return typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : null;
}

async function lastWritten(file: string): Promise<string | null> {
  try {
    return (await stat(file)).mtime.toISOString();
  } catch {
    return null;
  }
}
