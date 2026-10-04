// client/components/workspace-files.tsx
//
// The Files tab: a read-only inspection surface, not a browser IDE.
//
// It is optimised for exactly two jobs, in this order: following a file
// reference out of the transcript, and reading around it. Everything that
// would make it an editor — saving, renaming, creating, deleting — is out of
// scope by design (issue #140), and the drawer stays a temporary overlay so
// opening a file never costs the reader their place in the conversation.
//
// Layout splits by pointer size rather than by preference: a desktop drawer
// shows tree and file side by side, while a phone gets an explicit Tree → File
// flow with a back action. A two-column split at 390px gives neither pane
// enough width to be read.

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  File,
  FileBraces,
  FileCode,
  FileCog,
  FileImage,
  FileKey,
  FileLock,
  FileTerminal,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  Globe,
  Palette,
  type LucideIcon,
} from "lucide-react";

import { Alert } from "../ds/alert.js";
import { Button } from "../ds/button.js";
import { cn } from "../ds/utils.js";
import { api, type VcsFileDiff, type WorkspaceFile, type WorkspaceNode } from "../lib/api.js";
import { FILE_ICON_TONE, fileIconKind, type FileIconKind, type FileIconTone } from "../lib/fileIcons.js";
import { describeLineRange, type WorkspaceTarget } from "../lib/fileReferences.js";
import { WORKSPACE_TREE_ROOT, useWorkspaceTree, type WorkspaceTree } from "../lib/useWorkspaceTree.js";

const CodeViewer = lazy(() => import("./code-viewer.js"));

/** Open files are tabs; more than a handful is a browser, not an inspector. */
const MAX_TABS = 6;
/** Rows shown while filtering. A filter that returns a repository is noise. */
const MAX_FILTER_RESULTS = 200;

type FileState =
  | { status: "empty" }
  | { status: "loading"; path: string }
  | { status: "loaded"; file: WorkspaceFile }
  | { status: "error"; path: string; message: string };

const CHANGE_LETTER: Record<NonNullable<VcsFileDiff["status"]>, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
};

const FILE_ICON_COMPONENT: Record<FileIconKind, LucideIcon> = {
  folder: Folder,
  "folder-open": FolderOpen,
  code: FileCode,
  json: FileBraces,
  markdown: FileText,
  style: Palette,
  html: Globe,
  image: FileImage,
  config: FileCog,
  shell: FileTerminal,
  lock: FileLock,
  env: FileKey,
  git: GitBranch,
  text: FileText,
  file: File,
};

const FILE_ICON_TONE_CLASS: Record<FileIconTone, string> = {
  info: "text-[var(--color-text-info)]",
  success: "text-[var(--color-text-success)]",
  warning: "text-[var(--color-text-warning)]",
  danger: "text-[var(--color-text-danger)]",
  muted: "text-[var(--color-text-muted)]",
};

function fileName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

// ── Tree ────────────────────────────────────────────────────────────────────

function ChangeBadge({ status }: { status?: string }) {
  if (!status) return null;
  return (
    <span
      className="ml-auto shrink-0 rounded px-1 text-[10px] font-semibold text-[var(--color-text-warning)]"
      title={`${status} in the working tree`}
      data-testid="opencode-file-change-indicator"
    >
      {status}
    </span>
  );
}

function FileIcon({ name, type, expanded }: { name: string; type: "file" | "directory"; expanded?: boolean }) {
  const kind = fileIconKind(name, type, expanded);
  const Icon = FILE_ICON_COMPONENT[kind];
  return (
    <Icon
      size={14}
      aria-hidden="true"
      className={cn("shrink-0", FILE_ICON_TONE_CLASS[FILE_ICON_TONE[kind]])}
      data-testid="opencode-file-icon"
      data-kind={kind}
    />
  );
}

function TreeLevel({
  path,
  depth,
  tree,
  changes,
  activePath,
  onOpenFile,
}: {
  path: string;
  depth: number;
  tree: WorkspaceTree;
  changes: ReadonlyMap<string, string>;
  activePath: string | null;
  onOpenFile: (path: string) => void;
}) {
  const nodes = tree.children.get(path);
  const error = tree.errors.get(path);

  if (error) {
    return (
      <p className="px-2 py-1 text-[11px] text-[var(--color-text-danger)]" role="alert" data-testid="opencode-tree-error">
        {error}{" "}
        <button type="button" className="underline" onClick={() => tree.retry(path)} data-testid="opencode-tree-retry">
          Retry
        </button>
      </p>
    );
  }
  if (!nodes) {
    return tree.loading.has(path) ? (
      <p className="px-2 py-1 text-[11px] text-[var(--color-text-muted)]" role="status" data-testid="opencode-tree-loading">
        Loading…
      </p>
    ) : null;
  }
  if (nodes.length === 0) {
    return (
      <p className="px-2 py-1 text-[11px] text-[var(--color-text-muted)]" data-testid="opencode-tree-empty">
        Empty directory.
      </p>
    );
  }

  return (
    <ul className="list-none">
      {nodes.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={depth}
          tree={tree}
          changes={changes}
          activePath={activePath}
          onOpenFile={onOpenFile}
        />
      ))}
    </ul>
  );
}

function TreeRow({
  node,
  depth,
  tree,
  changes,
  activePath,
  onOpenFile,
}: {
  node: WorkspaceNode;
  depth: number;
  tree: WorkspaceTree;
  changes: ReadonlyMap<string, string>;
  activePath: string | null;
  onOpenFile: (path: string) => void;
}) {
  const directory = node.type === "directory";
  const expanded = tree.expanded.has(node.path);
  const active = activePath === node.path;
  return (
    <li>
      <button
        type="button"
        onClick={() => (directory ? tree.toggle(node.path) : onOpenFile(node.path))}
        {...(directory ? { "aria-expanded": expanded } : { "aria-current": active ? ("true" as const) : undefined })}
        style={{ paddingInlineStart: `${0.5 + depth * 0.75}rem` }}
        className={cn(
          "flex min-h-11 w-full items-center gap-1.5 rounded pe-2 text-left text-[13px] hover:bg-[var(--hh-row-hover)] sm:pointer-fine:min-h-6",
          active && "bg-[var(--color-background-surface-neutral-muted)] font-semibold",
        )}
        data-testid={directory ? "opencode-tree-directory" : "opencode-tree-file"}
        data-path={node.path}
      >
        <span className="flex w-3 shrink-0 items-center justify-center text-[var(--color-text-muted)]" aria-hidden="true">
          {directory && (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
        </span>
        <FileIcon name={node.name} type={node.type} expanded={expanded} />
        <span className="min-w-0 truncate">{node.name}</span>
        <ChangeBadge status={changes.get(node.path)} />
      </button>
      {directory && expanded && (
        <TreeLevel
          path={node.path}
          depth={depth + 1}
          tree={tree}
          changes={changes}
          activePath={activePath}
          onOpenFile={onOpenFile}
        />
      )}
    </li>
  );
}

/**
 * Flat results while a filter is active.
 *
 * Scoped to directories already listed, and it says so: there is no upstream
 * search to delegate to (`GET /find` silently caps at ten results and
 * `/find/symbol` returns nothing at all), so pretending to search the whole
 * repository would be a lie the reader could not detect.
 */
function FilterResults({
  query,
  tree,
  changes,
  activePath,
  onOpenFile,
}: {
  query: string;
  tree: WorkspaceTree;
  changes: ReadonlyMap<string, string>;
  activePath: string | null;
  onOpenFile: (path: string) => void;
}) {
  const needle = query.trim().toLowerCase();
  const matches: WorkspaceNode[] = [];
  const seen = new Set<string>();
  for (const nodes of tree.children.values()) {
    for (const node of nodes) {
      if (seen.has(node.path) || !node.path.toLowerCase().includes(needle)) continue;
      seen.add(node.path);
      matches.push(node);
    }
  }
  matches.sort((a, b) =>
    a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1,
  );
  const shown = matches.slice(0, MAX_FILTER_RESULTS);

  if (shown.length === 0) {
    return (
      <p className="px-2 py-2 text-[11px] text-[var(--color-text-muted)]" data-testid="opencode-filter-empty">
        No expanded file matches “{query.trim()}”. Expand more directories to widen the search.
      </p>
    );
  }
  return (
    <ul className="list-none" data-testid="opencode-filter-results">
      {shown.map((node) => (
        <li key={node.path}>
          <button
            type="button"
            onClick={() => (node.type === "directory" ? tree.toggle(node.path) : onOpenFile(node.path))}
            className={cn(
              "flex min-h-11 w-full items-center gap-1.5 rounded px-2 text-left text-[13px] hover:bg-[var(--hh-row-hover)] sm:pointer-fine:min-h-6",
              activePath === node.path && "bg-[var(--color-background-surface-neutral-muted)] font-semibold",
            )}
            data-testid={node.type === "directory" ? "opencode-tree-directory" : "opencode-tree-file"}
            data-path={node.path}
          >
            <FileIcon
              name={node.name}
              type={node.type}
              expanded={node.type === "directory" ? tree.expanded.has(node.path) : undefined}
            />
            <span className="min-w-0 truncate" title={node.path}>
              {node.path}
            </span>
            <ChangeBadge status={changes.get(node.path)} />
          </button>
        </li>
      ))}
      {matches.length > shown.length && (
        <li className="px-2 py-1 text-[11px] text-[var(--color-text-muted)]" data-testid="opencode-filter-truncated">
          +{matches.length - shown.length} more matches. Narrow the filter.
        </li>
      )}
    </ul>
  );
}

// ── Files tab ───────────────────────────────────────────────────────────────

export function WorkspaceFiles({
  directory,
  target,
  onTargetConsumed,
}: {
  directory: string;
  /** Reference the reader followed here, if any. */
  target: WorkspaceTarget | null;
  onTargetConsumed: () => void;
}) {
  const tree = useWorkspaceTree(directory);
  const [tabs, setTabs] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [state, setState] = useState<FileState>({ status: "empty" });
  const [filter, setFilter] = useState("");
  const [wrap, setWrap] = useState(false);
  const [mobileView, setMobileView] = useState<"tree" | "file">("tree");
  const [changes, setChanges] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [copied, setCopied] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<WorkspaceTarget | undefined>();
  const request = useRef<AbortController | null>(null);
  // The tree helper is rebuilt whenever a directory finishes listing, so the
  // "follow this reference" effect is keyed on the target identity instead of
  // on its dependency array — otherwise every listing would refetch the file.
  const applied = useRef<WorkspaceTarget | null>(null);

  useEffect(() => {
    setTabs([]);
    setActivePath(null);
    setState({ status: "empty" });
    setFilter("");
    setMobileView("tree");
    setHighlight(undefined);
  }, [directory]);

  // Changed-file markers are decoration: a failure leaves the tree unmarked
  // rather than blocking the reason the reader opened this tab.
  useEffect(() => {
    if (!directory) return;
    let cancelled = false;
    void api
      .changes(directory, "git")
      .then((result) => {
        if (cancelled) return;
        const next = new Map<string, string>();
        for (const change of result.changes) {
          if (change.status) next.set(change.file, CHANGE_LETTER[change.status]);
        }
        setChanges(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [directory]);

  const openFile = useCallback(
    (path: string, lines?: WorkspaceTarget) => {
      setActivePath(path);
      setMobileView("file");
      setHighlight(lines?.startLine === undefined ? undefined : lines);
      setTabs((previous) => {
        if (previous.includes(path)) return previous;
        const next = [...previous, path];
        // Drop the oldest tab that is not the one being opened.
        return next.length > MAX_TABS ? next.slice(next.length - MAX_TABS) : next;
      });
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setState({ status: "loading", path });
      void api
        .workspaceFile(directory, path, controller.signal)
        .then((file) => {
          if (controller.signal.aborted) return;
          setState({ status: "loaded", file });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setState({
            status: "error",
            path,
            message: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [directory],
  );

  // Following a reference: expand the ancestors, select the file, and reveal
  // the cited lines. The transcript underneath is untouched.
  useEffect(() => {
    if (!target || applied.current === target) return;
    applied.current = target;
    onTargetConsumed();
    void tree.reveal(target.path);
    openFile(target.path, target);
  }, [onTargetConsumed, openFile, target, tree]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => () => request.current?.abort(), []);

  const breadcrumbs = useMemo(() => {
    if (!activePath) return [];
    const segments = activePath.split("/").filter(Boolean);
    let prefix = "";
    return segments.map((segment, index) => {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      return { label: segment, path: prefix, last: index === segments.length - 1 };
    });
  }, [activePath]);

  const copy = (label: string, value: string) => {
    void navigator.clipboard?.writeText(value).then(
      () => setCopied(label),
      () => setCopied(null),
    );
  };

  const closeTab = (path: string) => {
    const remaining = tabs.filter((candidate) => candidate !== path);
    setTabs(remaining);
    if (path !== activePath) return;
    const fallback = remaining[remaining.length - 1];
    if (fallback) {
      openFile(fallback);
      return;
    }
    request.current?.abort();
    setActivePath(null);
    setState({ status: "empty" });
    setMobileView("tree");
  };

  const file = state.status === "loaded" ? state.file : null;

  return (
    // Not `opencode-workspace-files`: that id already belongs to the drawer's
    // Files tab button, and two elements sharing it makes every query ambiguous.
    <div className="flex min-h-0 flex-1 flex-col sm:flex-row" data-testid="opencode-workspace-files-panel">
      <div
        className={cn(
          "flex min-h-0 flex-col border-[var(--color-border-default)] sm:w-64 sm:shrink-0 sm:border-e",
          mobileView === "file" ? "hidden sm:flex" : "flex flex-1 sm:flex-none",
        )}
        data-testid="opencode-file-tree"
      >
        <div className="border-b border-[var(--color-border-default)] p-2">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter files…"
            aria-label="Filter workspace files"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            className="min-h-9 w-full rounded-md border border-[var(--color-border-default)] bg-transparent px-2 text-sm outline-none focus:border-[var(--color-border-focus)] pointer-coarse:min-h-11"
            data-testid="opencode-file-filter"
          />
        </div>
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto py-1">
          {filter.trim() ? (
            <FilterResults
              query={filter}
              tree={tree}
              changes={changes}
              activePath={activePath}
              onOpenFile={(path) => openFile(path)}
            />
          ) : (
            <TreeLevel
              path={WORKSPACE_TREE_ROOT}
              depth={0}
              tree={tree}
              changes={changes}
              activePath={activePath}
              onOpenFile={(path) => openFile(path)}
            />
          )}
        </div>
      </div>

      <div
        className={cn(
          // `min-w-0` is load-bearing, not tidiness: a flex item defaults to
          // `min-width: auto`, so CodeMirror's intrinsic line width would stop
          // this pane shrinking to the drawer and push the toolbar past the
          // drawer's edge, where the wrap toggle became unreachable.
          "min-h-0 min-w-0 flex-1 flex-col",
          mobileView === "file" ? "flex" : "hidden sm:flex",
        )}
        data-testid="opencode-file-pane"
      >
        {tabs.length > 0 && (
          <div
            className="thin-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--color-border-default)] p-1"
            aria-label="Open files"
            data-testid="opencode-file-tabs"
          >
            {tabs.map((path) => (
              <span key={path} className="flex shrink-0 items-center">
                <button
                  type="button"
                  aria-current={path === activePath ? "true" : undefined}
                  onClick={() => openFile(path)}
                  title={path}
                  className={cn(
                    "min-h-8 max-w-40 truncate rounded-s px-2 text-[11px] pointer-coarse:min-h-10",
                    path === activePath
                      ? "bg-[var(--color-background-surface-neutral-muted)] font-semibold"
                      : "text-[var(--color-text-muted)] hover:bg-[var(--hh-row-hover)]",
                  )}
                  data-testid="opencode-file-tab"
                  data-path={path}
                >
                  {fileName(path)}
                </button>
                <button
                  type="button"
                  onClick={() => closeTab(path)}
                  aria-label={`Close ${path}`}
                  className="min-h-8 rounded-e px-1.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--hh-row-hover)] pointer-coarse:min-h-10"
                  data-testid="opencode-file-tab-close"
                  data-path={path}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--color-border-default)] px-2 py-1.5">
          <button
            type="button"
            onClick={() => setMobileView("tree")}
            className="min-h-9 rounded px-2 text-xs text-[var(--color-text-muted)] hover:bg-[var(--hh-row-hover)] hover:text-[var(--color-text-default)] sm:hidden pointer-coarse:min-h-11"
            data-testid="opencode-files-back"
          >
            ← Files
          </button>
          {activePath ? (
            <nav aria-label="File path" className="flex min-w-0 flex-wrap items-center gap-0.5 text-[11px]" data-testid="opencode-file-breadcrumbs">
              {breadcrumbs.map((crumb) => (
                <span key={crumb.path} className="flex items-center gap-0.5">
                  {crumb.last ? (
                    <span className="font-semibold" aria-current="page" data-testid="opencode-breadcrumb-file">
                      {crumb.label}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        if (!tree.expanded.has(crumb.path)) tree.toggle(crumb.path);
                        setFilter("");
                        setMobileView("tree");
                      }}
                      className="min-h-7 rounded px-1 text-[var(--color-text-info)] underline-offset-2 hover:underline pointer-coarse:min-h-9"
                      data-testid="opencode-breadcrumb-directory"
                      data-path={crumb.path}
                    >
                      {crumb.label}
                    </button>
                  )}
                  {!crumb.last && <span className="text-[var(--color-text-muted)]" aria-hidden>/</span>}
                </span>
              ))}
            </nav>
          ) : (
            <span className="text-[11px] text-[var(--color-text-muted)]">No file selected</span>
          )}
          <span className="flex-1" aria-hidden />
          {activePath && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] pointer-coarse:h-11" onClick={() => copy("path", activePath)} data-testid="opencode-copy-path">
              Copy path
            </Button>
          )}
          {file?.type === "text" && (
            <>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] pointer-coarse:h-11" onClick={() => copy("contents", file.content)} data-testid="opencode-copy-content">
                Copy file
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] pointer-coarse:h-11" onClick={() => setWrap((value) => !value)} aria-pressed={wrap} data-testid="opencode-code-wrap">
                {wrap ? "Wrap: on" : "Wrap: off"}
              </Button>
            </>
          )}
          <span className="text-[11px] text-[var(--color-text-success)]" role="status" data-testid="opencode-copy-status">
            {copied ? `Copied ${copied}` : ""}
          </span>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          {state.status === "empty" && (
            <p className="p-4 text-sm text-[var(--color-text-muted)]" data-testid="opencode-file-empty">
              Select a file, or follow a file reference from the transcript.
            </p>
          )}
          {state.status === "loading" && (
            <p className="p-4 text-sm text-[var(--color-text-muted)]" role="status" data-testid="opencode-file-loading">
              Loading {state.path}…
            </p>
          )}
          {state.status === "error" && (
            <div className="p-3" data-testid="opencode-file-error">
              <Alert variant="danger">
                Could not open {state.path}: {state.message}
              </Alert>
            </div>
          )}
          {file?.type === "binary" && (
            <p className="p-4 text-sm text-[var(--color-text-muted)]" data-testid="opencode-file-binary">
              Binary file ({file.mimeType ?? "unknown type"}). There is nothing to display.
            </p>
          )}
          {file?.type === "text" && (
            <Suspense
              fallback={
                <p className="p-4 text-sm text-[var(--color-text-muted)]" role="status" data-testid="opencode-viewer-loading">
                  Loading the viewer…
                </p>
              }
            >
              <CodeViewer
                path={file.path}
                content={file.content}
                target={highlight?.path === file.path ? highlight : undefined}
                wrap={wrap}
              />
            </Suspense>
          )}
        </div>
        {highlight?.startLine !== undefined && highlight.path === activePath && (
          <p className="shrink-0 border-t border-[var(--color-border-default)] px-2 py-1 text-[11px] text-[var(--color-text-muted)]" data-testid="opencode-file-target">
            Showing{describeLineRange(highlight)}
          </p>
        )}
      </div>
    </div>
  );
}
