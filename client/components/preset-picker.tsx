import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { createPortal } from "react-dom";

import type { DshPresetSummary } from "../lib/api.js";

function matches(preset: DshPresetSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || `${preset.label} ${preset.mode} ${preset.id}`.toLowerCase().includes(needle);
}

export function PresetPicker({
  presets,
  value,
  onChange,
  testId,
  label = "Model preset",
  disabled = false,
}: {
  presets: DshPresetSummary[];
  value: string;
  onChange: (presetId: string) => void;
  testId: string;
  label?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const selected = presets.find((p) => p.id === value);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ) ?? [])].filter((el) => !el.hidden);
    if (focusable.length === 0) { event.preventDefault(); return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const filtered = presets.filter((p) => matches(p, query));

  const close = () => { setOpen(false); setQuery(""); };
  const select = (preset: DshPresetSummary) => { onChange(preset.id); close(); };

  const modeLabel = (mode: string) => mode === "build" ? "Build" : "Read-only";

  return <div className="min-w-0 flex-1 sm:flex-initial">
    <button
      ref={triggerRef}
      type="button"
      disabled={disabled}
      onClick={() => setOpen(true)}
      className="flex min-h-11 w-full min-w-0 max-w-full items-center gap-2 rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-surface)] px-3 text-left text-sm text-[var(--color-text-default)] disabled:opacity-50 sm:max-w-80"
      data-testid={testId}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
    >
      <span className="min-w-0 flex-1 truncate">{selected ? selected.label : "Select a preset"}</span>
      <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
    </button>
    {open && createPortal(
      <div className="fixed inset-0 z-[90] flex items-end justify-center sm:items-start sm:p-4 sm:pt-[10vh]" data-testid={`${testId}-panel`}>
        <button type="button" aria-label="Close preset picker" className="absolute inset-0 bg-[var(--color-background-overlay)]" onClick={close} />
        <div ref={dialogRef} className="relative flex max-h-[82dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-[var(--color-border-default)] bg-[var(--color-background-surface)] shadow-xl sm:max-h-[72vh] sm:max-w-xl sm:rounded-xl" role="dialog" aria-modal="true" aria-label={`${label} picker`} onKeyDown={onDialogKeyDown}>
          <div className="flex items-center gap-2 border-b border-[var(--color-border-default)] p-3">
            <div className="relative min-w-0 flex-1">
              <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <input ref={searchRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search presets" className="h-11 w-full rounded-md border border-[var(--color-border-default)] bg-transparent pl-9 pr-3 text-base sm:h-9 sm:text-sm" data-testid={`${testId}-search`} />
            </div>
            <button type="button" onClick={close} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-[var(--hh-row-hover)] sm:h-9 sm:w-9" aria-label="Close preset picker"><X aria-hidden="true" className="h-4 w-4" /></button>
          </div>
          <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-2" role="listbox">
            {filtered.map((preset) => {
              const isSelected = preset.id === value;
              return <button
                key={preset.id}
                type="button"
                className="flex min-h-12 w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-[var(--hh-row-hover)]"
                onClick={() => select(preset)}
                role="option"
                aria-selected={isSelected}
                data-testid={`${testId}-option`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[var(--color-text-default)]">{preset.label}</span>
                  <span className="block truncate text-[11px] text-[var(--color-text-muted)]">{modeLabel(preset.mode)}</span>
                </span>
                {isSelected && <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--color-text-info)]" />}
              </button>;
            })}
            {filtered.length === 0 && <p className="px-3 py-10 text-center text-sm text-[var(--color-text-muted)]">No matching presets</p>}
          </div>
        </div>
      </div>,
      document.body,
    )}
  </div>;
}
