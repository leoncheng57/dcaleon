import { useEffect, useMemo, useState } from "react";
import { Button } from "../ds/button.js";
import { Alert } from "../ds/alert.js";
import { api, type ClaudeTranscriptResponse } from "../lib/api.js";
import { collapseActionGroups, extractCommands, serializeCommands } from "../lib/derive.js";
import { referenceCandidatesFromEvents, type WorkspaceTarget } from "../lib/fileReferences.js";
import { WorkspaceReferenceProvider } from "../lib/workspaceReferences.js";
import { ClaudeFilesDrawer } from "./claude-files-drawer.js";
import { Transcript } from "./transcript.js";

/** Explicit, server-filtered history reads. At most one page belongs to this drawer. */
export function ClaudeHistoryDrawer({ sessionId, actions = false, onClose }: { sessionId: string; actions?: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [cursor, setCursor] = useState<{ before?: string; after?: string }>({});
  const [result, setResult] = useState<ClaudeTranscriptResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resolved, setResolved] = useState<ReadonlyMap<string, string>>(new Map());
  const [target, setTarget] = useState<WorkspaceTarget | null>(null);
  useEffect(() => {
    let controller = new AbortController();
    const load = () => {
      if (document.hidden) return;
      controller.abort();
      controller = new AbortController();
      const active = controller;
      setBusy(true);
      void api.claudeSession(sessionId, { ...cursor, ...(search ? { q: search } : {}), ...(actions ? { actions: "true", ...(category ? { category } : {}) } : {}) }, controller.signal)
        .then((next) => { if (!active.signal.aborted && !document.hidden) { setResult(next); setError(""); } })
        .catch((cause) => { if (!active.signal.aborted) setError(String(cause)); })
        .finally(() => { if (!active.signal.aborted) setBusy(false); });
    };
    load();
    const visibility = () => { if (document.hidden) controller.abort(); else load(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { controller.abort(); document.removeEventListener("visibilitychange", visibility); };
  }, [sessionId, search, cursor, actions, category]);
  const items = useMemo(() => collapseActionGroups(result?.events ?? []), [result?.events]);
  useEffect(() => {
    let cancelled = false;
    setResolved(new Map());
    const paths = referenceCandidatesFromEvents(result?.events ?? [], "");
    if (paths.length) void api.claudeReferences(sessionId, paths).then(({ references }) => {
      if (!cancelled) setResolved(new Map(references.filter((reference) => reference.status === "file").map((reference) => [reference.path, reference.resolvedPath ?? reference.path])));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [result?.events, sessionId]);
  const exportCommands = async () => {
    setBusy(true);
    try {
      const { events } = await api.claudeExport(sessionId);
      const url = URL.createObjectURL(new Blob([serializeCommands(extractCommands(events))], { type: "text/x-shellscript" }));
      const link = document.createElement("a"); link.href = url; link.download = "claude-session.commands.sh"; link.click(); URL.revokeObjectURL(url);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  return <section className="fixed inset-x-0 bottom-0 top-11 z-50 flex flex-col border-l border-[var(--color-border-default)] bg-[var(--color-background-surface)] shadow-xl sm:left-auto sm:w-[46rem]" role="dialog" aria-modal="true" aria-label={actions ? "Run log" : "Search history"} data-testid="claude-history">
    <header className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border-default)] p-3">
      <strong>{actions ? "Run log" : "Search history"}</strong>
      {actions && <Button disabled={busy} onClick={() => void exportCommands()} data-testid="claude-runlog-export">Download commands</Button>}
      <Button className="ml-auto" variant="ghost" onClick={onClose} data-testid="claude-history-close">Close</Button>
    </header>
    <form className="flex flex-wrap gap-2 p-3" onSubmit={(event) => { event.preventDefault(); setCursor({}); setSearch(query.trim()); }}>
      <input className="min-h-11 min-w-0 flex-1 rounded border border-[var(--color-border-default)] bg-[var(--color-background-base)] px-3" aria-label="Search complete retained history" maxLength={200} value={query} onChange={(event) => setQuery(event.target.value)} data-testid="claude-history-query" />
      <Button type="submit" disabled={busy} data-testid="claude-history-search">Search</Button>
    </form>
    {actions && <div className="flex flex-wrap gap-1 px-3 pb-3">
      {[["", "All"], ["edit", "Edits"], ["command", "Commands"], ["read", "Reads"], ["failure", "Failures"], ["other", "Other"]].map(([value, label]) => <Button key={value} size="sm" variant={category === value ? "secondary" : "ghost"} onClick={() => { setCursor({}); setCategory(value); }} data-testid={`claude-runlog-filter-${value || "all"}`}>{label}</Button>)}
    </div>}
    {error && <Alert variant="danger">{error}</Alert>}
    <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
      <span className="text-xs text-[var(--color-text-muted)]">{busy ? "Loading…" : `${result?.events.length ?? 0} of ${result?.page?.total ?? result?.events.length ?? 0} matching events`}</span>
      {result?.page?.before && <Button disabled={busy} onClick={() => setCursor({ before: result.page!.before! })} data-testid="claude-history-earlier">Earlier</Button>}
      {result?.page?.after && <Button disabled={busy} onClick={() => setCursor({ after: result.page!.after! })} data-testid="claude-history-newer">Newer</Button>}
    </div>
    <div className="min-h-0 flex-1 overflow-auto p-4" data-testid="claude-history-results">
      {!busy && result && !items.length && <p>No matching events.</p>}
      <WorkspaceReferenceProvider directory={sessionId} resolved={resolved} onOpen={setTarget}>
        <Transcript items={items} wrap collapsedGroups={{}} onToggleGroup={() => undefined} />
      </WorkspaceReferenceProvider>
    </div>
    {target && <ClaudeFilesDrawer sessionId={sessionId} target={target} onClose={() => setTarget(null)} />}
  </section>;
}
