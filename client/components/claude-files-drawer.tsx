import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, File as FileIcon, FolderOpen, X } from "lucide-react";

import { Alert } from "../ds/alert.js";
import { Button } from "../ds/button.js";
import { api, type WorkspaceFile, type WorkspaceNode } from "../lib/api.js";
import { describeLineRange, type WorkspaceTarget } from "../lib/fileReferences.js";

const CodeViewer = lazy(() => import("./code-viewer.js"));

// A read-only file browser over a Claude session's directory. Self-contained
// (its own lazy tree fetch) so it stays decoupled from the opencode-scoped
// WorkspaceFiles; it reuses CodeViewer verbatim for the content pane.
function TreeLevel({ sessionId, dir, depth, onOpen, openPath }: {
  sessionId: string; dir: string; depth: number; onOpen: (path: string) => void; openPath: string | null;
}) {
  const [state, setState] = useState<{ dirs: WorkspaceNode[]; files: WorkspaceNode[] } | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let active = true;
    api.claudeTree(sessionId, dir)
      .then((result) => { if (active) setState({ dirs: result.dirs, files: result.files }); })
      .catch((cause: Error) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [sessionId, dir]);

  if (error) return <p className="px-2 py-1 text-xs text-[var(--color-text-danger)]">{error}</p>;
  if (!state) return <p className="px-2 py-1 text-xs text-[var(--color-text-muted)]">Loading…</p>;
  return (
    <ul className="text-sm" style={{ paddingLeft: depth === 0 ? 0 : 12 }}>
      {state.dirs.map((node) => (
        <li key={node.path}>
          <button type="button" className="flex w-full items-center gap-1 rounded px-2 py-1 text-left hover:bg-[var(--color-background-surface-neutral-muted)]" onClick={() => setExpanded((value) => ({ ...value, [node.path]: !value[node.path] }))} data-testid="claude-tree-dir">
            {expanded[node.path] ? <ChevronDown aria-hidden="true" size={13} /> : <ChevronRight aria-hidden="true" size={13} />}
            <FolderOpen aria-hidden="true" size={13} /> <span className="truncate">{node.name}</span>
          </button>
          {expanded[node.path] && <TreeLevel sessionId={sessionId} dir={node.path} depth={depth + 1} onOpen={onOpen} openPath={openPath} />}
        </li>
      ))}
      {state.files.map((node) => (
        <li key={node.path}>
          <button type="button" className={`flex w-full items-center gap-1 rounded px-2 py-1 pl-6 text-left hover:bg-[var(--color-background-surface-neutral-muted)] ${openPath === node.path ? "bg-[var(--color-background-surface-info-muted)] text-[var(--color-text-info)]" : ""}`} onClick={() => onOpen(node.path)} data-testid="claude-tree-file">
            <FileIcon aria-hidden="true" size={13} /> <span className="truncate">{node.name}</span>
          </button>
        </li>
      ))}
      {state.dirs.length === 0 && state.files.length === 0 && <li className="px-2 py-1 text-xs text-[var(--color-text-muted)]">Empty</li>}
    </ul>
  );
}

export function ClaudeFilesDrawer({ sessionId, target, onClose }: { sessionId: string; target?: WorkspaceTarget | null; onClose: () => void }) {
  const [openPath, setOpenPath] = useState<string | null>(target?.path ?? null);
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [error, setError] = useState("");
  const [wrap, setWrap] = useState(false);

  const open = useCallback((path: string) => {
    setOpenPath(path);
    setFile(null);
    setError("");
    const controller = new AbortController();
    api.claudeFile(sessionId, path, controller.signal)
      .then(setFile)
      .catch((cause: Error) => { if (cause.name !== "AbortError") setError(cause.message); });
  }, [sessionId]);

  // A file-reference click sets the target: open its file so CodeViewer can
  // scroll to the referenced line range. Re-runs when the target changes so a
  // second reference re-targets the same drawer.
  useEffect(() => {
    if (target?.path) open(target.path);
  }, [target?.path, target?.startLine, target?.endLine, open]);

  const body = useMemo(() => {
    if (error) return <Alert variant="danger">{error}</Alert>;
    if (!openPath) return <p className="p-4 text-sm text-[var(--color-text-muted)]">Select a file to view it.</p>;
    if (!file) return <p className="p-4 text-sm text-[var(--color-text-muted)]">Loading {openPath}{target?.path === openPath ? describeLineRange(target) : ""}…</p>;
    if (file.type === "binary") return <p className="p-4 text-sm text-[var(--color-text-muted)]" data-testid="claude-file-binary">{openPath} is a binary file and cannot be shown.</p>;
    // Only apply the line target while its own file is showing; a tree click to
    // another file clears it so an unrelated file does not inherit the range.
    const viewerTarget = target?.path && target.path === openPath ? target : undefined;
    return <Suspense fallback={<p className="p-4 text-sm text-[var(--color-text-muted)]">Loading viewer…</p>}><CodeViewer path={file.path} content={file.content} wrap={wrap} target={viewerTarget} /></Suspense>;
  }, [error, openPath, file, wrap, target]);

  return (
    <section className="fixed inset-x-0 bottom-0 top-11 z-50 flex flex-col border-l border-[var(--color-border-default)] bg-[var(--color-background-surface)] shadow-xl sm:left-auto sm:w-[52rem]" role="dialog" aria-modal="true" aria-label="Session files" data-testid="claude-files">
      <header className="flex items-center gap-2 border-b border-[var(--color-border-default)] p-2">
        <FolderOpen aria-hidden="true" size={16} />
        <strong className="text-sm">Files</strong>
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setWrap((value) => !value)} data-testid="claude-files-wrap">{wrap ? "No wrap" : "Wrap"}</Button>
          <Button size="sm" variant="ghost" onClick={onClose} data-testid="claude-files-close"><X aria-hidden="true" size={15} /> Close</Button>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[16rem_1fr]">
        <nav className="min-h-0 overflow-auto border-r border-[var(--color-border-default)] p-1" data-testid="claude-file-tree">
          <TreeLevel sessionId={sessionId} dir="" depth={0} onOpen={open} openPath={openPath} />
        </nav>
        <div className="min-h-0 overflow-auto" data-testid="claude-file-pane">{body}</div>
      </div>
    </section>
  );
}
