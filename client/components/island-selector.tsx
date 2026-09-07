import { useEffect, useRef, useState } from "react";
import { FlaskConical, Sparkles, Terminal, type LucideIcon } from "lucide-react";
import { Link, useLocation } from "react-router-dom";

import { Badge } from "../ds/badge.js";
import { Button } from "../ds/button.js";
import { cn } from "../ds/utils.js";

interface IslandDef {
  id: "opencode" | "dsh" | "claude";
  label: string;
  description: string;
  traits: string[];
  icon: LucideIcon;
  path: string;
  pathPrefix: string;
}

export const ISLANDS: IslandDef[] = [
  {
    id: "opencode",
    label: "OpenCode",
    description: "The core runtime. Proxies a long-lived OpenCode server with full API-key model access.",
    traits: [
      "Models: Any provider (Anthropic, OpenAI, Google, etc.)",
      "Auth: API key — you control the key and billing",
      "Features: Subagents, managed children, todos, live browser, full inspector",
      "Sandbox: Docker container isolation",
      "Best for: Multi-model workflows, full feature set, team API keys",
    ],
    icon: Terminal,
    path: "/opencode",
    pathPrefix: "/opencode",
  },
  {
    id: "dsh",
    label: "DSH",
    description: "Experimental runtime for DeepSeek models with persistent bridge and sandbox confinement.",
    traits: [
      "Models: DeepSeek only (R1, Coder, Chat)",
      "Auth: DeepSeek API key",
      "Features: Trajectory viewer, native reasoning traces",
      "Sandbox: Confined Build presets",
      "Best for: DeepSeek-specific tasks, reasoning model experiments",
    ],
    icon: FlaskConical,
    path: "/dsh",
    pathPrefix: "/dsh",
  },
  {
    id: "claude",
    label: "Claude",
    description: "Drives the unmodified Claude CLI binary on your subscription seat — no API key needed.",
    traits: [
      "Models: Anthropic only (Opus, Sonnet, Haiku, Fable)",
      "Auth: Claude subscription seat (Keychain sign-in, no API key)",
      "Features: Worktree isolation, usage limits, playbooks, notifications",
      "Sandbox: macOS Seatbelt (deny-default, workspace-confined writes)",
      "Best for: Using your Claude Pro/Team subscription for coding tasks",
    ],
    icon: Sparkles,
    path: "/claude",
    pathPrefix: "/claude",
  },
];

function activeIsland(pathname: string): IslandDef {
  if (pathname.startsWith("/claude")) return ISLANDS[2];
  if (pathname.startsWith("/dsh")) return ISLANDS[1];
  return ISLANDS[0];
}

function isAvailable(island: IslandDef, props: IslandSelectorProps): boolean {
  if (island.id === "opencode") return true;
  if (island.id === "dsh") return props.dshEnabled && props.dshConfigured;
  return props.claudeEnabled && props.claudeConfigured;
}

export interface IslandSelectorProps {
  dshEnabled: boolean;
  dshConfigured: boolean;
  claudeEnabled: boolean;
  claudeConfigured: boolean;
  scopedPath: (path: string) => string;
}

export function IslandSelector(props: IslandSelectorProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const current = activeIsland(location.pathname);
  const ActiveIcon = current.icon;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrapperRef}>
      <Button
        aria-label="Switch runtime"
        aria-expanded={open}
        aria-haspopup="dialog"
        className="size-8 shrink-0 p-0 pointer-coarse:size-11"
        size="sm"
        variant="ghost"
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="island-selector-trigger"
      >
        <ActiveIcon aria-hidden="true" size={16} />
      </Button>

      {open && (
        <div
          className="fixed inset-x-2 top-12 z-50 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-background-surface)] shadow-xl sm:absolute sm:inset-x-auto sm:left-0 sm:top-full sm:mt-1 sm:w-96"
          role="dialog"
          aria-label="Switch runtime"
          data-testid="island-selector-panel"
        >
          <div className="border-b border-[var(--color-border-default)] px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Runtime Islands</span>
          </div>
          <div className="p-1.5">
            {ISLANDS.map((island) => {
              const Icon = island.icon;
              const available = isAvailable(island, props);
              const active = island.id === current.id;
              const to = island.id === "opencode" ? props.scopedPath(island.path) : island.path;
              return (
                <Link
                  key={island.id}
                  to={to}
                  className={cn(
                    "flex items-start gap-3 rounded-lg p-3 transition-colors",
                    "hover:bg-[var(--color-background-surface-neutral-muted)]",
                    active && "bg-[var(--color-background-surface-info-muted)]",
                  )}
                  onClick={() => setOpen(false)}
                  data-testid={`island-selector-${island.id}`}
                >
                  <Icon aria-hidden="true" size={20} className="mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-[var(--color-text-default)]">{island.label}</span>
                      <Badge variant={available ? "success" : "neutral"} className="text-[10px]">
                        {available ? "Available" : "Not configured"}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-text-muted)]">{island.description}</p>
                    <ul className="mt-1.5 space-y-0.5">
                      {island.traits.map((trait) => {
                        const colon = trait.indexOf(":");
                        const key = colon > 0 ? trait.slice(0, colon) : undefined;
                        const value = colon > 0 ? trait.slice(colon + 1).trim() : trait;
                        return (
                          <li key={trait} className="text-[10px] leading-relaxed text-[var(--color-text-muted)]">
                            {key ? <><span className="font-medium text-[var(--color-text-default)]">{key}:</span> {value}</> : value}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
