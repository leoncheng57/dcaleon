import { useEffect, useState } from "react";

import { Button } from "../ds/button.js";
import { Markdown } from "../ds/markdown.js";
import { TranscriptLink } from "../lib/transcriptBrowser.js";
import { api, type ReviewCheck, type ReviewCommit, type ReviewDetails, type ReviewStatus } from "../lib/api.js";

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

function safeExternalUrl(value: string): string | null {
  return /^https?:\/\//i.test(value) ? value : null;
}

function Truncated({ show }: { show: boolean }) {
  return show ? <span className="text-[10px] text-[var(--color-text-muted)]">Limited result set</span> : null;
}

function CheckRow({ check }: { check: ReviewCheck }) {
  const duration = formatDuration(check.duration);
  const externalUrl = safeExternalUrl(check.webUrl);
  const content = (
    <span className="flex min-w-0 items-center gap-1.5 text-[11px]">
      <span aria-hidden>{check.status === "passed" ? "[x]" : check.status === "failed" ? "[!]" : "[~]"}</span>
      <span className="min-w-0 flex-1 break-words">{check.name}</span>
      {duration && <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{duration}</span>}
    </span>
  );
  return (
    <li data-testid="opencode-review-check" data-status={check.status}>
      {externalUrl ? <TranscriptLink href={externalUrl} target="_blank" rel="noreferrer" className="block underline">{content}</TranscriptLink> : content}
    </li>
  );
}

function CommitRow({ commit }: { commit: ReviewCommit }) {
  const externalUrl = safeExternalUrl(commit.webUrl);
  const content = (
    <span className="flex min-w-0 items-baseline gap-1.5 text-[11px]">
      <code className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{commit.shortSha}</code>
      <span className="min-w-0 flex-1 break-words">{commit.subject || "(no commit message)"}</span>
      {commit.author && <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{commit.author}</span>}
    </span>
  );
  return (
    <li data-testid="opencode-review-commit" data-sha={commit.shortSha}>
      {externalUrl ? <TranscriptLink href={externalUrl} target="_blank" rel="noreferrer" className="block underline" title={`View the diff for ${commit.shortSha}`}>{content}</TranscriptLink> : content}
      {commit.subjectTruncated && <Truncated show />}
    </li>
  );
}

export function ReviewCard({ url }: { url: string }) {
  const [review, setReview] = useState<ReviewStatus | null>(null);
  const [details, setDetails] = useState<ReviewDetails | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void api.review(url).then((result) => setReview(result.review)).catch(() => setError("Live status unavailable"));
  }, [url]);

  const toggleDetails = () => {
    const next = !expanded;
    setExpanded(next);
    if (!next || details || detailsLoading) return;
    setDetailsLoading(true);
    setDetailsError("");
    void api.reviewDetails(url)
      .then((result) => setDetails(result.details))
      .catch(() => setDetailsError("Review details unavailable"))
      .finally(() => setDetailsLoading(false));
  };

  const merge = () => {
    if (!review?.headSha || !window.confirm(`Merge ${review.title} at ${review.headSha.slice(0, 8)}?`)) return;
    void api.mergeReview(url, review.headSha)
      .then(() => setReview({ ...review, state: "merged", mergeable: false }))
      .catch(() => setError("Merge failed"));
  };

  return (
    <article className="min-w-0 max-w-full overflow-hidden rounded border border-[var(--color-border-default)] p-2" data-testid="opencode-review-card" data-state={review?.state ?? (error ? "error" : "loading")}>
      <TranscriptLink href={url} target="_blank" rel="noreferrer" className="block break-words text-xs font-semibold underline">
        {review?.title ?? url}
      </TranscriptLink>
      {review && <p className="mt-0.5 break-words text-[11px] text-[var(--color-text-muted)]">{review.project} #{review.number}</p>}
      {review ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
          <span>{review.forge}</span><span>{review.state}</span><span>{review.author}</span>
          {review.pipeline && <span data-testid="opencode-review-check-summary">checks {review.pipeline}</span>}
          {review.mergeable && review.state === "open" && (
            <Button size="sm" variant="secondary" disabled={!review.headSha} onClick={merge} data-testid="opencode-merge-review">Merge</Button>
          )}
        </div>
      ) : <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{error || "Loading status..."}</p>}
      {error && review && <p className="mt-1 text-[11px] text-[var(--color-text-critical)]">{error}</p>}

      {review && (
        <>
          <button type="button" className="mt-2 w-full border-t border-[var(--color-border-default)] pt-2 text-left text-[11px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]" aria-expanded={expanded} onClick={toggleDetails} data-testid="opencode-review-details-toggle">
            {expanded ? "[-]" : "[+]"} Review details
          </button>
          {expanded && (
            <div className="mt-2 min-w-0 space-y-3 overflow-hidden" data-testid="opencode-review-details">
              {detailsLoading && <p className="text-xs text-[var(--color-text-muted)]">Loading commits, discussion, and checks...</p>}
              {detailsError && <p className="text-[11px] text-[var(--color-text-muted)]">{detailsError}</p>}
              {details && (
                <>
                  {details.auth === "rate_limited" && <p className="text-[11px] text-[var(--color-text-muted)]" data-testid="opencode-review-rate-limited">Forge rate limit reached. Showing available details.</p>}
                  {details.auth === "unavailable" && <p className="text-[11px] text-[var(--color-text-muted)]" data-testid="opencode-review-auth-unavailable">Forge authentication unavailable. Public details may still be shown.</p>}
                  {details.partial && <p className="text-[11px] text-[var(--color-text-muted)]" data-testid="opencode-review-partial">Some live details are unavailable.</p>}
                  <section data-testid="opencode-review-commits">
                    <div className="flex items-center justify-between gap-2"><h3 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Commits ({details.commits.value.length})</h3><Truncated show={details.commits.truncated} /></div>
                    {details.commits.error && <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">Commits {details.commits.error.toLowerCase()}.</p>}
                    {!details.commits.error && details.commits.value.length === 0 && <p className="mt-1 text-xs text-[var(--color-text-muted)]">No commits found.</p>}
                    <ul className="mt-1 space-y-1">{details.commits.value.map((commit) => <CommitRow key={commit.sha} commit={commit} />)}</ul>
                  </section>
                  <section data-testid="opencode-review-comments">
                    <div className="flex items-center justify-between gap-2"><h3 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Discussion ({details.comments.value.length})</h3><Truncated show={details.comments.truncated} /></div>
                    {details.comments.error && <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">Discussion {details.comments.error.toLowerCase()}.</p>}
                    {!details.comments.error && details.comments.value.length === 0 && <p className="mt-1 text-xs text-[var(--color-text-muted)]">No comments yet.</p>}
                    <ul className="mt-1 space-y-2">{details.comments.value.map((comment) => <li key={comment.id} className="min-w-0 text-xs" data-testid="opencode-review-comment"><div className="flex flex-wrap gap-1 text-[11px]"><strong>{comment.author}</strong>{comment.resolved && <span className="text-[var(--color-text-muted)]">resolved</span>}</div><Markdown source={comment.body} untrusted className="break-words" />{comment.bodyTruncated && <Truncated show />}</li>)}</ul>
                  </section>
                  {details.reviews.value.length > 0 && <section data-testid="opencode-review-reviews"><div className="flex items-center justify-between gap-2"><h3 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Reviews ({details.reviews.value.length})</h3><Truncated show={details.reviews.truncated} /></div><ul className="mt-1 space-y-2">{details.reviews.value.map((item) => <li key={item.id} className="text-xs"><strong>{item.author}</strong> <span className="text-[var(--color-text-muted)]">{item.state}</span><Markdown source={item.body} untrusted className="break-words" /><Truncated show={item.bodyTruncated} /></li>)}</ul></section>}
                  {details.pipelines.value.length > 0 && <section data-testid="opencode-review-pipelines"><h3 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Pipelines</h3><ul className="mt-1 space-y-1">{details.pipelines.value.map((pipeline) => { const externalUrl = safeExternalUrl(pipeline.webUrl); return <li key={pipeline.id} data-status={pipeline.status} className="text-[11px]">{externalUrl ? <TranscriptLink href={externalUrl} target="_blank" rel="noreferrer" className="underline">Pipeline {pipeline.id}: {pipeline.status}</TranscriptLink> : <span>Pipeline {pipeline.id}: {pipeline.status}</span>}</li>; })}</ul></section>}
                  <section data-testid="opencode-review-checks">
                    <div className="flex items-center justify-between gap-2"><h3 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Checks and jobs ({details.checks.value.length})</h3><Truncated show={details.checks.truncated} /></div>
                    {details.checks.error && <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">Checks {details.checks.error.toLowerCase()}.</p>}
                    {!details.checks.error && details.checks.value.length === 0 && <p className="mt-1 text-xs text-[var(--color-text-muted)]">No checks have run.</p>}
                    <ul className="mt-1 space-y-1">{details.checks.value.map((check) => <CheckRow key={check.id} check={check} />)}</ul>
                  </section>
                </>
              )}
            </div>
          )}
        </>
      )}
    </article>
  );
}
