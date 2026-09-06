import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { Alert } from "../ds/alert.js";
import { Button } from "../ds/button.js";
import { api, type PlanningItem, type PlanningLabel } from "../lib/api.js";

export function CreateIssueDialog({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (issue: PlanningItem) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const submittingRef = useRef(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState<PlanningLabel[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [labelQuery, setLabelQuery] = useState("");
  const [labelsError, setLabelsError] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
      titleRef.current?.focus();
    }
    void api.planningLabels()
      .then((result) => setLabels(result.labels))
      .catch((reason: Error) => setLabelsError(reason.message));
    return () => {
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, []);

  const close = () => {
    if (!submittingRef.current) dialogRef.current?.close();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submittingRef.current) return;
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setError("Title is required");
      titleRef.current?.focus();
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    try {
      const result = await api.createPlanningIssue({ title: cleanTitle, body, labels: selected });
      onCreated(result.issue);
      dialogRef.current?.close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unavailable");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const visibleLabels = labels.filter((label) =>
    label.name.toLowerCase().includes(labelQuery.trim().toLowerCase()),
  );

  return (
    <dialog
      aria-describedby="planning-create-description"
      aria-labelledby="planning-create-title"
      aria-modal="true"
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(42rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-background-surface)] p-0 text-[var(--color-text-default)] shadow-2xl backdrop:bg-black/60 max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none"
      data-testid="opencode-planning-create-dialog"
      onCancel={(event) => {
        if (submittingRef.current) event.preventDefault();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) close();
      }}
      onClose={onClose}
      ref={dialogRef}
    >
      <form className="flex max-h-[calc(100dvh-2rem)] flex-col" data-testid="opencode-planning-create-form" onSubmit={(event) => void submit(event)}>
        <header className="flex items-start gap-4 border-b border-[var(--color-border-default)] p-4 sm:p-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold" id="planning-create-title">Create issue</h2>
            <p className="text-sm text-[var(--color-text-muted)]" id="planning-create-description">
              Open an issue in leoncheng57/dcaleon.
            </p>
          </div>
          <Button
            aria-label="Close create issue dialog"
            className="size-10 shrink-0 p-0 pointer-coarse:size-11"
            data-testid="opencode-planning-create-close"
            disabled={submitting}
            onClick={close}
            type="button"
            variant="ghost"
          >
            <X aria-hidden="true" size={18} />
          </Button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
          {error && <Alert data-testid="opencode-planning-create-error" variant="danger">{error}</Alert>}
          <label className="block text-sm font-medium">
            Title
            <input
              aria-invalid={error === "Title is required" || undefined}
              className="mt-1 w-full rounded-md border border-[var(--color-border-default)] bg-transparent p-2.5 text-base"
              data-testid="opencode-planning-create-title"
              maxLength={256}
              onChange={(event) => setTitle(event.target.value)}
              ref={titleRef}
              required
              value={title}
            />
          </label>
          <label className="block text-sm font-medium">
            Description <span className="font-normal text-[var(--color-text-muted)]">(optional, Markdown supported)</span>
            <textarea
              className="mt-1 min-h-36 w-full resize-y rounded-md border border-[var(--color-border-default)] bg-transparent p-2.5 text-base"
              data-testid="opencode-planning-create-body"
              maxLength={65_536}
              onChange={(event) => setBody(event.target.value)}
              value={body}
            />
          </label>
          <fieldset className="space-y-2 rounded-lg border border-[var(--color-border-default)] p-3">
            <legend className="px-1 text-sm font-semibold">Labels</legend>
            <input
              aria-label="Search labels"
              className="w-full rounded-md border border-[var(--color-border-default)] bg-transparent p-2.5 text-base"
              data-testid="opencode-planning-label-search"
              onChange={(event) => setLabelQuery(event.target.value)}
              placeholder="Search labels"
              value={labelQuery}
            />
            {labelsError && <p className="text-sm text-[var(--color-text-danger)]">Labels unavailable: {labelsError}</p>}
            <div className="max-h-40 space-y-1 overflow-y-auto" data-testid="opencode-planning-label-list">
              {visibleLabels.map((label) => (
                <label className="flex min-h-10 cursor-pointer items-start gap-2 rounded px-2 py-2 hover:bg-[var(--color-background-surface-neutral-muted)]" key={label.name}>
                  <input
                    checked={selected.includes(label.name)}
                    className="mt-0.5 size-4"
                    data-testid={`opencode-planning-label-${label.name}`}
                    onChange={(event) => setSelected((current) => event.target.checked
                      ? [...current, label.name].slice(0, 20)
                      : current.filter((name) => name !== label.name))}
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
          </fieldset>
        </div>

        <footer className="flex flex-col-reverse gap-2 border-t border-[var(--color-border-default)] p-4 sm:flex-row sm:justify-end sm:p-5">
          <Button data-testid="opencode-planning-create-cancel" disabled={submitting} onClick={close} type="button" variant="secondary">Cancel</Button>
          <Button data-testid="opencode-planning-create-submit" disabled={submitting} type="submit">{submitting ? "Creating..." : "Create issue"}</Button>
        </footer>
      </form>
    </dialog>
  );
}
