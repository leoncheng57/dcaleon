import { Fragment, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Circle, ExternalLink, GitPullRequest, Layers3, MessageSquare, Plus, RefreshCw } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { Alert } from "../ds/alert.js";
import { Badge, type BadgeVariant } from "../ds/badge.js";
import { Button } from "../ds/button.js";
import { LoadingIndicator } from "../ds/loading-indicator.js";
import { CreateIssueDialog } from "../components/create-issue-dialog.js";
import { PlanningItemDialog } from "../components/planning-item-dialog.js";
import { PlanningRateLimitAlert } from "../components/planning-rate-limit-alert.js";
import {
  api,
  isPlanningGithubTokenMissing,
  type PlanningItem,
  type PlanningItemState,
  type PlanningItemType,
  type PlanningSnapshot,
} from "../lib/api.js";
import { filterPlanningItems, groupPlanningItems, type PlanningNode, type PlanningSection } from "../lib/planningGroups.js";
import { loadPlanningView, savePlanningView } from "../lib/planningView.js";

type TypeFilter = "all" | PlanningItemType;
type StateFilter = "all" | PlanningItemState;
type PlanningDensity = "comfortable" | "compact" | "dense" | "denser" | "densest";

const DENSITY_STORAGE_KEY = "opencode.planning.density";

const TYPE_FILTERS: Array<{ value: TypeFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "issue", label: "Issues" },
  { value: "pull_request", label: "Pull requests" },
];

const STATE_FILTERS: Array<{ value: StateFilter; label: string }> = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

const DENSITY_OPTIONS: Array<{ value: PlanningDensity; label: string }> = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
  { value: "dense", label: "Dense" },
  { value: "denser", label: "Denser" },
  { value: "densest", label: "Densest" },
];

const DENSITY_CLASSES: Record<PlanningDensity, {
  row: string;
  content: string;
  title: string;
  metadata: string;
}> = {
  comfortable: {
    row: "p-5 sm:p-6",
    content: "space-y-3",
    title: "text-lg leading-7",
    metadata: "text-sm leading-5",
  },
  compact: {
    row: "p-4 sm:p-5",
    content: "space-y-2.5",
    title: "text-base leading-6",
    metadata: "text-xs leading-4",
  },
  dense: {
    row: "px-4 py-2.5 sm:px-5 sm:py-3",
    content: "space-y-1.5",
    title: "text-sm leading-5",
    metadata: "text-[11px] leading-4",
  },
  denser: {
    row: "px-3 py-2 sm:px-4",
    content: "space-y-1",
    title: "text-[13px] leading-4",
    metadata: "text-[10px] leading-3",
  },
  densest: {
    row: "px-3 py-1.5 sm:px-4 sm:py-2",
    content: "space-y-1",
    title: "text-xs leading-4",
    metadata: "text-[11px] leading-3",
  },
};

function initialDensity(): PlanningDensity {
  try {
    const stored = localStorage.getItem(DENSITY_STORAGE_KEY);
    if (stored === "comfortable" || stored === "compact" || stored === "dense" || stored === "denser" || stored === "densest") return stored;
  } catch {
    // Storage may be unavailable in hardened browser contexts.
  }
  return "densest";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatFetchedAt(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function stateBadge(item: PlanningItem): { label: string; variant: BadgeVariant } {
  if (item.merged) return { label: "Merged", variant: "info" };
  if (item.state === "open") return { label: "Open", variant: "success" };
  return { label: "Closed", variant: "neutral" };
}

function labelBadge(label: string): BadgeVariant {
  switch (label.trim().toLocaleLowerCase()) {
    case "priority:high": return "danger";
    case "priority:medium": return "warning";
    default: return "neutral";
  }
}

function PlanningRow({ node, density, conflict, expanded, onOpen, onToggle }: {
  node: PlanningNode;
  density: PlanningDensity;
  conflict: boolean;
  expanded: boolean;
  onOpen: (item: PlanningItem) => void;
  onToggle: (number: number) => void;
}) {
  const item = node.item;
  const status = stateBadge(item);
  const classes = DENSITY_CLASSES[density];
  const expandable = node.children.length > 0;
  const epic = item.childCount > 0;
  const badgeClass = density === "densest"
    ? "px-1.5 py-0 text-[10px]"
    : density === "denser"
      ? "px-2 py-0 text-[10px]"
      : "";
  return (
    <li className={classes.row} data-testid="opencode-planning-row" data-planning-number={item.number}>
      <div className="flex min-w-0 items-start gap-3">
        {expandable ? (
          <button
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} epic #${item.number}`}
            className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-background-base)] hover:text-[var(--color-text-default)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            data-testid={`opencode-planning-epic-${item.number}-toggle`}
            onClick={() => onToggle(item.number)}
            type="button"
          >
            {expanded ? <ChevronDown aria-hidden="true" size={17} /> : <ChevronRight aria-hidden="true" size={17} />}
          </button>
        ) : (
          <span aria-hidden="true" className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center text-[var(--color-text-muted)]">
            {item.type === "pull_request" ? <GitPullRequest size={18} /> : <span className="text-base font-bold">#</span>}
          </span>
        )}
        <div className={`min-w-0 flex-1 ${classes.content}`}>
          <div className="flex flex-wrap items-center gap-2">
            {epic && (
              <Badge className={`${badgeClass} gap-1`} variant="info">
                <Layers3 aria-hidden="true" size={11} />
                Epic
              </Badge>
            )}
            <Badge className={badgeClass} variant={item.type === "pull_request" ? "info" : "neutral"}>
              {item.type === "pull_request" ? "Pull request" : "Issue"}
            </Badge>
            <span className="text-xs font-medium tabular-nums text-[var(--color-text-muted)]">
              #{item.number}
            </span>
            <Badge className={badgeClass} variant={status.variant}>{status.label}</Badge>
            {conflict && (
              <Badge className={`${badgeClass} gap-1 normal-case`} variant="danger">
                <AlertTriangle aria-hidden="true" size={11} />
                Resolve priority conflict
              </Badge>
            )}
            {item.labels.map((label) => (
              <Badge className={`${badgeClass} normal-case`} key={label} variant={labelBadge(label)}>
                {label}
              </Badge>
            ))}
          </div>

          <div className="flex min-w-0 items-start gap-1.5">
            <button
              aria-haspopup="dialog"
              className={`min-w-0 break-words text-left font-semibold text-[var(--color-text-default)] hover:text-[var(--color-text-info)] focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${classes.title}`}
              data-testid={`opencode-planning-item-${item.number}`}
              onClick={() => onOpen(item)}
              type="button"
            >
              {item.title || "Untitled"}
            </button>
            <a
              aria-label={`Open ${item.type === "pull_request" ? "pull request" : "issue"} #${item.number} on GitHub`}
              className="mt-0.5 shrink-0 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-info)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
              data-testid={`opencode-planning-item-${item.number}-external`}
              href={item.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              <ExternalLink aria-hidden="true" size={14} />
            </a>
          </div>

          <div className={`flex flex-wrap gap-x-4 gap-y-1 text-[var(--color-text-muted)] ${classes.metadata}`}>
            {node.orphanedParentNumber !== null && (
              <span data-testid={`opencode-planning-item-${item.number}-parent`}>Child of #{node.orphanedParentNumber}</span>
            )}
            <span>Created {formatDate(item.createdAt)}</span>
            <span>Last activity {formatDate(item.updatedAt)}</span>
            {item.author && <span>by {item.author}</span>}
            {item.commentCount > 0 && (
              <span className="inline-flex items-center gap-1" aria-label={`${item.commentCount} comments`}>
                <MessageSquare aria-hidden="true" size={12} />
                {item.commentCount}
              </span>
            )}
          </div>
          {epic && (
            <div className="flex min-w-0 items-center gap-2 text-xs text-[var(--color-text-muted)]">
              <span className="shrink-0 tabular-nums">{item.completedChildCount}/{item.childCount} closed</span>
              <span
                aria-label={`${item.completedChildCount} of ${item.childCount} children closed`}
                aria-valuemax={item.childCount}
                aria-valuemin={0}
                aria-valuenow={item.completedChildCount}
                className="h-1.5 min-w-12 max-w-32 flex-1 overflow-hidden rounded-full bg-[var(--color-background-base)]"
                data-testid={`opencode-planning-epic-${item.number}-progress`}
                role="progressbar"
              >
                <span
                  className="block h-full rounded-full bg-[var(--color-background-action-info)]"
                  style={{ width: `${item.childCount === 0 ? 0 : (item.completedChildCount / item.childCount) * 100}%` }}
                />
              </span>
              {node.unresolvedChildCount > 0 && <span className="truncate">{node.unresolvedChildCount} not loaded</span>}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function PlanningChildRow({ item, density, onOpen }: {
  item: PlanningItem;
  density: PlanningDensity;
  onOpen: (item: PlanningItem) => void;
}) {
  const badgeClass = density === "densest" || density === "denser" ? "px-1.5 py-0 text-[10px]" : "";
  const spacing = density === "comfortable" ? "py-3" : density === "compact" ? "py-2.5" : "py-2";
  return (
    <li
      className={`bg-[var(--color-background-base)] px-3 pl-10 sm:pl-14 ${spacing}`}
      data-testid="opencode-planning-child-row"
      data-planning-number={item.number}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span className={`mt-0.5 shrink-0 ${item.state === "closed" ? "text-[var(--color-text-success)]" : "text-[var(--color-text-muted)]"}`}>
          {item.state === "closed" ? <CheckCircle2 aria-hidden="true" size={15} /> : <Circle aria-hidden="true" size={15} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-1.5">
            <span className="shrink-0 text-xs font-medium tabular-nums text-[var(--color-text-muted)]">#{item.number}</span>
            <button
              aria-haspopup="dialog"
              className="min-w-0 break-words text-left text-xs font-medium leading-4 text-[var(--color-text-default)] hover:text-[var(--color-text-info)] focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] sm:text-sm"
              data-testid={`opencode-planning-item-${item.number}`}
              onClick={() => onOpen(item)}
              type="button"
            >
              {item.title || "Untitled"}
            </button>
            <a
              aria-label={`Open ${item.type === "pull_request" ? "pull request" : "issue"} #${item.number} on GitHub`}
              className="shrink-0 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-info)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
              data-testid={`opencode-planning-item-${item.number}-external`}
              href={item.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              <ExternalLink aria-hidden="true" size={13} />
            </a>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge className={badgeClass} variant={item.state === "closed" ? "neutral" : "success"}>{item.state === "closed" ? "Closed" : "Open"}</Badge>
            {item.labels.map((label) => (
              <Badge className={`${badgeClass} normal-case`} key={label} variant={labelBadge(label)}>{label}</Badge>
            ))}
          </div>
        </div>
      </div>
    </li>
  );
}

function PlanningGroupSection({ section, density, expandedEpics, onOpen, onToggleEpic }: {
  section: PlanningSection;
  density: PlanningDensity;
  expandedEpics: Set<number>;
  onOpen: (item: PlanningItem) => void;
  onToggleEpic: (number: number) => void;
}) {
  const [open, setOpen] = useState(section.defaultOpen);
  const isConflict = section.id === "conflict";

  return (
    <details
      className="group overflow-hidden rounded-lg border border-[var(--color-border-default)] bg-[var(--color-background-surface)]"
      data-testid={`opencode-planning-section-${section.id}`}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary
        className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)] [&::-webkit-details-marker]:hidden"
        data-testid={`opencode-planning-section-${section.id}-toggle`}
      >
        <div className="flex min-w-0 items-center gap-3">
          <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--color-text-muted)] transition-transform group-open:rotate-90" />
          <div className="min-w-0">
            <h2 className={`font-semibold ${isConflict ? "text-[var(--color-text-danger)]" : "text-[var(--color-text-default)]"}`}>
              {section.title}
            </h2>
            <p className="truncate text-xs text-[var(--color-text-muted)]">{section.subtitle}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center">
          {section.epicCount > 0 && <Badge variant="info">{section.epicCount} {section.epicCount === 1 ? "epic" : "epics"}</Badge>}
          <Badge variant={isConflict ? "danger" : section.id === "high" ? "warning" : "neutral"}>
            {section.count} {section.count === 1 ? "item" : "items"}
          </Badge>
        </div>
      </summary>

      <div className="border-t border-[var(--color-border-default)]">
        {section.groups.map((tagGroup) => {
          const count = tagGroup.nodes.reduce((total, node) => total + 1 + node.children.length, 0);
          return (
          <section data-testid={`opencode-planning-group-${section.id}-${tagGroup.label.toLocaleLowerCase()}`} key={tagGroup.label}>
            <header className="flex items-center justify-between gap-3 border-b border-[var(--color-border-default)] bg-[var(--color-background-base)] px-4 py-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{tagGroup.label}</h3>
              <span className="text-xs tabular-nums text-[var(--color-text-muted)]">{count}</span>
            </header>
            <ul className="divide-y divide-[var(--color-border-default)]">
              {tagGroup.nodes.map((node) => {
                const expanded = expandedEpics.has(node.item.number);
                return (
                  <Fragment key={`${node.item.type}-${node.item.id}`}>
                    <PlanningRow
                      conflict={isConflict}
                      density={density}
                      expanded={expanded}
                      node={node}
                      onOpen={onOpen}
                      onToggle={onToggleEpic}
                    />
                    {expanded && node.children.map((child) => (
                      <PlanningChildRow density={density} item={child} key={`${child.type}-${child.id}`} onOpen={onOpen} />
                    ))}
                  </Fragment>
                );
              })}
            </ul>
          </section>
          );
        })}
      </div>
    </details>
  );
}

export function PlanningPage() {
  const [params, setParams] = useSearchParams();
  const [snapshot, setSnapshot] = useState<PlanningSnapshot | null>(null);
  const [error, setError] = useState("");
  const [tokenMissing, setTokenMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [stateFilter, setStateFilter] = useState<StateFilter>("open");
  const [density, setDensity] = useState<PlanningDensity>(initialDensity);
  const [expandedEpicNumbers, setExpandedEpicNumbers] = useState(() => loadPlanningView().expandedEpics);
  const [createOpen, setCreateOpen] = useState(() => params.get("create") === "1");
  const [created, setCreated] = useState<PlanningItem | null>(null);

  const load = (refresh = false) => {
    setLoading(true);
    setError("");
    setTokenMissing(false);
    return api.planningItems(refresh)
      .then(setSnapshot)
      .catch((reason: unknown) => {
        setTokenMissing(isPlanningGithubTokenMissing(reason));
        setError(reason instanceof Error ? reason.message : "Unavailable");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setTokenMissing(false);
    void api.planningItems()
      .then((value) => {
        if (active) setSnapshot(value);
      })
      .catch((reason: unknown) => {
        if (active) {
          setTokenMissing(isPlanningGithubTokenMissing(reason));
          setError(reason instanceof Error ? reason.message : "Unavailable");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const items = filterPlanningItems(snapshot?.items ?? [], typeFilter, stateFilter);
  const sections = groupPlanningItems(items);
  const expandedEpics = new Set(expandedEpicNumbers);
  const visibleEpicNumbers = sections.flatMap((section) => section.groups.flatMap((group) =>
    group.nodes.filter((node) => node.children.length > 0).map((node) => node.item.number)));
  const everyVisibleEpicExpanded = visibleEpicNumbers.length > 0
    && visibleEpicNumbers.every((number) => expandedEpics.has(number));
  const itemParam = params.get("item");
  const selectedItemNumber = itemParam && /^[1-9]\d*$/u.test(itemParam) && Number.isSafeInteger(Number(itemParam))
    ? Number(itemParam)
    : null;

  const chooseDensity = (value: PlanningDensity) => {
    setDensity(value);
    try {
      localStorage.setItem(DENSITY_STORAGE_KEY, value);
    } catch {
      // The visual preference still applies for this page lifetime.
    }
  };

  const updateExpandedEpics = (next: number[]) => {
    const saved = savePlanningView({ expandedEpics: next });
    setExpandedEpicNumbers(saved.expandedEpics);
  };

  const toggleEpic = (number: number) => {
    const next = new Set(expandedEpicNumbers);
    if (next.has(number)) next.delete(number);
    else next.add(number);
    updateExpandedEpics([...next]);
  };

  return (
    <main className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6" data-testid="opencode-planning">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-[var(--color-text-muted)]">
            Developer roadmap
          </p>
          <h1 className="text-2xl font-bold tracking-tight">Project Planning</h1>
          {snapshot && (
            <a
              className="mt-1 inline-flex items-center gap-1 text-sm text-[var(--color-text-info)] hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
              data-testid="opencode-planning-repository"
              href={snapshot.repository.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              {snapshot.repository.owner}/{snapshot.repository.repo}
              <ExternalLink aria-hidden="true" size={13} />
            </a>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-end sm:gap-1.5">
          <div className="flex gap-2">
            <Button
              aria-expanded={createOpen}
              aria-haspopup="dialog"
              className="gap-2"
              data-testid="opencode-planning-create"
              onClick={() => {
                setCreated(null);
                setCreateOpen(true);
                setParams({ create: "1" });
              }}
              size="sm"
              type="button"
              variant="info"
            >
              <Plus aria-hidden="true" size={14} />
              New issue
            </Button>
            <Button
              className="gap-2"
              data-testid="opencode-planning-refresh"
              disabled={loading}
              onClick={() => void load(true)}
              size="sm"
              type="button"
              variant="secondary"
            >
              <RefreshCw aria-hidden="true" className={loading ? "animate-spin" : ""} size={14} />
              Refresh
            </Button>
          </div>
          {snapshot && (
            <span className="text-xs text-[var(--color-text-muted)]">
              Fetched {formatFetchedAt(snapshot.fetchedAt)}
            </span>
          )}
        </div>
      </header>

      <section
        aria-label="Planning filters"
        className="flex flex-col gap-3 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-background-surface)] p-3"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-1" aria-label="Item type">
            {TYPE_FILTERS.map(({ value, label }) => (
              <Button
                aria-pressed={typeFilter === value}
                data-testid={`opencode-planning-type-${value}`}
                key={value}
                onClick={() => setTypeFilter(value)}
                size="sm"
                type="button"
                variant={typeFilter === value ? "primary" : "ghost"}
              >
                {label}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1" aria-label="Item state">
            {STATE_FILTERS.map(({ value, label }) => (
              <Button
                aria-pressed={stateFilter === value}
                data-testid={`opencode-planning-state-${value}`}
                key={value}
                onClick={() => setStateFilter(value)}
                size="sm"
                type="button"
                variant={stateFilter === value ? "primary" : "ghost"}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border-default)] pt-3">
          <span className="mr-1 text-xs font-medium text-[var(--color-text-muted)]">Display density</span>
          <div className="flex flex-wrap gap-1" aria-label="Display density">
            {DENSITY_OPTIONS.map(({ value, label }) => (
            <Button
              aria-pressed={density === value}
              data-testid={`opencode-planning-density-${value}`}
              key={value}
              onClick={() => chooseDensity(value)}
              size="sm"
              type="button"
              variant={density === value ? "secondary" : "ghost"}
            >
              {label}
            </Button>
          ))}
          </div>
          {visibleEpicNumbers.length > 0 && (
            <Button
              className="ml-auto gap-1.5"
              data-testid="opencode-planning-epics-toggle-all"
              onClick={() => {
                const next = new Set(expandedEpicNumbers);
                if (everyVisibleEpicExpanded) visibleEpicNumbers.forEach((number) => next.delete(number));
                else visibleEpicNumbers.forEach((number) => next.add(number));
                updateExpandedEpics([...next]);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              {everyVisibleEpicExpanded ? <ChevronDown aria-hidden="true" size={14} /> : <ChevronRight aria-hidden="true" size={14} />}
              {everyVisibleEpicExpanded ? "Collapse all" : "Expand all"}
            </Button>
          )}
        </div>
      </section>

      {error && (tokenMissing
        ? <PlanningRateLimitAlert data-testid="opencode-planning-rate-limit-warning" />
        : <Alert variant="danger">Planning data is unavailable: {error}</Alert>)}
      {created && (
        <Alert data-testid="opencode-planning-create-success" role="status" variant="success">
          Issue #{created.number} created.{" "}
          <a data-testid="opencode-planning-created-link" href={created.url} rel="noopener noreferrer" target="_blank" className="font-semibold underline">View on GitHub</a>
        </Alert>
      )}
      {snapshot?.truncated && (
        <Alert variant="warning">
          GitHub returned more than 500 items. This list shows the 500 most recently active records.
        </Alert>
      )}
      {snapshot?.epicsTruncated && (
        <Alert data-testid="opencode-planning-epics-truncated" variant="warning">
          Some epic relationships were not loaded because the repository has more parent issues than this view resolves at once. Unresolved items remain visible at top level.
        </Alert>
      )}

      {loading && !snapshot ? (
        <div className="flex min-h-40 items-center justify-center" data-testid="opencode-planning-loading">
          <LoadingIndicator label="Loading planning data" />
        </div>
      ) : !error && items.length === 0 ? (
        <div
          className="rounded-lg border border-dashed border-[var(--color-border-default)] p-10 text-center text-sm text-[var(--color-text-muted)]"
          data-testid="opencode-planning-empty"
        >
          No items match these filters.
        </div>
      ) : sections.length > 0 ? (
        <div
          className="space-y-3"
          data-density={density}
          data-testid="opencode-planning-list"
          tabIndex={-1}
        >
          {sections.map((section) => (
            <PlanningGroupSection
              density={density}
              expandedEpics={expandedEpics}
              key={section.id}
              onOpen={(item) => setParams({ item: String(item.number) })}
              onToggleEpic={toggleEpic}
              section={section}
            />
          ))}
        </div>
      ) : null}
      {createOpen && (
        <CreateIssueDialog
          onClose={() => {
            setCreateOpen(false);
            setParams({});
          }}
          onCreated={(issue) => {
            setCreated(issue);
            setSnapshot((current) => current ? { ...current, items: [issue, ...current.items] } : current);
          }}
        />
      )}
      {selectedItemNumber !== null && (
        <PlanningItemDialog
          itemNumber={selectedItemNumber}
          key={selectedItemNumber}
          onClose={() => setParams({}, { replace: true })}
          onUpdated={(updated) => {
            setSnapshot((current) => current ? {
              ...current,
              items: current.items.map((item) => item.number === updated.number ? updated : item),
            } : current);
          }}
        />
      )}
    </main>
  );
}
