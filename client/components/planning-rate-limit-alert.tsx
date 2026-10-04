import { Alert } from "../ds/alert.js";

export function PlanningRateLimitAlert({ "data-testid": testId }: { "data-testid": string }) {
  return (
    <Alert data-testid={testId} variant="warning">
      GitHub API rate limit reached. Set{" "}
      <code className="rounded bg-[var(--color-background-surface)] px-1 font-mono">GITHUB_TOKEN</code> in your{" "}
      <code className="rounded bg-[var(--color-background-surface)] px-1 font-mono">.env</code> file to increase the limit from 60 to 5,000 requests/hour. Restart the server after setting it.
    </Alert>
  );
}
