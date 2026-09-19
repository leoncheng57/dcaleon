import { useEffect, useRef, useState } from "react";
import { ExternalLink, X } from "lucide-react";

import { Alert } from "../ds/alert.js";
import { Badge } from "../ds/badge.js";
import { Button } from "../ds/button.js";
import { LoadingIndicator } from "../ds/loading-indicator.js";
import { Markdown } from "../ds/markdown.js";
import { api, type PlanningItem, type PlanningItemDetails, type PlanningLabel } from "../lib/api.js";

const PRIORITY_LABELS = new Set(["priority:high", "priority:medium", "priority:low"]);

function normalizedLabel(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(date);
}

export function PlanningItemDialog({ itemNumber, onClose, onUpdated }: {
  itemNumber: number;
  onClose: () => void;
  onUpdated: (item: PlanningItem) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const savingRef = useRef(false);
  const [details, setDetails] = useState<PlanningItemDetails | null>(null);
  const [labels, setLabels] = useState<PlanningLabel[]>([]);
  const [labelsTruncated, setLabelsTruncated] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailsError, setDetailsError] = useState("");
  const [labelsError, setLabelsError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
      closeRef.current?.focus();
    }

    setLoading(true);
    void api.planningItemDetails(itemNumber)
      .then(({ details: value }) => {
        if (!active) return;
        setDetails(value);
        setSelected(value.item.labels);
      })
      .catch((reason: Error) => {
        if (active) setDetailsError(reason.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    void api.planningLabels()
      .then((result) => {
        if (!active) return;
        setLabels(result.labels);
        setLabelsTruncated(result.truncated);
      })
      .catch((reason: Error) => {
        if (active) setLabelsError(reason.message);
      });

    return () => {
      active = false;
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
      else document.querySelector<HTMLElement>("[data-testid='opencode-planning-list']")?.focus();
    };
  }, [itemNumber]);

  const close = () => {
    if (!savingRef.current) dialogRef.current?.close();
  };

  const toggleLabel = (label: string, checked: boolean) => {
    setSaved(false);
    setSaveError("");
    setSelected((current) => {
      const key = normalizedLabel(label);
      const withoutLabel = current.filter((entry) => normalizedLabel(entry) !== key);
      if (!checked) return withoutLabel;
      const withoutOtherPriorities = PRIORITY_LABELS.has(key)
        ? withoutLabel.filter((entry) => !PRIORITY_LABELS.has(normalizedLabel(entry)))
        : withoutLabel;
      return [...withoutOtherPriorities, label].slice(0, 100);
    });
  };

  const saveLabels = async () => {
    if (savingRef.current || !details) return;
    savingRef.current = true;
    setSaving(true);
    setSaved(false);
    setSaveError("");
    try {
      const result = await api.updatePlanningItemLabels(itemNumber, selected);
      setDetails((current) => current ? { ...current, item: result.item } : current);
      setSelected(result.item.labels);
      setSaved(true);
      onUpdated(result.item);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : "Unavailable");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const visibleLabels = labels.filter((label) =>
    label.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const item = details?.item;

  return (
    <dialog
      aria-labelledby="planning-item-dialog-title"
      aria-modal="true"
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(52rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-background-surface-raised)] p-0 text-[var(--color-text-default)] shadow-2xl backdrop:bg-black/60 max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none"
      data-testid="opencode-planning-item-dialog"
      onCancel={(event) => {
        if (savingRef.current) event.preventDefault();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) close();
      }}
      onClose={onClose}
      ref={dialogRef}
    >
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <header className="flex items-start gap-4 border-b border-[var(--color-border-default)] p-4 sm:p-5">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <Badge variant={item?.type === "pull_request" ? "info" : "neutral"}>
                {item?.type === "pull_request" ? "Pull request" : "Issue"}
              </Badge>
              <span className="text-xs tabular-nums text-[var(--color-text-muted)]">#{itemNumber}</span>
            </div>
            <h2 className="break-words text-lg font-bold" id="planning-item-dialog-title">
              {item?.title || (loading ? "Loading item..." : `Item #${itemNumber}`)}
            </h2>
            {item && (
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                Created {formatDate(item.createdAt)} · Last activity {formatDate(item.updatedAt)}
                {item.author ? ` · by ${item.author}` : ""}
              </p>
            )}
          </div>
          <Button
            aria-label="Close planning item dialog"
            className="size-10 shrink-0 p-0 pointer-coarse:size-11"
            data-testid="opencode-planning-item-close"
            disabled={saving}
            onClick={close}
            ref={closeRef}
            type="button"
            variant="ghost"
          >
            <X aria-hidden="true" size={18} />
          </Button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 sm:p-5">
          {loading && <div className="flex min-h-32 items-center justify-center"><LoadingIndicator label="Loading issue details" /></div>}
          {detailsError && <Alert data-testid="opencode-planning-item-error" variant="danger">Details unavailable: {detailsError}</Alert>}
          {details && (
            <>
              <section data-testid="opencode-planning-item-description">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Description</h3>
                {details.body.trim()
                  ? <Markdown className="break-words text-sm" source={details.body} untrusted />
                  : <p className="text-sm text-[var(--color-text-muted)]">No description.</p>}
                {details.bodyTruncated && <p className="mt-2 text-xs text-[var(--color-text-warning)]">Description truncated. View the complete item on GitHub.</p>}
              </section>

              <section data-testid="opencode-planning-item-comments">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Comments ({details.comments.length})</h3>
                  {details.commentsTruncated && <span className="text-xs text-[var(--color-text-warning)]">Showing first 50</span>}
                </div>
                {details.commentsError && <Alert variant="warning">Comments unavailable: {details.commentsError}</Alert>}
                {!details.commentsError && details.comments.length === 0 && <p className="text-sm text-[var(--color-text-muted)]">No comments yet.</p>}
                <ul className="space-y-3">
                  {details.comments.map((comment) => (
                    <li className="rounded-lg border border-[var(--color-border-default)] p-3" data-testid="opencode-planning-item-comment" key={comment.id}>
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--color-text-muted)]">
                        <strong className="text-[var(--color-text-default)]">{comment.author}</strong>
                        <span>{formatDate(comment.createdAt)}</span>
                      </div>
                      <Markdown className="break-words text-sm" source={comment.body} untrusted />
                      {comment.bodyTruncated && <p className="mt-2 text-xs text-[var(--color-text-warning)]">Comment truncated.</p>}
                    </li>
                  ))}
                </ul>
              </section>

              <fieldset className="space-y-2 rounded-lg border border-[var(--color-border-default)] p-3">
                <legend className="px-1 text-sm font-semibold">Labels</legend>
                <input
                  aria-label="Search labels"
                  className="w-full rounded-md border border-[var(--color-border-default)] bg-transparent p-2.5 text-base"
                  data-testid="opencode-planning-item-label-search"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search labels"
                  value={query}
                />
                {labelsError && <p className="text-sm text-[var(--color-text-danger)]">Labels unavailable: {labelsError}</p>}
                {labelsTruncated && <p className="text-xs text-[var(--color-text-warning)]">Only the first 500 repository labels are available.</p>}
                {details.itemLabelsTruncated && <p className="text-xs text-[var(--color-text-warning)]">This item has more than 100 labels. Edit them on GitHub to avoid dropping hidden labels.</p>}
                <div className="max-h-48 space-y-1 overflow-y-auto" data-testid="opencode-planning-item-label-list">
                  {visibleLabels.map((label) => (
                    <label className="flex min-h-10 cursor-pointer items-start gap-2 rounded px-2 py-2 hover:bg-[var(--color-background-surface-neutral-muted)]" key={label.name}>
                      <input
                        checked={selected.some((entry) => normalizedLabel(entry) === normalizedLabel(label.name))}
                        className="mt-0.5 size-4"
                        data-testid={`opencode-planning-item-label-${label.name}`}
                        disabled={saving}
                        onChange={(event) => toggleLabel(label.name, event.target.checked)}
                        type="checkbox"
                      />
                      <span className="min-w-0 text-sm">
                        <strong className="block">{label.name}</strong>
                        {label.description && <span className="block text-xs text-[var(--color-text-muted)]">{label.description}</span>}
                      </span>
                    </label>
                  ))}
                  {!labelsError && visibleLabels.length === 0 && <p className="p-2 text-sm text-[var(--color-text-muted)]">No matching labels.</p>}
                </div>
                {saveError && <Alert data-testid="opencode-planning-item-save-error" variant="danger">Could not update labels: {saveError}</Alert>}
                {saved && <Alert data-testid="opencode-planning-item-save-success" role="status" variant="success">Labels updated.</Alert>}
              </fieldset>
            </>
          )}
        </div>

        <footer className="flex flex-col-reverse gap-2 border-t border-[var(--color-border-default)] p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          {item ? (
            <a
              className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md px-3 text-sm font-semibold text-[var(--color-text-info)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
              data-testid="opencode-planning-item-external"
              href={item.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              View on GitHub <ExternalLink aria-hidden="true" size={14} />
            </a>
          ) : <span />}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button data-testid="opencode-planning-item-cancel" disabled={saving} onClick={close} type="button" variant="secondary">Close</Button>
            <Button data-testid="opencode-planning-item-save" disabled={saving || !details || !!labelsError || !!details?.itemLabelsTruncated} onClick={() => void saveLabels()} type="button">
              {saving ? "Saving..." : "Save labels"}
            </Button>
          </div>
        </footer>
      </div>
    </dialog>
  );
}
