import { useEffect, useRef, useState } from "react";
import { FlaskConical, ListTodo, Moon, RefreshCw, Sparkles, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { Button } from "../ds/button.js";
import { CommandPalette } from "../ds/command-palette.js";
import { api, type SessionSummary } from "../lib/api.js";
import { formatBuildLabel } from "../lib/buildInfo.js";
import { useNotificationCenter } from "../lib/useNotificationCenter.js";
import {
  DIRECTORY_STORAGE_KEY,
  buildPaletteCommands,
  rankPaletteCommands,
  resolvePaletteDirectory,
  type PaletteCommand,
} from "../lib/palette.js";
import { selectPhoneUrl } from "../lib/phoneTransfer.js";
import { refreshApp } from "../lib/appRefresh.js";
import { PUBLIC_SIMULATOR } from "../lib/runtime.js";
import { useNotifyWatcher } from "../lib/useNotifyWatcher.js";
import { getDoc } from "../lib/docs.js";
import { NavOverflowMenu } from "./nav-overflow-menu.js";
import { NotificationPopover } from "./notification-popover.js";
import { PhoneTransferDialog } from "./phone-transfer-dialog.js";

const APP_NAME = "DCA";
const BUILD_LABEL = formatBuildLabel(__APP_VERSION__, __APP_COMMIT__);

function documentTitle(pathname: string): string {
  if (pathname === "/") return `Sessions | ${APP_NAME}`;
  if (pathname.startsWith("/sessions/")) return `Session | ${APP_NAME}`;
  if (pathname === "/settings") return `Settings | ${APP_NAME}`;
  if (pathname === "/settings/notifications") return `Notifications | ${APP_NAME}`;
  if (pathname === "/tools") return `MCPs | ${APP_NAME}`;
  if (pathname === "/docs") return `Docs | ${APP_NAME}`;
  if (pathname.startsWith("/docs/")) return `${getDoc(pathname.slice("/docs/".length))?.title ?? "Document"} | ${APP_NAME}`;
  if (pathname === "/planning") return `Planning | ${APP_NAME}`;
  if (pathname === "/observability") return `Observability | ${APP_NAME}`;
  if (pathname === "/dsh") return `DSH Lab | ${APP_NAME}`;
  if (pathname.startsWith("/dsh/sessions/")) return `DSH Session | ${APP_NAME}`;
  if (pathname === "/claude") return `Claude Lab | ${APP_NAME}`;
  if (pathname.startsWith("/claude/sessions/")) return `Claude Session | ${APP_NAME}`;
  if (pathname === "/playbooks") return `Playbooks | ${APP_NAME}`;
  if (pathname === "/playbooks/workflows") return `Workflows | Playbooks | ${APP_NAME}`;
  if (pathname.startsWith("/playbooks/workflows/")) return `Workflow | Playbooks | ${APP_NAME}`;
  return APP_NAME;
}

export function AppShell() {
  const { activeCount, refresh } = useNotificationCenter();
  useNotifyWatcher(refresh);
  const location = useLocation();
  const navigate = useNavigate();
  const { resolvedTheme, setTheme } = useTheme();
  const [phoneUrl, setPhoneUrl] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteSessions, setPaletteSessions] = useState<SessionSummary[]>([]);
  const [paletteStatus, setPaletteStatus] = useState<string | undefined>();
  const [refreshing, setRefreshing] = useState(false);
  const [dshEnabled, setDshEnabled] = useState(false);
  const [claudeEnabled, setClaudeEnabled] = useState(false);
  const paletteRequest = useRef(0);

  useEffect(() => {
    document.title = documentTitle(location.pathname);
  }, [location.pathname]);

  const directory = resolvePaletteDirectory(location.search, localStorage.getItem(DIRECTORY_STORAGE_KEY));
  const scopedPath = (path: string) =>
    directory ? `${path}?${new URLSearchParams({ directory })}` : path;

  useEffect(() => {
    void api.appConfig().then((config) => { setDshEnabled(config.dshEnabled); setClaudeEnabled(config.claudeEnabled); }).catch(() => undefined);
  }, []);

  const openPhoneTransfer = async () => {
    let configuredUrl: string | null = null;
    try {
      configuredUrl = (await api.appConfig()).publicAppUrl;
    } catch {
      // The browser origin is still useful when the optional config route is unavailable.
    }
    setPhoneUrl(selectPhoneUrl(configuredUrl, window.location.href));
  };

  const reloadApp = () => {
    if (refreshing) return;
    const beforeRefresh = new Event("opencode:before-app-refresh", { cancelable: true });
    if (!window.dispatchEvent(beforeRefresh) && !window.confirm("Discard your unsent message and refresh?")) return;
    setRefreshing(true);
    void refreshApp();
  };

  const closePalette = () => {
    paletteRequest.current += 1;
    setPaletteOpen(false);
  };

  const openPalette = () => {
    if (phoneUrl) return;
    const request = ++paletteRequest.current;
    setPaletteOpen(true);
    setPaletteQuery("");
    setPaletteSessions([]);
    if (!directory) {
      setPaletteStatus("Set a project directory to search conversations.");
      return;
    }

    setPaletteStatus("Loading conversations...");
    void api
      .sessions(directory, { limit: 100 })
      .then(({ sessions }) => {
        if (request !== paletteRequest.current) return;
        setPaletteSessions(sessions);
        setPaletteStatus(sessions.length ? undefined : "No conversations in this project.");
      })
      .catch(() => {
        if (request !== paletteRequest.current) return;
        setPaletteStatus("Conversation search unavailable; commands still work.");
      });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.altKey || event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) {
        return;
      }
      event.preventDefault();
      if (paletteOpen) closePalette();
      else openPalette();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  });

  const commands = buildPaletteCommands({
    navigation: [
      { id: "home", title: "Home", to: scopedPath("/"), keywords: ["sessions"] },
      { id: "tools", title: "MCPs", to: scopedPath("/tools"), keywords: ["mcp", "lsp", "permissions", "tools"] },
      { id: "docs", title: "Docs", to: scopedPath("/docs"), keywords: ["architecture", "contributing", "internals"] },
      {
        id: "notifications",
        title: "Notifications",
        to: scopedPath("/settings/notifications"),
        ...(activeCount > 0 ? { subtitle: `${activeCount} unresolved` } : {}),
      },
      { id: "settings", title: "Settings", to: scopedPath("/settings") },
      { id: "planning", title: "Planning", to: "/planning", keywords: ["issues", "pull requests", "roadmap", "github"] },
      { id: "observability", title: "Observability", to: "/observability", keywords: ["logs", "audit", "deployment", "health", "processes"] },
      ...(dshEnabled ? [{ id: "dsh", title: "DSH lab", to: "/dsh", keywords: ["deepseek", "harness", "experiment"] }] : []),
      ...(claudeEnabled ? [{ id: "claude", title: "Claude lab", to: "/claude", keywords: ["claude", "anthropic", "code", "binary"] }] : []),
      { id: "playbooks", title: "Playbooks", to: "/playbooks", keywords: ["workflows", "procedures"] },
    ],
    actions: [
      {
        id: "open-phone",
        title: "Open on phone",
        subtitle: "Show the phone transfer QR code",
        keywords: ["phone", "qr", "transfer"],
        run: () => void openPhoneTransfer(),
      },
      {
        id: "refresh-app",
        title: "Refresh app",
        subtitle: "Reload the current page and check for an app update",
        keywords: ["reload", "pwa", "update"],
        run: reloadApp,
      },
      ...(["system", "light", "dark"] as const).map((appearance) => ({
        id: `appearance-${appearance}`,
        title: `Use ${appearance[0].toUpperCase()}${appearance.slice(1)} appearance`,
        subtitle: appearance === "system" ? "Follow this device's color scheme" : `Always use ${appearance} mode`,
        keywords: ["appearance", "theme", "light", "dark", "system"],
        run: () => setTheme(appearance),
      })),
    ],
    sessions: paletteSessions,
  });
  const rankedCommands = rankPaletteCommands(commands, paletteQuery);

  const selectCommand = (command: PaletteCommand) => {
    closePalette();
    if (command.to) {
      navigate(command.to);
      return;
    }
    command.run?.();
  };

  return (
    <div className="h-full min-h-0">
      <div className="flex h-full min-h-0 flex-col" inert={paletteOpen ? true : undefined}>
        <nav className="flex h-11 shrink-0 items-center gap-1 border-b border-[var(--color-border-default)] px-3" aria-label="Main">
          <NavLink to={scopedPath("/")} className="text-sm font-bold tracking-tight" data-testid="opencode-nav-home">
            DCA
          </NavLink>
          <span
            className="invisible mr-auto w-0 truncate font-mono text-[10px] tabular-nums text-[var(--color-text-muted)] min-[480px]:visible min-[480px]:w-auto"
            data-testid="opencode-nav-version"
            title={`DCA ${BUILD_LABEL}`}
          >
            {BUILD_LABEL}
          </span>
          <Button
            aria-label="Refresh app"
            className="size-8 shrink-0 p-0 pointer-coarse:size-11"
            disabled={refreshing}
            size="sm"
            title="Refresh app"
            type="button"
            variant="ghost"
            onClick={reloadApp}
            data-testid="opencode-nav-refresh"
          >
            <RefreshCw aria-hidden="true" size={16} className={refreshing ? "animate-spin" : undefined} />
          </Button>
          <Button
            aria-label={`Use ${resolvedTheme === "dark" ? "light" : "dark"} appearance`}
            className="size-8 shrink-0 p-0 pointer-coarse:size-11"
            size="sm"
            title={`Use ${resolvedTheme === "dark" ? "light" : "dark"} appearance`}
            type="button"
            variant="ghost"
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            data-testid="opencode-nav-theme-toggle"
          >
            {resolvedTheme === "dark" ? <Sun aria-hidden="true" size={16} /> : <Moon aria-hidden="true" size={16} />}
          </Button>
          {dshEnabled && (
            <NavLink
              aria-label="DSH lab"
              className={({ isActive }) => `inline-flex size-8 shrink-0 items-center justify-center gap-1.5 rounded-md text-xs font-semibold pointer-coarse:size-11 sm:w-auto sm:px-2 ${isActive ? "bg-[var(--color-background-surface-info-muted)] text-[var(--color-text-info)]" : "text-[var(--color-text-action-ghost)] hover:bg-[var(--color-background-action-ghost-hover)]"}`}
              title="DSH lab"
              to="/dsh"
              data-testid="dsh-nav"
            >
              <FlaskConical aria-hidden="true" size={16} />
              <span className="hidden sm:inline">DSH</span>
            </NavLink>
          )}
          {claudeEnabled && (
            <NavLink
              aria-label="Claude lab"
              className={({ isActive }) => `inline-flex size-8 shrink-0 items-center justify-center gap-1.5 rounded-md text-xs font-semibold pointer-coarse:size-11 sm:w-auto sm:px-2 ${isActive ? "bg-[var(--color-background-surface-info-muted)] text-[var(--color-text-info)]" : "text-[var(--color-text-action-ghost)] hover:bg-[var(--color-background-action-ghost-hover)]"}`}
              title="Claude lab"
              to="/claude"
              data-testid="claude-nav"
            >
              <Sparkles aria-hidden="true" size={16} />
              <span className="hidden sm:inline">Claude</span>
            </NavLink>
          )}
          <NavLink
            aria-label="Planning"
            className={({ isActive }) => `inline-flex size-8 shrink-0 items-center justify-center gap-1.5 rounded-md text-xs font-semibold pointer-coarse:size-11 sm:w-auto sm:px-2 ${isActive ? "bg-[var(--color-background-surface-info-muted)] text-[var(--color-text-info)]" : "text-[var(--color-text-action-ghost)] hover:bg-[var(--color-background-action-ghost-hover)]"}`}
            title="Planning"
            to="/planning"
            data-testid="opencode-nav-planning"
          >
            <ListTodo aria-hidden="true" size={16} />
            <span className="hidden sm:inline">Planning</span>
          </NavLink>
          <NotificationPopover scopedPath={scopedPath} />
          <NavOverflowMenu
            scopedPath={scopedPath}
            onOpenPalette={openPalette}
            onOpenPhoneTransfer={() => void openPhoneTransfer()}
          />
        </nav>
        {PUBLIC_SIMULATOR && (
          <div
            className="shrink-0 border-b border-[var(--color-border-default)] bg-[var(--color-background-surface-info-muted)] px-3 py-1.5 text-center text-xs text-[var(--color-text-info)]"
            data-testid="opencode-public-simulator-banner"
            role="status"
          >
            PR simulator: fixture data only. Actions stay in this tab, use no credentials, and reset on reload.
          </div>
        )}
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </div>
      <CommandPalette
        open={paletteOpen}
        commands={rankedCommands}
        query={paletteQuery}
        status={paletteStatus}
        onClose={closePalette}
        onQueryChange={setPaletteQuery}
        onSelect={selectCommand}
      />
      {phoneUrl && <PhoneTransferDialog targetUrl={phoneUrl} onClose={() => setPhoneUrl(null)} />}
    </div>
  );
}
