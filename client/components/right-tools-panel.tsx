import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Globe2,
  MessageSquareText,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";

import { Alert } from "../ds/alert.js";
import { ResponsivePanel } from "../ds/responsive-panel.js";
import { PanelSelector } from "../ds/panel-selector.js";
import { PanelState } from "../ds/panel-state.js";
import { Button } from "../ds/button.js";
import { PUBLIC_SIMULATOR } from "../lib/runtime.js";

type ToolDestination = "browser" | "minichats" | "terminal";

const VIEWPORT_BOUNDS = { minWidth: 320, maxWidth: 1600, minHeight: 320, maxHeight: 1200 } as const;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

const DESTINATIONS = [
  { id: "browser", label: "Browser", Icon: Globe2, ready: true },
  { id: "minichats", label: "Minichats", Icon: MessageSquareText, ready: false },
  { id: "terminal", label: "Terminal", Icon: TerminalSquare, ready: false },
] as const;

interface PageState {
  sessionID: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  pendingPopup: string | null;
}

interface CapacitySlot {
  sessionID: string;
  url: string;
  lastUsedAt: number;
}

async function browserApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/browser/${path}`, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; slots?: CapacitySlot[] };
    const error = new Error(body.error || `live browser request failed (${response.status})`) as Error & {
      slots?: CapacitySlot[];
    };
    if (body.slots) error.slots = body.slots;
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function RightToolsPanel({ sessionID, onClose }: { sessionID: string; onClose: () => void }) {
  const [destination, setDestination] = useState<ToolDestination>("browser");
  const active = DESTINATIONS.find((option) => option.id === destination)!;
  return (
    <ResponsivePanel label={`${active.label} tools panel`} width={destination === "browser" ? "wide" : "standard"}
      onClose={onClose} testId="opencode-right-tools-panel" closeTestId="opencode-right-tools-close" destination={destination}
      subtitle={destination === "browser" ? "Session browser" : "Coming soon"}
      header={<PanelSelector value={destination} onChange={setDestination} testId="opencode-right-tools-selector"
        menuTestId="opencode-right-tools-menu" options={DESTINATIONS.map(({ id, label, Icon, ready }) => ({
          id, label, icon: <Icon aria-hidden="true" size={15} />, wip: !ready, testId: `opencode-right-tools-${id}`,
        }))} />}
    >
      {destination === "browser" ? <LiveBrowserSurface key={sessionID} sessionID={sessionID} /> : <WorkInProgress destination={destination} />}
    </ResponsivePanel>
  );
}

function WorkInProgress({ destination }: { destination: Exclude<ToolDestination, "browser"> }) {
  const minichats = destination === "minichats";
  const Icon = minichats ? MessageSquareText : TerminalSquare;
  const issue = minichats ? 56 : 59;
  return <PanelState kind="wip" title={minichats ? "Minichats" : "Terminal"} icon={<Icon aria-hidden="true" size={22} />}
    testId={`opencode-${destination}-wip`}
    description={minichats
      ? "A lightweight transcript-aware conversation will live here without steering the primary run."
      : "A workspace terminal will live here after its host-access security boundary is implemented."}
    action={<a href={`https://github.com/leoncheng57/dcaleon/issues/${issue}`} target="_blank" rel="noreferrer"
      data-testid={`opencode-${destination}-issue`}
      className="inline-flex min-h-11 items-center text-sm font-medium text-[var(--color-text-info)] underline underline-offset-2">
      Follow issue #{issue}
    </a>} />;
}

function LiveBrowserSurface({ sessionID }: { sessionID: string }) {
  const [state, setState] = useState<PageState | null>(null);
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [streamError, setStreamError] = useState(false);
  const [capacity, setCapacity] = useState<CapacitySlot[] | null>(null);
  const [streamKey, setStreamKey] = useState(0);
  const [streamReady, setStreamReady] = useState(false);
  const [popup, setPopup] = useState<string | null>(null);
  const [pageText, setPageText] = useState("");
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT);
  const [coarse, setCoarse] = useState(() => window.matchMedia("(pointer: coarse)").matches);
  const stageRef = useRef<HTMLDivElement>(null);
  const addressEdited = useRef(false);
  const viewportRef = useRef(DEFAULT_VIEWPORT);
  const activeTouch = useRef<number | null>(null);
  const suppressClick = useRef(false);

  const sendInput = useCallback((event: Record<string, unknown>) => (
    browserApi(`${sessionID}/input`, { method: "POST", body: JSON.stringify(event) })
  ), [sessionID]);

  const applyViewport = useCallback((next: { width: number; height: number }) => {
    viewportRef.current = next;
    setViewport(next);
    void sendInput({ type: "viewport", ...next }).catch(() => undefined);
  }, [sendInput]);

  const refreshState = useCallback(async () => {
    try {
      const next = await browserApi<PageState>(`${sessionID}/state`);
      setState(next);
      if (next.pendingPopup) setPopup(next.pendingPopup);
      if (!addressEdited.current) setAddress(next.url === "about:blank" ? "" : next.url);
    } catch {
      // Open, navigation and stream paths surface actionable errors.
    }
  }, [sessionID]);

  const openBrowser = useCallback(async () => {
    setStreamReady(false);
    setError("");
    setStreamError(false);
    setCapacity(null);
    try {
      const next = await browserApi<PageState>(`${sessionID}/open`, { method: "POST", body: JSON.stringify({}) });
      setAddress(next.url === "about:blank" ? "" : next.url);
      addressEdited.current = false;
      await sendInput({ type: "viewport", ...viewportRef.current }).catch(() => undefined);
      setState(next);
      setStreamKey((key) => key + 1);
      setStreamReady(true);
    } catch (cause) {
      const typed = cause as Error & { slots?: CapacitySlot[] };
      setError(typed.message);
      if (typed.slots) setCapacity(typed.slots);
    }
  }, [sendInput, sessionID]);

  useEffect(() => {
    if (PUBLIC_SIMULATOR) return;
    void openBrowser();
    const timer = setInterval(() => void refreshState(), 2000);
    return () => clearInterval(timer);
  }, [openBrowser, refreshState]);

  useEffect(() => {
    const media = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarse(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (PUBLIC_SIMULATOR) return;
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const width = Math.min(VIEWPORT_BOUNDS.maxWidth, Math.max(VIEWPORT_BOUNDS.minWidth, Math.floor(entry.contentRect.width - 16)));
        const height = Math.min(VIEWPORT_BOUNDS.maxHeight, Math.max(VIEWPORT_BOUNDS.minHeight, Math.floor(entry.contentRect.height - 16)));
        const current = viewportRef.current;
        if (width !== current.width || height !== current.height) applyViewport({ width, height });
      }, 100);
    });
    observer.observe(stage);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [applyViewport]);

  const navigate = async (body: { action: string; url?: string }) => {
    setError("");
    try {
      const next = await browserApi<PageState>(`${sessionID}/navigate`, { method: "POST", body: JSON.stringify(body) });
      setState(next);
      addressEdited.current = false;
      setAddress(next.url === "about:blank" ? "" : next.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const frameCoordinates = (event: ReactPointerEvent<HTMLImageElement> | React.MouseEvent<HTMLImageElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * viewportRef.current.width,
      y: ((event.clientY - bounds.top) / bounds.height) * viewportRef.current.height,
    };
  };

  const touchEvent = (phase: "start" | "move" | "end" | "cancel", event: ReactPointerEvent<HTMLImageElement>) => {
    if (event.pointerType !== "touch") return;
    event.preventDefault();
    if (phase === "start") {
      if (activeTouch.current !== null) return;
      activeTouch.current = event.pointerId;
      suppressClick.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    } else if (activeTouch.current !== event.pointerId) return;
    const points = phase === "end" || phase === "cancel"
      ? []
      : [{ ...frameCoordinates(event), id: 0 }];
    void sendInput({ type: "touch", phase, points }).catch(() => undefined);
    if (phase === "end" || phase === "cancel") activeTouch.current = null;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="opencode-live-browser">
      <div className="flex min-h-12 shrink-0 items-center gap-1 border-b border-[var(--color-border-default)] p-2">
        <Button size="sm" variant="ghost" className="min-w-10 px-0" disabled={!state?.canGoBack} onClick={() => void navigate({ action: "back" })} aria-label="Back" title="Back" data-testid="opencode-live-browser-back"><ChevronLeft aria-hidden="true" size={17} /></Button>
        <Button size="sm" variant="ghost" className="min-w-10 px-0" disabled={!state?.canGoForward} onClick={() => void navigate({ action: "forward" })} aria-label="Forward" title="Forward" data-testid="opencode-live-browser-forward"><ChevronRight aria-hidden="true" size={17} /></Button>
        <Button size="sm" variant="ghost" className="min-w-10 px-0" disabled={!state} onClick={() => void navigate({ action: "reload" })} aria-label="Reload" title="Reload" data-testid="opencode-live-browser-reload"><RefreshCw aria-hidden="true" size={15} className={state?.loading ? "animate-spin motion-reduce:animate-none" : ""} /></Button>
        <form
          className="flex min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (address.trim()) void navigate({ action: "goto", url: address.trim() });
          }}
        >
          <input
            value={address}
            onChange={(event) => { addressEdited.current = true; setAddress(event.target.value); }}
            placeholder={PUBLIC_SIMULATOR ? "Live browser unavailable in simulator" : "Search or enter a URL"}
            disabled={PUBLIC_SIMULATOR || !state}
            className="min-w-0 flex-1 rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-base)] px-3 py-1.5 text-xs outline-none focus:border-[var(--color-border-focus)]"
            aria-label="Address"
            data-testid="opencode-live-browser-address"
          />
        </form>
      </div>

      {error && (
        <div className="border-b border-[var(--color-border-default)] p-3" role="status">
          <Alert variant="danger" data-testid="opencode-live-browser-error">{error}</Alert>
          {capacity ? (
            <ul className="mt-2 grid gap-1 text-xs" data-testid="opencode-live-browser-slots">
              {capacity.map((slot) => (
                <li key={slot.sessionID} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[var(--color-text-muted)]">{slot.sessionID} — {slot.url || "blank"}</span>
                  <Button size="sm" variant="secondary" onClick={() => {
                    void browserApi(`${slot.sessionID}`, { method: "DELETE" }).then(() => void openBrowser());
                  }} data-testid="opencode-live-browser-release">Release</Button>
                </li>
              ))}
            </ul>
          ) : (
            <Button size="sm" variant="secondary" className="mt-2" onClick={() => void openBrowser()} data-testid="opencode-live-browser-retry">Retry</Button>
          )}
        </div>
      )}

      {popup && (
        <div className="border-b border-[var(--color-border-default)] bg-[var(--color-background-surface-info-muted)] p-3 text-xs" role="alertdialog" aria-label="Open link" data-testid="opencode-live-browser-popup">
          <p className="mb-2 break-all">The page tried to open <strong>{popup}</strong></p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => { void navigate({ action: "goto", url: popup }); setPopup(null); }} data-testid="opencode-live-browser-popup-here">Open here</Button>
            <Button size="sm" variant="secondary" onClick={() => { window.open(popup, "_blank", "noopener,noreferrer"); setPopup(null); }} data-testid="opencode-live-browser-popup-newtab">Open in a new tab</Button>
            <Button size="sm" variant="ghost" onClick={() => setPopup(null)} data-testid="opencode-live-browser-popup-dismiss">Dismiss</Button>
          </div>
        </div>
      )}

      <div ref={stageRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[var(--color-background-surface-neutral-muted)] p-2" data-testid="opencode-live-browser-stage">
        {PUBLIC_SIMULATOR ? (
          <div className="max-w-sm text-center" data-testid="opencode-live-browser-simulator">
            <Globe2 aria-hidden="true" className="mx-auto text-[var(--color-text-muted)]" size={28} />
            <h2 className="mt-3 text-sm font-semibold">Live browser unavailable in the simulator</h2>
            <p className="mt-2 text-xs leading-5 text-[var(--color-text-muted)]">The installed app drives server-side Chromium. This preview keeps the same panel navigation without starting a browser.</p>
          </div>
        ) : !streamReady && !error ? (
          <div className="text-center" role="status" aria-live="polite" data-testid="opencode-live-browser-starting">
            <RefreshCw aria-hidden="true" className="mx-auto animate-spin text-[var(--color-text-muted)] motion-reduce:animate-none" size={22} />
            <p className="mt-3 text-sm font-medium">Starting browser…</p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">The first launch can take a moment.</p>
          </div>
        ) : streamReady && state ? (
          <>
            {/* The page is a pixel stream. Pointer and keyboard input are forwarded to Chromium. */}
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
            <img
              key={`${streamKey}-${coarse ? "coarse" : "default"}`}
              src={`/api/browser/${encodeURIComponent(sessionID)}/stream?profile=${coarse ? "coarse" : "default"}&key=${streamKey}`}
              alt="Live browser page"
              width={viewport.width}
              height={viewport.height}
              tabIndex={0}
              className="h-auto max-h-full w-auto max-w-full select-none border border-[var(--color-border-default)] bg-white shadow-sm outline-none [touch-action:none] focus:ring-2 focus:ring-[var(--color-border-focus)]"
              draggable={false}
              onLoad={() => setStreamError(false)}
              onError={() => setStreamError(true)}
              onClick={(event) => {
                if (suppressClick.current) { suppressClick.current = false; return; }
                void sendInput({ type: "click", ...frameCoordinates(event) }).catch(() => undefined);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                void sendInput({ type: "click", button: "right", ...frameCoordinates(event) }).catch(() => undefined);
              }}
              onWheel={(event) => { void sendInput({ type: "scroll", deltaY: event.deltaY, ...frameCoordinates(event) }).catch(() => undefined); }}
              onPointerDown={(event) => touchEvent("start", event)}
              onPointerMove={(event) => touchEvent("move", event)}
              onPointerUp={(event) => touchEvent("end", event)}
              onPointerCancel={(event) => touchEvent("cancel", event)}
              onKeyDown={(event) => {
                // Tab leaves the pixel surface; host browser shortcuts stay native.
                if (event.key === "Tab" || event.key === "Escape" || event.metaKey || event.ctrlKey || event.altKey) return;
                event.preventDefault();
                if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) void sendInput({ type: "type", text: event.key }).catch(() => undefined);
                else void sendInput({ type: "key", key: event.key }).catch(() => undefined);
              }}
              data-testid="opencode-live-browser-frame"
            />
            {streamError && (
              <div className="absolute inset-x-4 bottom-4 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-background-surface)] p-3 shadow-lg" role="status" data-testid="opencode-live-browser-stream-error">
                <p className="text-xs text-[var(--color-text-muted)]">The page stream disconnected. Your browser page is still preserved.</p>
                <Button size="sm" variant="secondary" className="mt-2" onClick={() => { setStreamError(false); setStreamKey((key) => key + 1); }}>Reconnect</Button>
              </div>
            )}
          </>
        ) : null}
      </div>

      <form
        className="hidden shrink-0 items-center gap-2 border-t border-[var(--color-border-default)] p-2 pointer-coarse:flex"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pageText) return;
          void sendInput({ type: "type", text: pageText }).then(() => setPageText("")).catch(() => undefined);
        }}
        data-testid="opencode-live-browser-mobile-type"
      >
        <input value={pageText} onChange={(event) => setPageText(event.target.value)} className="min-w-0 flex-1 rounded-md border border-[var(--color-border-default)] bg-transparent px-3 py-2 text-sm" placeholder="Type into the focused page field" aria-label="Text to type into page" />
        <Button size="sm" variant="secondary" disabled={!pageText}>Type</Button>
      </form>

      <footer className="shrink-0 border-t border-[var(--color-border-default)] px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-[10px] text-[var(--color-text-muted)]" aria-live="polite">
        {state?.loading ? "Loading…" : state?.title || (state ? "Ready — enter a URL to begin" : "Server-side Chromium")}
      </footer>
    </div>
  );
}
