import { useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle } from "lucide-react";
import { api, type ClaudeTokenUsage, type ClaudeUsage, type ClaudeUsageBucket } from "../lib/api.js";
import { cn } from "../ds/utils.js";

const POLL_MS = 60_000;

function formatCountdown(resetsAt: string | null): string {
  if (!resetsAt) return "";
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (ms <= 0) return "resetting…";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

function barColor(utilization: number): string {
  if (utilization >= 90) return "bg-[var(--color-text-danger)]";
  if (utilization >= 70) return "bg-[var(--color-text-warning,orange)]";
  return "bg-[var(--color-text-link)]";
}

function Bucket({ label, bucket }: { label: string; bucket: ClaudeUsageBucket }) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span>{label}</span>
        <span className="tabular-nums">{Math.round(bucket.utilization)}%</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-[var(--color-background-surface-neutral-muted)]">
        <div
          className={cn("h-full rounded-full transition-all", barColor(bucket.utilization))}
          style={{ width: `${Math.max(0, Math.min(100, bucket.utilization))}%` }}
        />
      </div>
      {bucket.resetsAt && (
        <div className="text-[10px] text-[var(--color-text-muted)]">{formatCountdown(bucket.resetsAt)}</div>
      )}
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

type AvailableUsage = Extract<ClaudeUsage, { available: true }>;

export function ClaudeUsageIndicator({ tokenUsage }: { tokenUsage?: ClaudeTokenUsage }) {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null);
  /** Last successful response, kept through transient errors/429s (#452). */
  const [lastGood, setLastGood] = useState<{ data: AvailableUsage; at: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    const poll = () => {
      api.claudeUsage().then((data) => {
        if (!active) return;
        setUsage(data);
        if (data.available) setLastGood({ data, at: Date.now() });
      }).catch(() => {});
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => { active = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    const countdown = setInterval(() => setTick((n) => n + 1), POLL_MS);
    return () => { document.removeEventListener("mousedown", handler); clearInterval(countdown); };
  }, [open]);

  if (!usage) return null;

  // Three states, not two. A failed poll with a prior success is *stale*, not
  // unavailable: the last-good figures stay on screen with a warning rather
  // than being replaced by an icon that says nothing about where usage stands.
  const effective: AvailableUsage | null = usage.available ? usage : lastGood?.data ?? null;
  const unavailable = effective === null;
  const stale = !usage.available && effective !== null;
  const failureReason = usage.available ? "" : usage.reason;
  const pct = effective ? Math.round(effective.session.utilization) : 0;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className={cn(
          "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs tabular-nums transition-colors",
          "text-[var(--color-text-muted)] hover:bg-[var(--color-background-surface-neutral-muted)] hover:text-[var(--color-text-default)]",
          unavailable && "text-[var(--color-text-warning,orange)]",
        )}
        onClick={() => setOpen((v) => !v)}
        title={unavailable ? "Usage limits unavailable" : "Claude usage"}
        data-testid="claude-usage-trigger"
      >
        {unavailable
          ? <AlertTriangle size={13} aria-hidden="true" />
          : <Activity size={13} aria-hidden="true" />}
        {!unavailable && (
          <div className="flex items-center gap-1.5">
            <div className="h-1.5 w-12 rounded-full bg-[var(--color-background-surface-neutral-muted)]">
              <div
                className={cn("h-full rounded-full transition-all", barColor(pct))}
                style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
              />
            </div>
            <span>{pct}%</span>
          </div>
        )}
      </button>

      {open && (
        <div
          className="absolute left-0 top-full z-50 mt-1 w-64 max-w-[calc(100vw-1.5rem)] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-background-surface)] p-3 shadow-lg"
          data-testid="claude-usage-popover"
        >
          {!effective ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-warning,orange)]">
                <AlertTriangle size={12} />
                Usage limits unavailable
              </div>
              <p className="text-[11px] text-[var(--color-text-muted)]">
                Could not query usage limits{failureReason ? `: ${failureReason}` : ""}. You may hit a 429 rate limit without warning.
              </p>
            </div>
          ) : (<>
          <div className="mb-2 text-xs font-medium">Usage limits</div>
          {stale && (
            <div className="mb-2 flex items-start gap-1.5 rounded border border-[var(--color-border-warning,var(--color-border-default))] bg-[var(--color-background-surface-warning-muted)] px-2 py-1.5 text-[11px] text-[var(--color-text-warning)]" data-testid="claude-usage-stale">
              <AlertTriangle size={12} className="mt-px shrink-0" aria-hidden="true" />
              <span>Could not refresh{failureReason ? `: ${failureReason}` : ""}. Showing the last successful reading.</span>
            </div>
          )}
          <div className="space-y-2.5">
            <Bucket label="Current session" bucket={effective.session} />
            <Bucket label="Weekly — all models" bucket={effective.weekly} />
            {Object.entries(effective.weeklyByModel).map(([model, bucket]) => (
              <Bucket key={model} label={`Weekly — ${model}`} bucket={bucket} />
            ))}
          </div>
          {tokenUsage && (() => {
            // Cumulative across every turn. Deliberately NOT drawn as a bar
            // against `contextWindow`: that is a per-request limit, and the
            // ratio of a running total to it is not a fill level (#452).
            const totalTokens = tokenUsage.inputTokens + tokenUsage.cacheReadTokens + tokenUsage.cacheWriteTokens + tokenUsage.outputTokens;
            return (
              <div className="mt-2.5 space-y-2 border-t border-[var(--color-border-default)] pt-2">
                <div className="text-xs font-medium">Session tokens <span className="font-normal text-[var(--color-text-muted)]">(cumulative)</span></div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-[var(--color-text-muted)]">
                  <span>Input</span><span className="text-right tabular-nums">{formatTokens(tokenUsage.inputTokens)}</span>
                  <span>Output</span><span className="text-right tabular-nums">{formatTokens(tokenUsage.outputTokens)}</span>
                  {tokenUsage.cacheReadTokens > 0 && <><span>Cache read</span><span className="text-right tabular-nums">{formatTokens(tokenUsage.cacheReadTokens)}</span></>}
                  {tokenUsage.cacheWriteTokens > 0 && <><span>Cache write</span><span className="text-right tabular-nums">{formatTokens(tokenUsage.cacheWriteTokens)}</span></>}
                  {tokenUsage.thinkingTokens > 0 && <><span>Thinking</span><span className="text-right tabular-nums">{formatTokens(tokenUsage.thinkingTokens)}</span></>}
                  <span>Total</span><span className="text-right tabular-nums">{formatTokens(totalTokens)}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span>Estimated cost</span>
                  <span className="tabular-nums font-medium">{formatCost(tokenUsage.costUsd)}</span>
                </div>
              </div>
            );
          })()}
          {effective.subscriptionType && (
            <div className="mt-2.5 border-t border-[var(--color-border-default)] pt-2 text-[10px] text-[var(--color-text-muted)]">
              Plan: {effective.subscriptionType}{effective.rateLimitTier ? ` · ${effective.rateLimitTier}` : ""}
            </div>
          )}
          <div className="mt-2 text-[10px] text-[var(--color-text-muted)]" data-testid="claude-usage-freshness">
            Updated every 60 seconds{lastGood ? ` · last updated ${new Date(lastGood.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
          </div>
          </>)}
        </div>
      )}
    </div>
  );
}
