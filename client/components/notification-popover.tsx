import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Bell, ChevronDown, ChevronRight, Settings } from "lucide-react";
import { Link } from "react-router-dom";

import { Alert } from "../ds/alert.js";
import { Badge } from "../ds/badge.js";
import { Button } from "../ds/button.js";
import { cn } from "../ds/utils.js";
import type { NotificationRecord } from "../lib/api.js";
import { groupBySession } from "../lib/notificationGroups.js";
import { useNotificationCenter } from "../lib/useNotificationCenter.js";
import { NotificationFilters } from "./notification-filters.js";
import { NotificationGroup } from "./notification-group.js";
import { NotificationRecordRow } from "./notification-record-row.js";

/** Highest number the decorative pill prints literally; above this it reads "99+". */
const BADGE_CAP = 99;

/**
 * One bounded, independently scrolling section of the popover. Active and
 * Resolved keep separate scrollers so a long backlog on one side never hides
 * the other — and never grows the nav.
 *
 * When `collapsed` is supplied the heading becomes a disclosure button. Only
 * Resolved uses it: resolved rows are an archive, and an archive should not
 * cost the live list half the panel.
 */
function RecordSection({
  title,
  records,
  emptyLabel,
  testId,
  onResolvedChange,
  footer,
  maxHeight = "max-h-64",
  collapsed,
  onToggle,
  grouped = false,
  isGroupExpanded,
  toggleGroup,
  onNavigate,
  onResolveMany,
  onError,
}: {
  title: string;
  records: NotificationRecord[];
  emptyLabel: string;
  testId: string;
  onResolvedChange: (id: string, resolved: boolean) => void;
  footer?: ReactNode;
  maxHeight?: string;
  collapsed?: boolean;
  onToggle?: () => void;
  /** Collect rows under one header per session. Grouping happens inside a
   *  section, never across them: a session's unresolved and resolved rows
   *  belong on opposite sides of the Active/Resolved split. */
  grouped?: boolean;
  isGroupExpanded?: (key: string) => boolean;
  toggleGroup?: (key: string) => void;
  onNavigate?: () => void;
  onResolveMany?: (ids: string[]) => Promise<void>;
  onError?: (error: Error) => void;
}) {
  const headingId = `${testId}-heading`;
  const bodyId = `${testId}-body`;
  const collapsible = collapsed !== undefined;
  const count = (
    <span className="tabular-nums" data-testid={`${testId}-count`}>
      {records.length}
    </span>
  );
  const headingClass =
    "flex w-full shrink-0 items-center gap-2 px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]";

  return (
    <section
      className="flex min-h-0 min-w-0 flex-col rounded-md border border-[var(--color-border-default)]"
      aria-labelledby={headingId}
    >
      <h3 className={cn("shrink-0", !collapsible && "border-b border-[var(--color-border-default)]")} id={headingId}>
        {collapsible ? (
          <button
            type="button"
            aria-controls={bodyId}
            aria-expanded={!collapsed}
            className={cn(
              headingClass,
              "rounded-t-md hover:bg-[var(--color-background-surface-neutral-muted)]",
              !collapsed && "border-b border-[var(--color-border-default)]",
            )}
            onClick={onToggle}
            data-testid={`${testId}-toggle`}
          >
            {collapsed ? <ChevronRight aria-hidden="true" size={13} /> : <ChevronDown aria-hidden="true" size={13} />}
            {title}
            {count}
          </button>
        ) : (
          <span className={headingClass}>
            {title}
            {count}
          </span>
        )}
      </h3>
      {!collapsed && (
        <div className="flex min-h-0 flex-col" id={bodyId}>
          {records.length === 0 ? (
            <p className="p-3 text-xs text-[var(--color-text-muted)]" data-testid={`${testId}-empty`}>
              {emptyLabel}
            </p>
          ) : (
            <ul
              className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", maxHeight)}
              data-testid={testId}
            >
              {grouped
                ? groupBySession(records).map((group) => (
                    <NotificationGroup
                      key={group.key}
                      group={group}
                      expanded={isGroupExpanded?.(group.key) ?? true}
                      onToggle={() => toggleGroup?.(group.key)}
                      onResolvedChange={onResolvedChange}
                      onResolveMany={onResolveMany}
                      onError={onError}
                      compact
                      onNavigate={onNavigate}
                    />
                  ))
                : records.map((record) => (
                    <NotificationRecordRow
                      key={record.id}
                      record={record}
                      onResolvedChange={onResolvedChange}
                      compact
                      onNavigate={onNavigate}
                    />
                  ))}
            </ul>
          )}
          {footer}
        </div>
      )}
    </section>
  );
}

/**
 * Plural-safe copy for the count of unresolved records outside the window.
 *
 * Names the footer link by its visible label. The two have to be changed
 * together: an instruction that points at "the full notification history" when
 * the only link on screen reads "See all notifications and settings" sends the
 * reader looking for a control that is not there.
 */
function outsideWindowNotice(hidden: number): string {
  return hidden === 1
    ? "1 older unresolved record is outside this view. See all notifications and settings below to reach it."
    : `${hidden} older unresolved records are outside this view. See all notifications and settings below to reach them.`;
}

/**
 * Nav notification centre. The trigger is a button, never a link: opening the
 * centre must not cost the user their place in a conversation. The full,
 * filterable history still lives at /settings/notifications.
 */
export function NotificationPopover({ scopedPath }: { scopedPath: (path: string) => string }) {
  const {
    activeCount,
    records,
    suppressedActive,
    view,
    setView,
    isGroupExpanded,
    toggleGroup,
    setAllGroupsCollapsed,
    loading,
    error,
    setResolved,
    resolveMany,
  } = useNotificationCenter();
  const [open, setOpen] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  // Focus the panel itself rather than its first control: the first control is
  // a Resolve button, and landing on it invites an accidental toggle.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const { active, resolved } = useMemo(
    () => ({
      active: records.filter((record) => record.resolvedAt === undefined),
      resolved: records.filter((record) => record.resolvedAt !== undefined),
    }),
    [records],
  );

  const onResolvedChange = (id: string, next: boolean) => {
    void setResolved(id, next).catch((e: Error) => setMutationError(e.message));
  };

  // The centre loads only the newest page of history, while activeCount is the
  // server's unwindowed total. Manual-only resolution (AGENTS.md decision 10)
  // retains every unresolved record, so exceeding the window is the steady
  // state, not an edge case. The column header must keep counting the rows it
  // actually renders; the gap is named here instead of being papered over.
  const hiddenActive = Math.max(0, activeCount - active.length);

  // The label carries the exact count and is the real contract; the pill is
  // decorative and caps, because resolution is manual-only (AGENTS.md decision
  // 10) so a real backlog reaches three digits and would swallow the bell.
  const label = activeCount > 0 ? `Notifications, ${activeCount} unresolved` : "Notifications";
  const badgeCount = activeCount > BADGE_CAP ? `${BADGE_CAP}+` : String(activeCount);

  return (
    <div
      className="relative"
      ref={wrapperRef}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        close();
      }}
    >
      <Button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        className="relative size-8 shrink-0 p-0 pointer-coarse:size-11"
        onClick={() => (open ? close() : setOpen(true))}
        ref={triggerRef}
        size="sm"
        title={label}
        type="button"
        variant="ghost"
        data-testid="opencode-nav-notifications"
      >
        <Bell aria-hidden="true" size={16} />
        {activeCount > 0 && (
          // The count is already in the button label so screen readers
          // announce it; the pill itself is decorative and capped.
          <Badge
            variant="counter"
            className="absolute -right-1.5 -top-1 h-4 min-w-4 px-1 text-[10px] leading-none"
            aria-hidden="true"
            data-testid="opencode-nav-notifications-badge"
          >
            {badgeCount}
          </Badge>
        )}
      </Button>
      {open && (
        <>
          {/* Phone-width scrim. The panel spans the viewport there, so without
              a dimmed page behind it there is no visual cue that anything is
              floating. Desktop relies on the elevation shadow instead. */}
          <div
            aria-hidden="true"
            className="fixed inset-0 z-40 bg-[var(--color-background-overlay)] sm:hidden"
            onPointerDown={() => close(false)}
            data-testid="opencode-notification-popover-scrim"
          />
          <div
            aria-label="Notifications"
            className="has-shadow-overlay fixed inset-x-2 top-11 z-50 flex max-h-[min(32rem,calc(100dvh-4rem))] flex-col gap-2 rounded-lg bg-[var(--color-background-surface-raised)] p-2 sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-[34rem]"
            id={panelId}
            ref={panelRef}
            role="dialog"
            tabIndex={-1}
            data-testid="opencode-notification-popover"
          >
            {error && <Alert variant="danger">{error}</Alert>}
            {mutationError && <Alert variant="danger">{mutationError}</Alert>}
            <NotificationFilters
              view={view}
              onChange={setView}
              suppressedActive={suppressedActive}
              onAllGroupsCollapsedChange={setAllGroupsCollapsed}
              className="shrink-0 px-1 pb-1"
            />
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
              <RecordSection
                title="Active"
                records={active}
                emptyLabel={
                  loading
                    ? "Loading..."
                    : hiddenActive > 0
                      // "Nothing unresolved" would be a confident falsehood when
                      // the server says otherwise.
                      ? "No unresolved records in this view."
                      : "Nothing unresolved."
                }
                testId="opencode-notification-popover-active"
                onResolvedChange={onResolvedChange}
                grouped={view.groupBySession}
                isGroupExpanded={isGroupExpanded}
                toggleGroup={toggleGroup}
                onNavigate={() => close(false)}
                onResolveMany={resolveMany}
                onError={(error) => setMutationError(error.message)}
                footer={
                  hiddenActive > 0 ? (
                    <p
                      className="shrink-0 border-t border-[var(--color-border-default)] p-2 text-[11px] text-[var(--color-text-muted)]"
                      data-testid="opencode-notification-popover-active-outside-window"
                    >
                      {outsideWindowNotice(hiddenActive)}
                    </p>
                  ) : undefined
                }
              />
              <RecordSection
                title="Resolved"
                records={resolved}
                emptyLabel={loading ? "Loading..." : "Nothing resolved yet."}
                testId="opencode-notification-popover-resolved"
                onResolvedChange={onResolvedChange}
                grouped={view.groupBySession}
                isGroupExpanded={isGroupExpanded}
                toggleGroup={toggleGroup}
                onNavigate={() => close(false)}
                maxHeight="max-h-48"
                collapsed={!view.resolvedExpanded}
                onToggle={() => setView({ resolvedExpanded: !view.resolvedExpanded })}
              />
            </div>
            {/* Pinned below the scroller, not inside it: this is the way out of
                the popover, and a link that scrolls away with the backlog is
                missing exactly when a long backlog makes it worth reaching.
                Centred and full-width so it reads as the panel's footer rather
                than as one more left-aligned row in the list above it. */}
            <Link
              className="flex shrink-0 items-center justify-center gap-1.5 rounded px-2 py-2 text-xs underline underline-offset-2 hover:bg-[var(--color-background-surface-neutral-muted)]"
              onClick={() => close(false)}
              to={scopedPath("/settings/notifications")}
              data-testid="opencode-notification-popover-history"
            >
              <Settings aria-hidden="true" size={14} className="shrink-0" />
              See all notifications and settings
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
