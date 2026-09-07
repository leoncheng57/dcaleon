import { execFile } from "node:child_process";

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cached: CachedToken | null = null;

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

export async function getClaudeOAuthToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.accessToken;

  const raw = await readKeychain();
  const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } };
  const oauth = parsed.claudeAiOauth;
  if (!oauth?.accessToken) throw new Error("No claudeAiOauth.accessToken in Keychain entry");

  cached = { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt ?? Date.now() + 3_600_000 };
  return cached.accessToken;
}

export function clearCachedToken(): void {
  cached = null;
}
