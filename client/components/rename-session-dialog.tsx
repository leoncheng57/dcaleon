import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { Button } from "../ds/button.js";

export function RenameSessionDialog({ currentTitle, onRename, onClose }: {
  currentTitle: string;
  onRename: (title: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const submittingRef = useRef(false);
  const [title, setTitle] = useState(currentTitle);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
      inputRef.current?.select();
    }
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
    const cleaned = title.trim();
    if (!cleaned) {
      setError("Title is required");
      inputRef.current?.focus();
      return;
    }
    if (cleaned.length > 160) {
      setError("Title must be at most 160 characters");
      inputRef.current?.focus();
      return;
    }
    if (cleaned === currentTitle) {
      dialogRef.current?.close();
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    try {
      await onRename(cleaned);
      dialogRef.current?.close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Rename failed");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <dialog
      aria-labelledby="rename-session-title"
      aria-modal="true"
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-background-surface)] p-0 text-[var(--color-text-default)] shadow-2xl backdrop:bg-black/60 max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none"
      data-testid="rename-session-dialog"
      onCancel={(event) => {
        if (submittingRef.current) event.preventDefault();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) close();
      }}
      onClose={onClose}
      ref={dialogRef}
    >
      <form className="flex flex-col" data-testid="rename-session-form" onSubmit={(event) => void submit(event)}>
        <header className="flex items-center justify-between border-b border-[var(--color-border-default)] p-4">
          <h2 id="rename-session-title" className="text-sm font-semibold">Rename session</h2>
          <button
            type="button"
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-background-surface-neutral-muted)]"
            disabled={submitting}
            onClick={close}
          >
            <X size={16} />
          </button>
        </header>
        <div className="p-4 space-y-3">
          <input
            ref={inputRef}
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={160}
            placeholder="Session title"
            className="h-11 w-full rounded-md border border-[var(--color-border-default)] bg-transparent px-3 text-sm"
            data-testid="rename-session-input"
            disabled={submitting}
          />
          {error && <p className="text-xs text-[var(--color-text-danger)]" role="alert">{error}</p>}
        </div>
        <footer className="flex justify-end gap-2 border-t border-[var(--color-border-default)] p-4">
          <Button type="button" variant="ghost" disabled={submitting} onClick={close}>Cancel</Button>
          <Button type="submit" disabled={submitting || !title.trim()}>Save</Button>
        </footer>
      </form>
    </dialog>
  );
}
