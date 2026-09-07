import { useEffect, useRef, useState } from "react";
import { Activity } from "lucide-react";
import { api, type ClaudeUsage, type ClaudeUsageBucket } from "../lib/api.js";
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
          style={{ width: `${Math.min(100, bucket.utilization)}%` }}
        />
      </div>
      {bucket.resetsAt && (
        <div className="text-[10px] text-[var(--color-text-muted)]">{formatCountdown(bucket.resetsAt)}</div>
      )}
    </div>
  );
}

export function ClaudeUsageIndicator() {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null);
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    const poll = () => {
      api.claudeUsage().then((data) => { if (active) setUsage(data); }).catch(() => {});
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

  if (!usage || !usage.available) return null;

  const pct = Math.round(usage.session.utilization);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className={cn(
          "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs tabular-nums transition-colors",
          "text-[var(--color-text-muted)] hover:bg-[var(--color-background-surface-neutral-muted)] hover:text-[var(--color-text-default)]",
        )}
        onClick={() => setOpen((v) => !v)}
        title="Claude usage"
        data-testid="claude-usage-trigger"
      >
        <Activity size={13} aria-hidden="true" />
        <div className="flex items-center gap-1.5">
          <div className="h-1.5 w-12 rounded-full bg-[var(--color-background-surface-neutral-muted)]">
            <div
              className={cn("h-full rounded-full transition-all", barColor(pct))}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
          <span>{pct}%</span>
        </div>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-background-surface)] p-3 shadow-lg"
          data-testid="claude-usage-popover"
        >
          <div className="mb-2 text-xs font-medium">Usage limits</div>
          <div className="space-y-2.5">
            <Bucket label="Current session" bucket={usage.session} />
            <Bucket label="Weekly — all models" bucket={usage.weekly} />
            {Object.entries(usage.weeklyByModel).map(([model, bucket]) => (
              <Bucket key={model} label={`Weekly — ${model}`} bucket={bucket} />
            ))}
          </div>
          {usage.subscriptionType && (
            <div className="mt-2.5 border-t border-[var(--color-border-default)] pt-2 text-[10px] text-[var(--color-text-muted)]">
              Plan: {usage.subscriptionType}{usage.rateLimitTier ? ` · ${usage.rateLimitTier}` : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
