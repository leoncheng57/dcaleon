import { useEffect, useId, useRef, useState } from "react";
import { Activity, BookOpen, LibraryBig, MoreHorizontal, Search, Settings, Smartphone, Wrench } from "lucide-react";
import { NavLink } from "react-router-dom";

import { Button } from "../ds/button.js";
import { cn } from "../ds/utils.js";

const ITEM_CLASS =
  "flex min-h-11 w-full items-center gap-2 rounded px-2 text-sm text-[var(--color-text-default)] " +
  "hover:bg-[var(--color-background-surface-neutral-muted)] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]";

// The route is still /tools; only the label changed. "MCPs" is what the page
// itself is about — its own heading already reads "MCP tools" — and "Tools"
// collided with the agent tool catalogue elsewhere in the app.
const LINKS = [
  { to: "/docs", label: "Docs", testId: "opencode-nav-docs", Icon: BookOpen },
  { to: "/tools", label: "MCPs", testId: "opencode-nav-tools", Icon: Wrench },
  { to: "/settings", label: "Settings", testId: "opencode-nav-settings", Icon: Settings },
] as const;

// Host-scoped, so unlike LINKS above it is never given a ?directory=.
const UNSCOPED_LINKS = [
  { to: "/playbooks", label: "Playbooks", testId: "opencode-nav-playbooks", Icon: LibraryBig },
  { to: "/observability", label: "Observability", testId: "opencode-nav-observability", Icon: Activity },
] as const;

/**
 * Secondary navigation. These destinations stay reachable — and stay in the
 * command palette unchanged — but they no longer compete with the brand,
 * the primary destinations and the notification centre for the top bar.
 *
 * Search moved in here from the bar. It keeps working on Cmd/Ctrl+K, which is
 * how it is actually reached; the bar button was a discoverability affordance
 * for a shortcut, and it was outbidding a real destination for that space.
 *
 * Deliberately a disclosure over a list of links, not an APG menu button:
 * three of the five entries are navigation and were announced as links before
 * this menu existed. role="menuitem" would drop them out of the links list
 * assistive tech offers, and swap Tab for an arrow-key model nobody expects
 * from nav. The menu pattern is for commands.
 */
export function NavOverflowMenu({
  scopedPath,
  onOpenPalette,
  onOpenPhoneTransfer,
}: {
  scopedPath: (path: string) => string;
  onOpenPalette: () => void;
  onOpenPhoneTransfer: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>("a, button")?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  return (
    <div
      className="relative"
      ref={wrapperRef}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        close();
      }}
    >
      <Button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="More navigation"
        className="gap-1.5 px-2 pointer-coarse:min-h-11"
        onClick={() => (open ? close() : setOpen(true))}
        ref={triggerRef}
        size="sm"
        title="More navigation"
        type="button"
        variant="ghost"
        data-testid="opencode-nav-more"
      >
        <MoreHorizontal aria-hidden="true" size={16} />
        <span className="hidden sm:inline">More</span>
      </Button>
      {open && (
        <div
          aria-label="More navigation"
          className="absolute right-0 top-full z-50 mt-1 w-52 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-background-surface)] p-1 shadow-xl"
          id={panelId}
          ref={panelRef}
          data-testid="opencode-nav-more-menu"
        >
          <ul>
            <li>
              <button
                className={ITEM_CLASS}
                // Restores focus, unlike the entries below: the palette
                // captures `document.activeElement` when it mounts and returns
                // focus there on close. Closing without restoring would hand it
                // `<body>`, so dismissing the palette would drop focus entirely.
                onClick={() => {
                  close();
                  onOpenPalette();
                }}
                type="button"
                data-testid="opencode-palette-open"
              >
                <Search aria-hidden="true" size={15} />
                Search
                {/* The shortcut still works globally, but the trigger no longer
                    sits on the bar carrying aria-keyshortcuts, so name it here. */}
                <span className="ml-auto text-xs text-[var(--color-text-muted)]">⌘K</span>
              </button>
            </li>
            <li>
              <button
                className={ITEM_CLASS}
                onClick={() => {
                  close(false);
                  onOpenPhoneTransfer();
                }}
                type="button"
                data-testid="opencode-phone-transfer-open"
              >
                <Smartphone aria-hidden="true" size={15} />
                Phone
              </button>
            </li>
            {LINKS.map(({ to, label, testId, Icon }) => (
              <li key={to}>
                <NavLink
                  className={({ isActive }) => cn(ITEM_CLASS, isActive && "bg-[var(--color-background-surface-neutral-muted)] font-semibold")}
                  onClick={() => close(false)}
                  to={scopedPath(to)}
                  data-testid={testId}
                >
                  <Icon aria-hidden="true" size={15} />
                  {label}
                </NavLink>
              </li>
            ))}
            {UNSCOPED_LINKS.map(({ to, label, testId, Icon }) => (
              <li key={to}>
                <NavLink
                  className={({ isActive }) => cn(ITEM_CLASS, isActive && "bg-[var(--color-background-surface-neutral-muted)] font-semibold")}
                  onClick={() => close(false)}
                  to={to}
                  data-testid={testId}
                >
                  <Icon aria-hidden="true" size={15} />
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
