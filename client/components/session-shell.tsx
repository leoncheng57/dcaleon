import { useCallback, useState, type ClipboardEvent, type FocusEvent, type ReactNode, type RefObject, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowDown, Globe } from "lucide-react";

import { Button } from "../ds/button.js";
import { SessionActionBar } from "./session-action-bar.js";
import { RightToolsPanel } from "./right-tools-panel.js";
import { TranscriptBrowserContext } from "../lib/transcriptBrowser.js";
import { RunningIndicator, Transcript } from "../components/transcript.js";
import type { DisplayItem, RunningActivity } from "../lib/derive.js";
import type { UserEvent, AgentEvent } from "../lib/transcript.js";

export interface SessionShellTestIds {
  root: string;
  transcript: string;
  jumpToLatest: string;
  composerCard: string;
  textarea: string;
  send: string;
  title?: string;
  composerForm?: string;
  controlsRow?: string;
  actions?: string;
}

export interface SessionShellProps {
  testIds: SessionShellTestIds;
  /** Runtime-prefixed conversation ID; all islands use the same tools slot. */
  browserSessionID: string;

  header: {
    backLink: ReactNode;
    title: string;
    badges?: ReactNode;
    stats?: ReactNode;
    actions: ReactNode;
  };

  banners?: ReactNode;

  transcript: {
    items: DisplayItem[];
    wrap: boolean;
    collapsedGroups: Record<string, boolean>;
    collapseCompletedByDefault?: boolean;
    onToggleGroup: (id: string) => void;
    onExport?: (event: UserEvent | AgentEvent) => void;
    directory?: string;
    sessionId?: string;
    onOpenWorkspaceChanges?: () => void;
    referenceProvider: (children: ReactNode) => ReactNode;
    loaded: boolean;
    running: boolean;
    activity: RunningActivity;
    emptyState?: ReactNode;
    loadingState?: ReactNode;
  };

  scroll: {
    scrollerRef: RefObject<HTMLDivElement | null>;
    contentRef?: RefObject<HTMLDivElement | null>;
    onScroll: () => void;
    showNewActivity: boolean;
    onJumpToLatest: () => void;
    beforeTranscript?: ReactNode;
  };

  composer: {
    draft: string;
    onDraftChange: (text: string) => void;
    composerRef: RefObject<HTMLTextAreaElement | null>;
    onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
    onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
    onFocus?: (event: FocusEvent<HTMLTextAreaElement>) => void;
    onBlur?: (event: FocusEvent<HTMLTextAreaElement>) => void;
    placeholder: string;
    disabled: boolean;
    onSubmit: () => void;
    submitLabel: string;
    submitDisabled: boolean;
    modeControl: ReactNode;
    modelPicker: ReactNode;
    /** Rendered after the model picker inside the controls row (collapse button, status text). */
    controlsRowEnd?: ReactNode;
    /** When set, the controls row and card are replaced by this node (collapsed composer). */
    collapsedBar?: ReactNode;
    /** Ref for the max-width wrapper; pages use it for blur-based collapse detection. */
    wrapperRef?: RefObject<HTMLFormElement | null>;
    /** Fired on pointerdown (capture) across controls and the bottom rail — arms collapse guards. */
    onControlsPointerDownCapture?: () => void;
    beforeComposer?: ReactNode;
    beforeTextarea?: ReactNode;
    bottomRailStart?: ReactNode;
    bottomRailEnd?: ReactNode;
  };

  inspector?: {
    desktop: ReactNode;
  };

  overlays?: ReactNode;
}

export function SessionShell({ testIds, browserSessionID, header, banners, transcript, scroll, composer, inspector, overlays }: SessionShellProps) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [browserNavigation, setBrowserNavigation] = useState<{ id: number; url: string; sessionID: string }>();
  const openTranscriptBrowser = useCallback((url: string) => {
    setBrowserNavigation((previous) => ({ id: (previous?.id ?? 0) + 1, url, sessionID: browserSessionID }));
    setToolsOpen(true);
  }, [browserSessionID]);
  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--color-background-base)]" data-testid={testIds.root}>
      <header className="flex shrink-0 flex-col gap-1.5 border-b border-[var(--color-border-default)] px-3 py-2 sm:px-4 sm:py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {header.backLink}
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold sm:text-base" data-testid={testIds.title}>
            {header.title}
          </h1>
          {header.badges}
        </div>
        {(header.stats || header.actions || browserSessionID) && (
          <div className="flex min-w-0 flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:gap-3">
            {header.stats && <div className="min-w-0 shrink-0">{header.stats}</div>}
            <SessionActionBar testId={testIds.actions}>
              <Button size="md" variant="ghost" className="min-h-11 min-w-12 px-0"
                onClick={() => setToolsOpen(true)} disabled={!browserSessionID}
                aria-label="Open live browser" title="Browser / Minichats / Terminal"
                aria-expanded={toolsOpen} data-testid="opencode-live-browser-open">
                <Globe aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
              {header.actions}
            </SessionActionBar>
          </div>
        )}
      </header>

      <div className="max-h-[25%] shrink-0 overflow-y-auto">
        {banners}
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="relative min-h-0 min-w-0 flex-1">
          <div
            ref={scroll.scrollerRef}
            onScroll={scroll.onScroll}
            className="thin-scrollbar h-full min-w-0 overflow-y-auto overscroll-contain px-3 py-6 sm:px-6 sm:py-8"
            data-testid={testIds.transcript}
          >
            <div ref={scroll.contentRef} className="mx-auto min-w-0 max-w-3xl">
              {scroll.beforeTranscript}
              {!transcript.loaded ? (
                (transcript.loadingState ?? <div className="py-16 text-center text-sm text-[var(--color-text-muted)]">Loading...</div>)
              ) : transcript.items.length === 0 ? (
                transcript.emptyState
              ) : (
                <TranscriptBrowserContext.Provider value={openTranscriptBrowser}>{transcript.referenceProvider(
                  <Transcript
                    items={transcript.items}
                    wrap={transcript.wrap}
                    collapsedGroups={transcript.collapsedGroups}
                    collapseCompletedByDefault={transcript.collapseCompletedByDefault}
                    onToggleGroup={transcript.onToggleGroup}
                    onExport={transcript.onExport}
                    directory={transcript.directory}
                    sessionId={transcript.sessionId}
                    onOpenWorkspaceChanges={transcript.onOpenWorkspaceChanges}
                  />
                )}</TranscriptBrowserContext.Provider>
              )}
              {transcript.running && (
                <div className="mt-5">
                  <RunningIndicator activity={transcript.activity} />
                </div>
              )}
            </div>
          </div>
          {scroll.showNewActivity && (
            <button
              type="button"
              className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--color-border-default)] bg-[var(--color-background-surface)] px-3 py-1.5 text-xs font-medium shadow-lg transition-colors hover:bg-[var(--color-background-surface-neutral-muted)]"
              onClick={scroll.onJumpToLatest}
              data-testid={testIds.jumpToLatest}
            >
              <ArrowDown aria-hidden="true" size={13} />
              New activity
            </button>
          )}
        </div>
        <div className={toolsOpen ? "hidden" : "contents"}>{inspector?.desktop}</div>
        {toolsOpen && browserSessionID && <RightToolsPanel key={browserSessionID} sessionID={browserSessionID} navigation={browserNavigation?.sessionID === browserSessionID ? browserNavigation : undefined} onClose={() => { setToolsOpen(false); setBrowserNavigation(undefined); }} />}
      </div>

      <footer
        className="relative z-20 shrink-0 border-t border-[var(--color-border-default)] bg-[var(--color-background-surface)] px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        data-testid={testIds.composerForm}
      >
        <form className="mx-auto max-w-3xl" ref={composer.wrapperRef} onSubmit={(event) => { event.preventDefault(); composer.onSubmit(); }}>
          {composer.beforeComposer}
          {composer.collapsedBar ? composer.collapsedBar : <>
          <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2" data-testid={testIds.controlsRow} onPointerDownCapture={composer.onControlsPointerDownCapture}>
            {composer.modeControl}
            {composer.modelPicker}
            {composer.controlsRowEnd}
          </div>
          {composer.beforeTextarea}
          <div
            className="min-w-0 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-background-surface)] transition-colors focus-within:border-[var(--color-border-focus)]"
            data-testid={testIds.composerCard}
          >
            <textarea
              ref={composer.composerRef}
              className="thin-scrollbar block max-h-64 min-h-24 w-full resize-none border-0 bg-transparent p-3 text-base text-[var(--color-text-default)] outline-none placeholder:text-[var(--color-text-muted)] sm:min-h-16 sm:p-2.5 sm:text-sm"
              value={composer.draft}
              onChange={(event) => composer.onDraftChange(event.target.value)}
              onKeyDown={composer.onKeyDown}
              onPaste={composer.onPaste}
              onFocus={composer.onFocus}
              onBlur={composer.onBlur}
              placeholder={composer.placeholder}
              disabled={composer.disabled}
              rows={1}
              enterKeyHint="enter"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              data-testid={testIds.textarea}
            />
            <div className="flex min-w-0 items-center gap-2 border-t border-[var(--color-border-default)] px-2 py-2 sm:py-1" onPointerDownCapture={composer.onControlsPointerDownCapture}>
              {composer.bottomRailStart}
              <span className="flex-1" aria-hidden="true" />
              {composer.bottomRailEnd}
              <Button
                size="sm"
                className="min-h-11 shrink-0 sm:min-h-8"
                type="submit"
                disabled={composer.submitDisabled}
                data-testid={testIds.send}
              >
                {composer.submitLabel}
              </Button>
            </div>
          </div>
          </>}
        </form>
      </footer>

      {overlays}
    </main>
  );
}
