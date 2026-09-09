import { useEffect, useState, type ReactNode } from "react";
import { ShieldAlert } from "lucide-react";

import { Alert } from "../ds/alert.js";
import { cn } from "../ds/utils.js";
import { api, type AutoPermissionStatus } from "../lib/api.js";

const POLL_MS = 3_000;

/**
 * `block` is the original full-width banner (the Hub still uses it).
 * `compact` shrinks the control to a toolbar chip so it can sit inline beside
 * the conversation action buttons instead of eating a row of its own. Both
 * variants keep the same danger treatment, the same Details disclosure and the
 * same error paragraph — compactness is only allowed to cost padding, never
 * discoverability. `pill` is the action-bar switch; its adjacent info button
 * owns the full safety explanation.
 */
type AutoPermissionsVariant = "block" | "compact" | "pill";

/**
 * Where the switch reads and writes. The default is the directory-scoped
 * `/api/auto-approve?directory=` pair. A Claude conversation cannot use that —
 * the browser never learns a Claude session's path — so it supplies the
 * session-scoped routes instead; the switch it renders is the same directory
 * toggle by another handle, never a second policy.
 */
export interface AutoPermissionsSource {
  read: () => Promise<AutoPermissionStatus>;
  write: (enabled: boolean) => Promise<AutoPermissionStatus>;
}

export function AutoPermissionsControl({
  directory,
  testId,
  variant = "block",
  trailing,
  source,
}: {
  /** Scope key: the project directory, or any stable id when `source` is supplied. */
  directory: string;
  testId: string;
  variant?: AutoPermissionsVariant;
  trailing?: ReactNode;
  source?: AutoPermissionsSource;
}) {
  const [status, setStatus] = useState<AutoPermissionStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  useEffect(() => {
    setStatus(null);
    setShowDetails(false);
    setRequestError(null);
    if (!directory) return;
    let cancelled = false;
    const read = source?.read ?? (() => api.autoPermissions(directory));
    const refresh = () => void read().then((next) => {
      if (!cancelled) {
        setStatus(next);
        setRequestError(null);
      }
    }).catch((error: Error) => {
      if (!cancelled) setRequestError(error.message);
    });
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [directory, source]);

  const toggle = async () => {
    if (!directory || !status || saving) return;
    setSaving(true);
    setRequestError(null);
    try {
      const next = await (source ? source.write(!status.enabled) : api.setAutoPermissions(directory, !status.enabled));
      setStatus(next);
      if (!next.enabled) setShowDetails(false);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const enabled = status?.enabled ?? false;
  const compact = variant === "compact";
  const pill = variant === "pill";
  const actionLabel = saving ? "Updating auto permissions" : `Turn auto permissions ${enabled ? "off" : "on"}`;
  const safetyDescription = status?.error ?? requestError ?? "Auto permissions safety information is available next to this switch.";
  if (pill) {
    return (
      <div className="relative" data-testid={testId}>
        <div
          className={cn(
            "inline-flex min-h-11 items-center rounded-xl border px-1 transition-colors",
            enabled
              ? "border-[var(--color-text-info)] bg-[var(--color-background-surface-info-muted)] text-[var(--color-text-info)]"
              : "border-[var(--color-border-default)] text-[var(--color-text-muted)]",
          )}
          data-testid={`${testId}-group`}
        >
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={actionLabel}
            aria-describedby={`${testId}-description`}
            aria-busy={saving}
            disabled={!status || saving || !directory}
            onClick={() => void toggle()}
            title={actionLabel}
            className="flex min-h-9 min-w-[4.5rem] items-center justify-center rounded-full disabled:opacity-50"
            data-testid={`${testId}-toggle`}
          >
            <span aria-hidden="true" className="relative h-7 w-16 rounded-full border border-current">
              <span className={cn(
                "absolute left-1 top-1 h-[1.125rem] w-[1.125rem] rounded-full bg-current transition-transform",
                enabled && "translate-x-9",
              )} />
              <span
                className={cn(
                  "absolute top-1/2 -translate-y-1/2 text-[10px] font-semibold",
                  enabled ? "left-2" : "right-2",
                )}
                data-testid={`${testId}-state`}
              >
                {enabled ? "ON" : "OFF"}
              </span>
            </span>
          </button>
          {trailing && <div className="flex shrink-0">{trailing}</div>}
        </div>
        <span id={`${testId}-description`} className="sr-only">{safetyDescription}</span>
        {(status?.error || requestError) && (
          <p
            className="absolute right-0 top-full z-20 mt-1 min-w-64 rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-surface)] p-2 text-xs font-medium text-[var(--color-text-danger)] shadow-lg"
            data-testid={`${testId}-error`}
          >
            Auto permissions error: {status?.error ?? requestError}
          </p>
        )}
      </div>
    );
  }
  // Hit area is decided by pointer type, never by viewport width — the same
  // mechanism `COMPACT_ACTION` in Conversation.tsx uses for the action buttons
  // sitting beside this control in the same toolbar row. A touch tablet at
  // 768px is still a touch tablet, and this toggle is the most dangerous
  // control in the row, so it must not be the one that shrinks.
  //
  // styles.css already floors every `button` at 44px under `(pointer: coarse)`,
  // but that is a global net this component must not silently depend on: the
  // utility below keeps the control correct on its own.
  const touchTarget = compact ? "min-h-7 pointer-coarse:min-h-11" : "";
  return (
    <div data-testid={testId} className={cn(compact && "min-w-0")}>
      <Alert
        variant={enabled ? "danger" : "info"}
        className={cn(
          "border border-current",
          compact
            ? "flex min-w-0 flex-wrap items-center gap-x-2 rounded-md px-2 py-0 text-xs"
            : "px-3 py-2",
        )}
      >
        <div className={cn("flex items-center gap-2", compact ? `min-w-0 ${touchTarget}` : "min-h-5")}>
          <ShieldAlert aria-hidden="true" className={cn("shrink-0", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
          <strong className={cn("min-w-0 truncate", compact ? "text-[11px] sm:text-xs" : "flex-1 text-xs sm:text-sm")}>
            {compact ? "Auto" : `Auto permissions: ${status ? (enabled ? "ON" : "OFF") : "loading"}`}
          </strong>
          {enabled && <button
            type="button"
            aria-expanded={showDetails}
            onClick={() => setShowDetails((visible) => !visible)}
            className={cn(
              "shrink-0 font-medium underline underline-offset-2",
              compact ? `inline-flex items-center text-[11px] sm:text-xs ${touchTarget}` : "text-xs",
            )}
            data-testid={`${testId}-details`}
          >
            Details
          </button>}
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={saving ? "Updating auto permissions" : `Turn auto permissions ${enabled ? "off" : "on"}`}
            aria-busy={saving}
            disabled={!status || saving || !directory}
            onClick={() => void toggle()}
            className={cn(
              "inline-flex shrink-0 items-center justify-center disabled:opacity-50",
              compact ? `w-9 pointer-coarse:w-11 ${touchTarget}` : "h-5 w-9",
            )}
            data-testid={`${testId}-toggle`}
          >
            <span
              aria-hidden="true"
              className={cn(
                "relative block h-5 w-9 rounded-full border border-current transition-colors",
                enabled ? "bg-current" : "bg-transparent",
              )}
            >
              <span
                className={cn(
                  "absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full bg-[var(--color-background-surface)] transition-transform",
                  enabled ? "translate-x-4" : "translate-x-0",
                )}
              />
            </span>
          </button>
        </div>
        {enabled && showDetails && <p
          className={cn("text-xs font-medium", compact ? "basis-full pb-1.5" : "mt-2")}
          data-testid={`${testId}-warning`}
        >
          Danger: every asked permission is approved once automatically, including arbitrary shell commands,
          external-directory access, and repeated requests from a doom loop. This affects every session using
          this project directory and resets to off when the BFF restarts.
        </p>}
        {(status?.error || requestError) && (
          <p
            className={cn("text-xs font-medium", compact ? "basis-full pb-1.5" : "mt-2")}
            data-testid={`${testId}-error`}
          >
            Auto permissions error: {status?.error ?? requestError}
          </p>
        )}
      </Alert>
    </div>
  );
}
