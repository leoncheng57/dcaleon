import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../ds/button.js";
import { api, type SessionSummary } from "../lib/api.js";
import { normalizeTranscript } from "../lib/events.js";
import { fetchAllMessagePages } from "../lib/messagePages.js";
import {
  serializeSessionJson,
  serializeShareMarkdown,
  shareFilename,
  validatedShareUrl,
  type ShareTarget,
} from "../lib/sessionSharing.js";
import type { TranscriptEvent } from "../lib/transcript.js";

interface ShareExportDialogProps {
  directory: string;
  sessionID: string;
  title: string;
  events: TranscriptEvent[];
  target: ShareTarget;
  session: SessionSummary;
  onSessionChange: (session: SessionSummary) => void;
  onClose: () => void;
}

export function ShareExportDialog({ directory, sessionID, title, events, target, session, onSessionChange, onClose }: ShareExportDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [status, setStatus] = useState("");
  const [shareUrl, setShareUrl] = useState(() => validatedShareUrl(session.shareUrl));
  const [publicIntent, setPublicIntent] = useState<"create" | "revoke" | null>(null);
  const [working, setWorking] = useState(false);
  const [completeEvents, setCompleteEvents] = useState<TranscriptEvent[] | null>(() => target.kind === "session" ? null : events);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportAttempt, setExportAttempt] = useState(0);
  const exportEvents = target.kind === "session" ? completeEvents : events;
  const markdown = useMemo(
    () => exportEvents ? serializeShareMarkdown(title, exportEvents, target) : "",
    [exportEvents, target, title],
  );
  const json = useMemo(
    () => target.kind === "session" && exportEvents ? serializeSessionJson(title, exportEvents) : null,
    [exportEvents, target, title],
  );
  const targetLabel = target.kind === "session" ? "Full session" : target.role === "user" ? "Your message" : "Assistant message";
  const filenameBase = target.kind === "session" ? title : `${title}-${target.role}-message`;
  const canNativeShare = typeof navigator.share === "function";

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
      dialog.focus();
    }
    return () => {
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, []);

  useEffect(() => {
    if (target.kind !== "session") return;
    let cancelled = false;
    setCompleteEvents(null);
    setExportError(null);
    void fetchAllMessagePages((before) => api.messages(directory, sessionID, {
      limit: 100,
      ...(before ? { before } : {}),
    })).then((messages) => {
      if (!cancelled) setCompleteEvents(normalizeTranscript(messages).events);
    }).catch((error: unknown) => {
      if (!cancelled) setExportError(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [directory, exportAttempt, sessionID, target]);

  const close = () => dialogRef.current?.close();
  const copy = async (text = markdown) => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Copied");
    } catch {
      setStatus("Copy failed");
    }
  };
  const download = (contents: string, extension: "md" | "json") => {
    let url: string | null = null;
    try {
      url = URL.createObjectURL(new Blob([contents], {
        type: extension === "json" ? "application/json;charset=utf-8" : "text/markdown;charset=utf-8",
      }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = shareFilename(filenameBase, extension);
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setStatus(`${extension.toUpperCase()} download started`);
    } catch (error) {
      setStatus(`Download failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  };
  const nativeShare = async () => {
    if (!navigator.share) return;
    try {
      await navigator.share({ title, text: markdown });
      setStatus("Shared with device");
    } catch (error) {
      setStatus(error instanceof DOMException && error.name === "AbortError" ? "Device share cancelled" : "Device share failed");
    }
  };
  const confirmPublic = async () => {
    setWorking(true);
    setStatus("");
    try {
      const result = publicIntent === "create"
        ? await api.shareSession(directory, sessionID)
        : await api.unshareSession(directory, sessionID);
      const nextUrl = validatedShareUrl(result.session.shareUrl);
      if (publicIntent === "create" && !nextUrl) throw new Error("OpenCode returned an invalid public share URL");
      setShareUrl(nextUrl);
      onSessionChange(result.session);
      setPublicIntent(null);
      setStatus(nextUrl ? "Public link created" : "Public link revoked");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-describedby="share-export-description"
      aria-labelledby="share-export-title"
      aria-modal="true"
      tabIndex={-1}
      className="m-auto max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-xl overflow-y-auto overflow-x-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-background-surface-raised)] p-0 text-[var(--color-text-default)] shadow-xl backdrop:bg-[var(--color-background-overlay)] sm:w-[calc(100%-2rem)]"
      data-testid="opencode-share-export-dialog"
      onCancel={(event) => { event.preventDefault(); close(); }}
      onClose={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <div className="min-w-0 space-y-5 p-4 sm:p-6">
        <div>
          <h2 id="share-export-title" className="text-lg font-semibold">Share</h2>
          <p id="share-export-description" className="mt-1 text-sm text-[var(--color-text-muted)]">
            Target: <strong data-testid="opencode-share-target">{targetLabel}</strong>
          </p>
        </div>

        <div className="rounded-lg border border-[var(--color-border-default)] p-3 text-xs text-[var(--color-text-muted)]" data-testid="opencode-export-security">
          Local exports use a fresh, complete, sanitized transcript fetch. Reminder bodies, provider metadata and signatures, raw tool arguments and output, attachment URLs, and file paths are excluded.
        </div>

        {target.kind === "session" && !completeEvents && !exportError && (
          <p className="text-sm text-[var(--color-text-muted)]" role="status" data-testid="opencode-export-loading">
            Loading complete transcript...
          </p>
        )}
        {target.kind === "session" && exportError && (
          <div className="space-y-2" role="alert" data-testid="opencode-export-error">
            <p className="text-sm text-[var(--color-text-danger)]">Could not load the complete transcript: {exportError}</p>
            <Button variant="secondary" onClick={() => setExportAttempt((value) => value + 1)} data-testid="opencode-export-retry">Retry export</Button>
          </div>
        )}

        <div className="flex min-w-0 flex-wrap gap-2">
          <Button disabled={!exportEvents} onClick={() => void copy()} data-testid="opencode-export-copy">Copy Markdown</Button>
          <Button disabled={!exportEvents} variant="secondary" onClick={() => download(markdown, "md")} data-testid="opencode-export-download">Download Markdown</Button>
          {json && <Button variant="secondary" onClick={() => download(json, "json")} data-testid="opencode-export-download-json">Download JSON</Button>}
          {canNativeShare ? (
            <Button disabled={!exportEvents} variant="secondary" onClick={() => void nativeShare()} data-testid="opencode-export-native-share">Native Share</Button>
          ) : null}
        </div>

        {target.kind === "session" && (
          <section className="min-w-0 space-y-3 border-t border-[var(--color-border-default)] pt-5" aria-labelledby="public-link-title">
            <div>
              <h3 id="public-link-title" className="font-semibold">Public OpenCode link</h3>
              <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-warning)]" data-testid="opencode-share-warning">
                This is broader than the sanitized export above. OpenCode publishes the full raw session, which can include prompts, tool inputs and output, reasoning metadata, file paths, signatures, and future updates. Anyone with the link can view it until you revoke it.
              </p>
            </div>
            {shareUrl ? (
              <>
                <a className="block min-w-0 break-all text-sm underline" href={shareUrl} rel="noreferrer" target="_blank" data-testid="opencode-share-url">{shareUrl}</a>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => void copy(shareUrl)} data-testid="opencode-share-copy-link">Copy public link</Button>
                  <Button variant="danger" onClick={() => setPublicIntent("revoke")} data-testid="opencode-share-revoke">Revoke public link</Button>
                </div>
              </>
            ) : (
              <Button variant="secondary" onClick={() => setPublicIntent("create")} data-testid="opencode-share-create">Make conversation public</Button>
            )}
            {publicIntent && (
              <div className="rounded-lg border border-[var(--color-border-default)] p-3" data-testid="opencode-share-confirmation">
                <p className="text-sm font-medium">{publicIntent === "create" ? "Confirm publishing the full raw session." : "Confirm revoking this public link."}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant={publicIntent === "create" ? "danger" : "primary"} disabled={working} onClick={() => void confirmPublic()} data-testid="opencode-share-confirm">
                    {working ? "Working..." : publicIntent === "create" ? "Publish full session" : "Confirm revoke"}
                  </Button>
                  <Button variant="secondary" disabled={working} onClick={() => setPublicIntent(null)} data-testid="opencode-share-cancel">Cancel</Button>
                </div>
              </div>
            )}
          </section>
        )}

        <div className="flex items-center justify-between gap-3">
          <span aria-live="polite" role="status" className="min-w-0 text-xs text-[var(--color-text-muted)]" data-testid="opencode-share-export-status">{status}</span>
          <Button variant="secondary" onClick={close} data-testid="opencode-share-export-close">Close</Button>
        </div>
      </div>
    </dialog>
  );
}
