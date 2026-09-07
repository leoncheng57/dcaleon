import { ExternalLink } from "lucide-react";

/**
 * The landing page. Deliberately near-empty: every runtime (OpenCode, DSH,
 * Claude) is a peer reached from the navbar, so the root no longer belongs to
 * any one of them. Anything worth explaining lives in the public repository.
 */
export const REPOSITORY_URL = "https://github.com/leoncheng57/dcaleon";

export function HomePage() {
  return (
    <main className="flex h-full items-center justify-center p-6" data-testid="opencode-home">
      <div className="max-w-md space-y-3 text-center">
        <h1 className="text-2xl font-bold tracking-tight">DCA</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Pick a runtime from the navigation bar. For what this is and how it works, read the public GitHub repository.
        </p>
        <a
          href={REPOSITORY_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--color-text-info)] underline underline-offset-4"
          data-testid="opencode-home-repository"
        >
          leoncheng57/dcaleon
          <ExternalLink aria-hidden="true" size={14} />
        </a>
      </div>
    </main>
  );
}
