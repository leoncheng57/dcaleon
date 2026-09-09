import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Eye, FlaskConical, ListTree, OctagonX, Send } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import { Badge } from "../ds/badge.js";
import { Button } from "../ds/button.js";
import { SessionShell } from "../components/session-shell.js";
import { SessionInspector } from "../components/session-inspector.js";
import { PreviewDrawer } from "../components/preview-drawer.js";
import { DshTrajectoryInspector } from "../components/dsh-trajectory-inspector.js";
import { api, type DshSessionSummary } from "../lib/api.js";
import { collapseActionGroups } from "../lib/derive.js";
import { PUBLIC_SIMULATOR } from "../lib/runtime.js";
import { useTranscriptFollow } from "../lib/useTranscriptFollow.js";
import type { TranscriptEvent } from "../lib/transcript.js";
import type { InspectorTab } from "../lib/inspectorTabs.js";

export function DshConversationPage() {
  const { id = "" } = useParams();
  const [session, setSession] = useState<DshSessionSummary | null>(null);
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState(false);
  const [trajectoryOpen, setTrajectoryOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [requestedInspectorTab, setRequestedInspectorTab] = useState<InspectorTab | undefined>();
  const refreshInFlight = useRef(false);
  const refreshQueued = useRef<string | null>(null);
  const sessionScope = useRef(id);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const follow = useTranscriptFollow(events);

  const load = async (targetId: string) => {
    if (refreshInFlight.current) {
      refreshQueued.current = targetId;
      return;
    }
    refreshInFlight.current = true;
    try {
      const result = await api.dshSession(targetId);
      if (sessionScope.current !== targetId) return;
      setSession(result.session);
      setEvents(result.events);
      setSending(false);
      setError("");
    } catch (cause) {
      if (sessionScope.current !== targetId) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      refreshInFlight.current = false;
      const queued = refreshQueued.current;
      refreshQueued.current = null;
      if (queued) {
        void load(queued);
      }
    }
  };
  const refresh = () => load(id);

  useEffect(() => {
    sessionScope.current = id;
    refreshQueued.current = null;
    setSession(null);
    setEvents([]);
    void refresh();
    if (PUBLIC_SIMULATOR) return;
    const source = new EventSource(api.dshEventsUrl(id));
    let timer: ReturnType<typeof setTimeout> | undefined;
    source.addEventListener("update", () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 250);
    });
    source.addEventListener("ready", () => void refresh());
    source.onerror = () => undefined;
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [id]);

  useEffect(() => {
    if (session?.title) document.title = `${session.title} | DCA`;
  }, [session?.title]);

  const items = useMemo(() => collapseActionGroups(events), [events]);
  const running = session?.running === true;

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || running) return;
    setSending(true);
    setDraft("");
    setError("");
    try {
      await api.promptDsh(id, text);
      await refresh();
    } catch (cause) {
      setDraft(text);
      setSending(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };
  const cancel = async () => {
    try {
      await api.cancelDsh(id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <>
    <SessionShell
      browserSessionID={id}
      testIds={{
        root: "dsh-conversation",
        transcript: "dsh-transcript",
        jumpToLatest: "dsh-jump-to-latest",
        composerCard: "dsh-composer-card",
        textarea: "dsh-prompt",
        send: "dsh-send",
        title: "dsh-session-title",
      }}
      header={{
        backLink: (
          <Link to="/dsh" className="hidden shrink-0 text-sm underline sm:inline" data-testid="dsh-back">
            ← DSH lab
          </Link>
        ),
        title: session?.title ?? "Conversation",
        onRenameTitle: async (newTitle) => {
          const result = await api.renameDsh(id, newTitle);
          setSession(result.session);
        },
        badges: (
          <>
            <Badge variant="neutral">{session?.mode === "build" ? "Build · may edit files" : "Read only"}</Badge>
            <Badge variant="neutral">{session?.presetId ?? "Loading"}</Badge>
            {running && <Badge variant="info">running</Badge>}
            {running && (
              <button
                type="button"
                className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-[var(--color-text-danger)] hover:bg-[var(--color-background-surface-danger-muted)]"
                onClick={() => void cancel()}
                aria-label="Stop running agent"
                title="Stop running agent"
                data-testid="dsh-stop"
              >
                <OctagonX aria-hidden="true" className="h-4 w-4" />
              </button>
            )}
          </>
        ),
        actions: (
          <>
            <Button
              size="md"
              variant="ghost"
              className="min-h-11 min-w-12 px-0"
              onClick={() => { setRequestedInspectorTab("runlog"); setInspectorOpen(true); }}
              aria-label="Open run log"
              title="Open run log"
              data-testid="dsh-open-runlog"
            >
              <ListTree aria-hidden="true" className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="md"
              variant="ghost"
              className="min-h-11 min-w-12 px-0"
              onClick={() => setTrajectoryOpen(true)}
              aria-label="Open trajectory"
              title="Open trajectory"
              data-testid="dsh-open-trajectory"
            >
              <ListTree aria-hidden="true" className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="md"
              variant="ghost"
              className="min-h-11 min-w-12 px-0"
              onClick={() => setPreview(true)}
              aria-label="Open preview"
              title="Open preview"
              data-testid="dsh-open-preview"
            >
              <Eye aria-hidden="true" className="h-3.5 w-3.5" />
            </Button>
          </>
        ),
      }}
      banners={error ? <div className="shrink-0 p-3"><p className="text-sm text-[var(--color-text-danger)]" role="alert">{error}</p></div> : undefined}
      transcript={{
        items,
        wrap: true,
        collapsedGroups: {},
        onToggleGroup: () => undefined,
        referenceProvider: (children) => children,
        loaded: true,
        running,
        activity: { kind: "thinking", since: session?.updatedAt ?? "" },
        emptyState: !error ? (
          <div className="py-20 text-center">
            <FlaskConical aria-hidden="true" className="mx-auto mb-3 text-[var(--color-text-muted)]" />
            <p className="text-sm text-[var(--color-text-muted)]">Ask DSH to inspect this allowlisted workspace. V1 cannot modify files.</p>
          </div>
        ) : undefined,
      }}
      scroll={{
        scrollerRef: follow.scrollerRef,
        contentRef: follow.contentRef,
        onScroll: follow.onScroll,
        showNewActivity: follow.newActivity,
        onJumpToLatest: follow.jumpToLatest,
      }}
      composer={{
        draft,
        onDraftChange: setDraft,
        composerRef,
        onKeyDown: keyDown,
        placeholder: "Ask DSH to inspect the workspace...",
        disabled: !session || running,
        onSubmit: () => void send(),
        submitLabel: sending ? "Sending…" : "Send",
        submitDisabled: !draft.trim() || sending || !session,
        modeControl: null,
        modelPicker: null,
      }}
      inspector={{
        desktop: (
          <SessionInspector
            directory=""
            sessionID={id}
            events={events}
            trajectory={{ sessionId: id, running }}
            requestedTab={requestedInspectorTab}
            mobileOpen={inspectorOpen}
            onMobileClose={() => setInspectorOpen(false)}
          />
        ),
      }}
      overlays={(
        <>
          {preview && <PreviewDrawer onClose={() => setPreview(false)} />}
          {trajectoryOpen && <DshTrajectoryInspector key={id} sessionId={id} open running={running} onClose={() => setTrajectoryOpen(false)} />}
        </>
      )}
    />
    </>
  );
}
