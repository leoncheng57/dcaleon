import * as React from "react";
import { createPortal } from "react-dom";

import type { PaletteCommand } from "../lib/palette.js";
import { cn } from "./utils.js";

interface CommandPaletteProps {
  open: boolean;
  commands: PaletteCommand[];
  query: string;
  status?: string;
  onClose: () => void;
  onQueryChange: (query: string) => void;
  onSelect: (command: PaletteCommand) => void;
}

const LISTBOX_ID = "opencode-palette-listbox";

const CommandPalette = React.forwardRef<HTMLInputElement, CommandPaletteProps>(
  ({ open, commands, query, status, onClose, onQueryChange, onSelect }, forwardedRef) => {
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    const listRef = React.useRef<HTMLDivElement | null>(null);
    const [active, setActive] = React.useState(0);

    React.useImperativeHandle(forwardedRef, () => inputRef.current as HTMLInputElement, []);

    React.useEffect(() => setActive(0), [open, query, commands.length]);

    React.useEffect(() => {
      if (!open) return;
      const previous = document.activeElement as HTMLElement | null;
      const overflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      inputRef.current?.focus();
      return () => {
        document.body.style.overflow = overflow;
        if (previous?.isConnected) previous.focus();
      };
    }, [open]);

    React.useEffect(() => {
      if (!open) return;
      listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
    }, [active, commands, open]);

    if (!open) return null;
    const activeCommand = commands[active];
    const move = (delta: number) => {
      if (commands.length) setActive((index) => (index + delta + commands.length) % commands.length);
    };
    const onKeyDown = (event: React.KeyboardEvent) => {
      switch (event.key) {
        case "Escape": event.preventDefault(); onClose(); break;
        case "ArrowDown": event.preventDefault(); move(1); break;
        case "ArrowUp": event.preventDefault(); move(-1); break;
        case "Home": event.preventDefault(); setActive(0); break;
        case "End": event.preventDefault(); setActive(Math.max(0, commands.length - 1)); break;
        case "Enter": event.preventDefault(); if (activeCommand) onSelect(activeCommand); break;
        case "Tab": event.preventDefault(); inputRef.current?.focus(); break;
      }
    };

    return createPortal(
      <div className="fixed inset-0 z-[80] flex items-start justify-center p-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:p-4 sm:pt-[12vh]" data-testid="opencode-command-palette">
        <div aria-hidden="true" className="absolute inset-0 bg-[var(--color-background-overlay)]" data-testid="opencode-palette-backdrop" onPointerDown={onClose} />
        <div aria-label="Command palette" aria-modal="true" className="relative flex max-h-[calc(100dvh-1rem)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-background-surface-raised)] shadow-xl sm:max-h-[70vh]" onKeyDown={onKeyDown} role="dialog">
          <input aria-activedescendant={activeCommand?.id} aria-autocomplete="list" aria-controls={LISTBOX_ID} aria-expanded="true" aria-label="Search commands and conversations" autoComplete="off" className="w-full shrink-0 border-b border-[var(--color-border-default)] bg-transparent px-4 py-3 text-base text-[var(--color-text-default)] outline-none placeholder:text-[var(--color-text-muted)] sm:text-sm" data-testid="opencode-palette-input" onChange={(event) => onQueryChange(event.target.value)} placeholder="Search commands and conversations" ref={inputRef} role="combobox" type="search" value={query} />
          <div aria-busy={status === "Loading conversations..."} aria-label="Commands" className="min-h-0 flex-1 overflow-y-auto p-1" id={LISTBOX_ID} ref={listRef} role="listbox">
            {commands.length ? commands.map((command, index) => (
              <div aria-selected={index === active} className={cn("flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 py-2", index === active && "bg-[var(--color-background-surface-neutral-muted)]")} data-active={index === active} data-kind={command.kind} data-testid="opencode-palette-option" id={command.id} key={command.id} onClick={() => onSelect(command)} onMouseMove={() => setActive(index)} role="option">
                <span className="min-w-0 flex-1"><span className="block truncate text-sm text-[var(--color-text-default)]">{command.title}</span>{command.subtitle && <span className="block truncate text-xs text-[var(--color-text-muted)]">{command.subtitle}</span>}</span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{command.group}</span>
              </div>
            )) : <p className="px-3 py-8 text-center text-sm text-[var(--color-text-muted)]" data-testid="opencode-palette-empty">No matching commands</p>}
          </div>
          <div aria-live="polite" className="shrink-0 border-t border-[var(--color-border-default)] px-4 py-2 text-[11px] text-[var(--color-text-muted)]" data-testid="opencode-palette-status" role="status">{status ?? "Up/Down to navigate - Enter to open - Esc to close"}</div>
        </div>
      </div>,
      document.body,
    );
  },
);
CommandPalette.displayName = "CommandPalette";

export { CommandPalette };
