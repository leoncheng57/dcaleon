import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Where the `claude` CLI keeps its OAuth credentials differs by platform, and
// the BFF only ever reads them — it never brokers auth (see the SAFE_ENV
// allowlist in `supervisor.ts`, which strips CLAUDE_CODE_OAUTH_TOKEN and
// ANTHROPIC_API_KEY on purpose so the binary authenticates from its own store).
//
//   macOS: the login Keychain, item "Claude Code-credentials".
//   Linux: `~/.claude/.credentials.json`, mode 0600, same JSON shape.
//
// The only consumer is the usage panel (`usage.ts`), so a failure here costs
// the limits display and nothing else — turns keep running.

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cached: CachedToken | null = null;

export type CredentialSource = "keychain" | "file";

/**
 * The OS decides this, not an env var: a var that claims Keychain on Linux
 * would just fail slower. Tests pass `platform` explicitly so both lanes are
 * covered from either host.
 */
export function credentialSource(platform: NodeJS.Platform = process.platform): CredentialSource {
  return platform === "darwin" ? "keychain" : "file";
}

/** `CLAUDE_CONFIG_DIR` is the CLI's own override, so honor it rather than hardcoding `~/.claude`. */
export function credentialsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  const root = configDir && configDir.length > 0 ? configDir : path.join(os.homedir(), ".claude");
  return path.join(root, ".credentials.json");
}

function readKeychain(): Promise<string> {
  const user = process.env.USER || process.env.LOGNAME || "unknown";
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-a", user, "-w", "-s", "Claude Code-credentials"],
      { timeout: 5_000 },
      (err, stdout) => {
        if (err) return reject(new Error(`Keychain read failed: ${err.message}`));
        resolve(stdout.trim());
      },
    );
  });
}

async function readCredentialsFile(env: NodeJS.ProcessEnv): Promise<string> {
  const file = credentialsFilePath(env);
  try {
    return (await readFile(file, "utf8")).trim();
  } catch (err) {
    // Named because the usual cause is a headless host where nobody has run
    // `claude` `/login` yet, and the path is the whole diagnosis.
    throw new Error(`Credentials file read failed (${file}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface TokenOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export async function getClaudeOAuthToken(options: TokenOptions = {}): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.accessToken;

  const env = options.env ?? process.env;
  const source = credentialSource(options.platform ?? process.platform);
  const raw = source === "keychain" ? await readKeychain() : await readCredentialsFile(env);

  const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } };
  const oauth = parsed.claudeAiOauth;
  const origin = source === "keychain" ? "Keychain entry" : `credentials file (${credentialsFilePath(env)})`;
  if (!oauth?.accessToken) throw new Error(`No claudeAiOauth.accessToken in ${origin}`);

  cached = { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt ?? Date.now() + 3_600_000 };
  return cached.accessToken;
}

export function clearCachedToken(): void {
  cached = null;
}
