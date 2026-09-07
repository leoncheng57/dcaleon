import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";

import { Button } from "../ds/button.js";

export interface OverflowMenuItem {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
  testId: string;
}

const ITEM_CLASS =
  "flex min-h-11 w-full items-center gap-2 rounded px-2 text-sm text-[var(--color-text-default)] " +
  "hover:bg-[var(--color-background-surface-neutral-muted)] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] " +
  "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";

/**
 * The shared "More session actions" disclosure both runtime islands use for
 * secondary header actions. Same a11y contract as the original OpenCode menu:
 * focus moves to the first item on open, Escape and outside pointerdown close,
 * and focus returns to the trigger on close so a follow-on dialog captures the
 * right activeElement.
 */
export function SessionOverflowMenu({ items, testIds, label = "More session actions" }: {
  items: OverflowMenuItem[];
  testIds: { root: string; trigger: string; panel: string };
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>("a, button:not([disabled])")?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  return (
    <div
      className="relative"
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        close();
      }}
      data-testid={testIds.root}
    >
      <Button
        size="md"
        variant="ghost"
        className="min-h-11 min-w-12 px-0"
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={label}
        onClick={() => (open ? close() : setOpen(true))}
        ref={triggerRef}
        title={label}
        type="button"
        data-testid={testIds.trigger}
      >
        <Ellipsis aria-hidden="true" className="h-3.5 w-3.5" />
      </Button>
      {open && (
        <div
          aria-label={label}
          className="absolute right-0 top-full z-50 mt-1 w-52 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-background-surface)] p-1 shadow-xl"
          id={panelId}
          ref={panelRef}
          data-testid={testIds.panel}
        >
          <ul>
            {items.map((item) => (
              <li key={item.id}>
                <button
                  className={ITEM_CLASS}
                  disabled={item.disabled}
                  title={item.title}
                  onClick={() => { close(); item.onSelect(); }}
                  type="button"
                  data-testid={item.testId}
                >
                  {item.icon}
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
