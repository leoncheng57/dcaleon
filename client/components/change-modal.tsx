// client/components/change-modal.tsx
//
// The one surface that renders agent file changes. Issue #134: a normal turn
// and an oversized turn must behave the same way, so no patch body is ever
// rendered inline in the transcript — both open this modal and both explain
// their own scope.
//
// Two bounds are deliberately separate and neither replaces the other:
//
//   - Transport: the BFF refuses an oversized historical diff (413
//     TURN_DIFF_TOO_LARGE) rather than streaming megabytes into the browser.
//     A modal cannot make that response safe, so oversized turns show the
//     file rail and say plainly that the exact patch is unavailable.
//   - Rendering: even a permitted patch is revealed in line chunks, so one
//     enormous file cannot lock the main thread on a phone.
//
// The fallback to the working tree is offered but never conflated with
// history: it shows the file as it is *now*, which later edits may have
// changed. Saying "here is that turn" while showing current state would be a
// confident falsehood, which is the expensive direction to be wrong in.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../ds/button.js";
import { cn } from "../ds/utils.js";
import { ApiError, api, type SessionTurnDiff } from "../lib/api.js";
import type { PatchEvent } from "../lib/transcript.js";

/** Lines revealed before the reader asks for more. */
const INITIAL_PATCH_LINES = 400;
const PATCH_LINE_STEP = 800;

type DiffState =
  | { status: "loading" }
  | { status: "loaded"; changes: SessionTurnDiff[] }
  | { status: "too-large" }
  | { status: "error"; message: string };

/**
 * What the modal is showing, in the reader's terms.
 *
 * Rendered as text rather than implied by layout: "is this the change that
 * turn made, or the file as it stands now?" is the question the whole feature
 * exists to answer.
 */
const SCOPE_LABEL: Record<DiffState["status"], string> = {
  loading: "Loading historical turn diff",
  loaded: "Exact historical turn diff",
  "too-large": "Historical diff unavailable",
  error: "Historical diff unavailable",
};

function DiffLine({ line }: { line: string }) {
  const className = line.startsWith("+") && !line.startsWith("+++")
    ? "text-[var(--color-text-success)]"
    : line.startsWith("-") && !line.startsWith("---")
      ? "text-[var(--color-text-danger)]"
      : line.startsWith("@@")
        ? "text-[var(--color-text-info)]"
        : undefined;
  return <span className={cn("block min-w-max", className)}>{line || " "}</span>;
}

/**
 * One file's patch, revealed in chunks.
 *
 * The chunk budget resets per file rather than per modal: moving to the next
 * file should not inherit how far the reader scrolled through the last one.
 */
function FilePatch({ change }: { change: SessionTurnDiff }) {
  const lines = useMemo(() => change.patch.split("\n"), [change.patch]);
  const [visible, setVisible] = useState(INITIAL_PATCH_LINES);
  useEffect(() => setVisible(INITIAL_PATCH_LINES), [change.file, change.patch]);

  if (!change.patch) {
    return (
      <p className="p-3 text-xs text-[var(--color-text-muted)]" data-testid="opencode-change-modal-no-patch">
        Patch content is unavailable for this file.
      </p>
    );
  }

  const shown = Math.min(visible, lines.length);
  const remaining = lines.length - shown;

  return (
    <div className="min-w-0">
      <pre
        className="thin-scrollbar min-w-0 overflow-auto bg-[var(--color-background-surface)] p-3 font-mono text-[11px] leading-5"
        data-testid="opencode-change-modal-patch"
      >
        <code>{lines.slice(0, shown).map((line, index) => <DiffLine key={index} line={line} />)}</code>
      </pre>
      {remaining > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border-default)] p-2.5">
          <span className="text-[11px] tabular-nums text-[var(--color-text-muted)]" data-testid="opencode-change-modal-remaining">
            {remaining.toLocaleString()} more {remaining === 1 ? "line" : "lines"}
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setVisible((value) => value + PATCH_LINE_STEP)}
            data-testid="opencode-change-modal-load-more"
          >
            Load {Math.min(PATCH_LINE_STEP, remaining).toLocaleString()} more lines
          </Button>
        </div>
      )}
    </div>
  );
}

export function ChangeModal({
  directory,
  sessionId,
  event,
  onClose,
  onOpenWorkspaceChanges,
}: {
  directory: string;
  sessionId: string;
  event: PatchEvent;
  onClose: () => void;
  /** Opens the working-tree diff. Absent when no such surface is mounted. */
  onOpenWorkspaceChanges?: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const requestGeneration = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const [state, setState] = useState<DiffState>({ status: "loading" });
  const [selected, setSelected] = useState(0);

  const load = useCallback(() => {
    if (!event.userMessageId) return;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    const generation = ++requestGeneration.current;
    setState({ status: "loading" });
    setSelected(0);
    void api.sessionTurnDiff(directory, sessionId, event.userMessageId, controller.signal)
      .then((result) => {
        if (requestGeneration.current !== generation) return;
        setState({ status: "loaded", changes: result.changes });
      })
      .catch((error: unknown) => {
        if (requestGeneration.current !== generation) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (error instanceof ApiError && error.code === "TURN_DIFF_TOO_LARGE") {
          setState({ status: "too-large" });
          return;
        }
        setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        if (requestController.current === controller) requestController.current = null;
      });
  }, [directory, event.userMessageId, sessionId]);

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
      dialog.focus();
    }
    return () => {
      // A closing modal must not keep an expensive diff request alive.
      requestGeneration.current += 1;
      requestController.current?.abort();
      requestController.current = null;
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, []);

  useEffect(() => load(), [load]);

  const close = () => dialogRef.current?.close();

  const loadedChanges = state.status === "loaded" ? state.changes : [];
  // With no patch bodies the rail still has a job: naming what the turn
  // touched is the part we can always answer honestly.
  const railFiles = state.status === "loaded"
    ? loadedChanges.map((change) => change.file)
    : event.files;
  const activeIndex = Math.min(selected, Math.max(0, railFiles.length - 1));
  const activeChange = state.status === "loaded" ? loadedChanges[activeIndex] : undefined;
  const countLabel = event.fileCount === 1 ? "1 file changed" : `${event.fileCount} files changed`;
  const hiddenNames = event.fileCount - railFiles.length;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="change-modal-title"
      aria-describedby="change-modal-scope"
      aria-modal="true"
      tabIndex={-1}
      className="m-auto flex max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-4xl flex-col overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-background-surface-raised)] p-0 text-[var(--color-text-default)] shadow-xl backdrop:bg-[var(--color-background-overlay)] sm:w-[calc(100%-2rem)]"
      data-testid="opencode-change-modal"
      onCancel={(cancelEvent) => { cancelEvent.preventDefault(); close(); }}
      onClose={onClose}
      onClick={(clickEvent) => { if (clickEvent.target === clickEvent.currentTarget) close(); }}
    >
      <header className="flex min-w-0 items-start gap-2 border-b border-[var(--color-border-default)] p-3 sm:p-4">
        <div className="min-w-0 flex-1">
          <h2 id="change-modal-title" className="text-sm font-semibold">Changes from this turn</h2>
          <p id="change-modal-scope" className="mt-0.5 text-xs text-[var(--color-text-muted)]">
            <span data-testid="opencode-change-modal-count">{countLabel}</span>
            {" · "}
            <span data-testid="opencode-change-modal-scope">{SCOPE_LABEL[state.status]}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={close}
          aria-label="Close changes"
          className="min-h-11 min-w-11 shrink-0 rounded text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]"
          data-testid="opencode-change-modal-close"
        >
          Close
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <nav
          className="thin-scrollbar max-h-40 shrink-0 overflow-y-auto border-b border-[var(--color-border-default)] p-2 lg:max-h-none lg:w-64 lg:border-b-0 lg:border-r"
          aria-label="Changed files"
          data-testid="opencode-change-modal-files"
        >
          {railFiles.length === 0 ? (
            <p className="p-2 text-xs text-[var(--color-text-muted)]">No file names were reported.</p>
          ) : (
            <ul className="space-y-1">
              {railFiles.map((file, index) => {
                const change = state.status === "loaded" ? loadedChanges[index] : undefined;
                return (
                  <li key={`${file}-${index}`}>
                    <button
                      type="button"
                      aria-current={index === activeIndex ? "true" : undefined}
                      onClick={() => setSelected(index)}
                      className={cn(
                        "block min-h-11 w-full rounded px-2 py-1.5 text-left lg:min-h-0",
                        index === activeIndex
                          ? "bg-[var(--color-background-surface-neutral-muted)] font-semibold"
                          : "text-[var(--color-text-muted)] hover:bg-[var(--hh-row-hover)]",
                      )}
                      data-testid="opencode-change-modal-file"
                    >
                      <span className="block break-all font-mono text-[11px]">{file}</span>
                      {change && (
                        <span className="mt-0.5 block text-[10px] tabular-nums">
                          <span className="text-[var(--color-text-success)]">+{change.additions}</span>
                          {" "}
                          <span className="text-[var(--color-text-danger)]">-{change.deletions}</span>
                          {" "}
                          <span className="text-[var(--color-text-muted)] capitalize">{change.status}</span>
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {hiddenNames > 0 && (
            <p className="p-2 text-[11px] text-[var(--color-text-muted)]" data-testid="opencode-change-modal-more-files">
              +{hiddenNames} more {hiddenNames === 1 ? "file" : "files"} not listed
            </p>
          )}
        </nav>

        <section className="thin-scrollbar flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" aria-live="polite">
          {state.status === "loading" && (
            <p className="p-4 text-xs text-[var(--color-text-muted)]" role="status">Loading changes...</p>
          )}

          {state.status === "error" && (
            <div className="space-y-3 p-4" role="alert" data-testid="opencode-change-modal-error">
              <p className="text-xs text-[var(--color-text-danger)]">Could not load changes: {state.message}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={load} data-testid="opencode-change-modal-retry">Retry</Button>
                {onOpenWorkspaceChanges && (
                  <Button size="sm" variant="secondary" onClick={() => { onOpenWorkspaceChanges(); close(); }} data-testid="opencode-change-modal-workspace">
                    Open current workspace diff
                  </Button>
                )}
              </div>
            </div>
          )}

          {state.status === "too-large" && (
            <div className="space-y-3 p-4" data-testid="opencode-change-modal-too-large">
              <p className="text-xs text-[var(--color-text-muted)]">
                This turn exceeds the safe response limit, so OpenCode did not send its patch body. The files it touched are listed here.
              </p>
              {onOpenWorkspaceChanges && (
                <>
                  <Button size="sm" variant="secondary" onClick={() => { onOpenWorkspaceChanges(); close(); }} data-testid="opencode-change-modal-workspace">
                    Open current workspace diff
                  </Button>
                  <p className="text-[11px] text-[var(--color-text-warning)]" data-testid="opencode-change-modal-workspace-caveat">
                    The workspace diff shows these files as they are now, including any later edits. It is not a record of this turn.
                  </p>
                </>
              )}
            </div>
          )}

          {state.status === "loaded" && loadedChanges.length === 0 && (
            <p className="p-4 text-xs text-[var(--color-text-muted)]" data-testid="opencode-change-modal-empty">
              No file changes were returned for this turn.
            </p>
          )}

          {activeChange && (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="opencode-change-modal-content">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--color-border-default)] bg-[var(--color-background-muted)] px-3 py-2 text-[11px]">
                <span className="min-w-0 flex-1 break-all font-mono font-medium" data-testid="opencode-change-modal-active-file">{activeChange.file}</span>
                <span className="shrink-0 capitalize text-[var(--color-text-muted)]">{activeChange.status}</span>
                <span className="shrink-0 tabular-nums text-[var(--color-text-success)]">+{activeChange.additions}</span>
                <span className="shrink-0 tabular-nums text-[var(--color-text-danger)]">-{activeChange.deletions}</span>
              </div>
              <FilePatch change={activeChange} />
            </div>
          )}
        </section>
      </div>

      {loadedChanges.length > 1 && (
        <footer className="flex min-w-0 items-center gap-2 border-t border-[var(--color-border-default)] p-2.5 sm:p-3">
          <span className="text-[11px] tabular-nums text-[var(--color-text-muted)]" data-testid="opencode-change-modal-position">
            File {activeIndex + 1} of {loadedChanges.length}
          </span>
          <div className="ml-auto flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={activeIndex === 0}
              onClick={() => setSelected(activeIndex - 1)}
              data-testid="opencode-change-modal-previous"
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={activeIndex >= loadedChanges.length - 1}
              onClick={() => setSelected(activeIndex + 1)}
              data-testid="opencode-change-modal-next"
            >
              Next
            </Button>
          </div>
        </footer>
      )}
    </dialog>
  );
}
