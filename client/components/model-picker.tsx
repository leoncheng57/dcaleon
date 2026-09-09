import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AlertTriangle, Check, ChevronDown, Pin, Search, X } from "lucide-react";
import { createPortal } from "react-dom";

import { api } from "../lib/api.js";
import type { ModelCatalogue, ModelSelection, PublicModel } from "../lib/models.js";
import { groupedModels, modelKey, modelLabel, sameModelID } from "../lib/models.js";

function unavailable(model: PublicModel): boolean {
  return model.status === "disabled" || model.status === "unavailable";
}

function matches(model: PublicModel, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || `${model.name} ${model.modelID} ${model.providerName} ${model.providerID}`.toLowerCase().includes(needle);
}

export function ModelPicker({
  catalogue,
  value,
  onChange,
  testId,
  label = "Model",
  disabled = false,
  midConversation = false,
  portalLayer = "default",
}: {
  catalogue: ModelCatalogue | null;
  value?: ModelSelection;
  onChange: (model: ModelSelection) => void;
  testId: string;
  label?: string;
  disabled?: boolean;
  /** Show a warning about cache invalidation when switching models mid-conversation. */
  midConversation?: boolean;
  /** Nested dialogs render above their owning modal instead of behind it. */
  portalLayer?: "default" | "nested";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pins, setPins] = useState<ModelSelection[]>([]);
  const [pinError, setPinError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const details = catalogue?.models.find((model) => sameModelID(model, value));
  const portalZIndex = portalLayer === "nested" ? "z-[100]" : "z-[90]";
  const pinKeys = useMemo(() => new Set(pins.map(modelKey)), [pins]);

  useEffect(() => {
    let cancelled = false;
    void api.modelPins().then(({ models }) => {
      if (!cancelled) setPins(models);
    }).catch((error: Error) => {
      if (!cancelled) setPinError(error.message);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    const parentDialog = portalLayer === "nested"
      ? triggerRef.current?.closest<HTMLElement>('[role="dialog"][aria-modal="true"]') ?? null
      : null;
    const parentWasInert = parentDialog?.inert ?? false;
    const parentAriaHidden = parentDialog ? parentDialog.getAttribute("aria-hidden") : null;
    document.body.style.overflow = "hidden";
    if (parentDialog) {
      parentDialog.inert = true;
      parentDialog.setAttribute("aria-hidden", "true");
    }
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      document.body.style.overflow = overflow;
      if (parentDialog) {
        parentDialog.inert = parentWasInert;
        if (parentAriaHidden === null) parentDialog.removeAttribute("aria-hidden");
        else parentDialog.setAttribute("aria-hidden", parentAriaHidden);
      }
      if (previous?.isConnected) previous.focus();
    };
  }, [open, portalLayer]);

  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ) ?? [])].filter((element) => !element.hidden);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
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

  const visiblePinned = pins
    .map((pin) => catalogue?.models.find((model) => sameModelID(model, pin)))
    .filter((model): model is PublicModel => Boolean(model && matches(model, query)));
  const groups = catalogue ? groupedModels(catalogue)
    .map((group) => ({ ...group, models: group.models.filter((model) => !pinKeys.has(modelKey(model)) && matches(model, query)) }))
    .filter((group) => group.models.length > 0) : [];

  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const select = (model: PublicModel) => {
    if (unavailable(model)) return;
    onChange({ providerID: model.providerID, modelID: model.modelID });
    close();
  };
  const togglePin = async (model: PublicModel) => {
    const key = modelKey(model);
    const next = pinKeys.has(key)
      ? pins.filter((pin) => modelKey(pin) !== key)
      : [...pins, { providerID: model.providerID, modelID: model.modelID }];
    setPins(next);
    setPinError(null);
    try {
      setPins((await api.saveModelPins(next)).models);
    } catch (error) {
      setPins(pins);
      setPinError(error instanceof Error ? error.message : String(error));
    }
  };

  const modelRow = (model: PublicModel, pinned: boolean) => {
    const selected = sameModelID(model, value);
    const blocked = unavailable(model);
    return <div className="flex min-w-0 items-stretch gap-1 rounded-lg hover:bg-[var(--hh-row-hover)]" key={modelKey(model)} data-testid={`${testId}-option`} data-model-key={modelKey(model)}>
      <button
        type="button"
        className="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-45"
        disabled={blocked}
        onClick={() => select(model)}
        role="option"
        aria-selected={selected}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-[var(--color-text-default)]">{model.name}</span>
          <span className="block truncate text-[11px] text-[var(--color-text-muted)]">{model.providerName} · {model.modelID}{model.status !== "available" ? ` · ${model.status}` : ""}</span>
        </span>
        {selected && <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--color-text-info)]" />}
      </button>
      <button
        type="button"
        className="m-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-background-action-ghost-hover)] hover:text-[var(--color-text-default)]"
        aria-label={`${pinned ? "Unpin" : "Pin"} ${model.name}`}
        aria-pressed={pinned}
        onClick={() => void togglePin(model)}
        data-testid={`${testId}-pin`}
      >
        <Pin aria-hidden="true" className="h-4 w-4" fill={pinned ? "currentColor" : "none"} />
      </button>
    </div>;
  };

  return <div className="min-w-0 flex-1 sm:flex-initial">
    <button
      ref={triggerRef}
      type="button"
      disabled={disabled || !catalogue}
      onClick={() => setOpen(true)}
      className="flex min-h-10 w-full min-w-0 max-w-full items-center gap-2 rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-surface)] px-3 text-left text-sm text-[var(--color-text-default)] disabled:opacity-50 sm:w-auto sm:max-w-80"
      data-testid={testId}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      value={value ? modelKey(value) : ""}
    >
      <span className="min-w-0 flex-1 truncate">{details ? details.name : value ? `${value.providerID}/${value.modelID} [unknown]` : catalogue ? "Select a model" : disabled ? "Select a project first" : "Loading models..."}{value?.variant ? ` · ${value.variant}` : ""}</span>
      <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
    </button>
    {open && createPortal(
      <div className={`fixed inset-0 ${portalZIndex} flex items-end justify-center sm:items-start sm:p-4 sm:pt-[10vh]`} data-testid={`${testId}-panel`}>
        <button type="button" aria-label="Close model picker" className="absolute inset-0 bg-[var(--color-background-overlay)]" onClick={close} />
        <div ref={dialogRef} className="relative flex max-h-[82dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-[var(--color-border-default)] bg-[var(--color-background-surface)] shadow-xl sm:max-h-[72vh] sm:max-w-xl sm:rounded-xl" role="dialog" aria-modal="true" aria-label={`${label} picker`} onKeyDown={onDialogKeyDown}>
          <div className="flex items-center gap-2 border-b border-[var(--color-border-default)] p-3">
            <div className="relative min-w-0 flex-1">
              <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models" className="h-11 w-full rounded-md border border-[var(--color-border-default)] bg-transparent pl-9 pr-3 text-base sm:h-9 sm:text-sm" data-testid={`${testId}-search`} />
            </div>
            <button type="button" onClick={close} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-[var(--hh-row-hover)] sm:h-9 sm:w-9" aria-label="Close model picker"><X aria-hidden="true" className="h-4 w-4" /></button>
          </div>
          {details && details.variants.length > 0 && <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border-default)] px-3 py-2" data-testid={`${testId}-variants`}>
            <span className="mr-1 text-xs font-medium text-[var(--color-text-muted)]">Variant</span>
            {["", ...details.variants].map((variant) => <button key={variant || "default"} type="button" className={`min-h-9 rounded-md px-3 text-xs font-semibold ${value?.variant === (variant || undefined) ? "bg-[var(--color-background-surface-info-muted)] text-[var(--color-text-info)]" : "bg-[var(--color-background-surface-neutral-muted)]"}`} onClick={() => { if (value) onChange({ ...value, variant: variant || undefined }); close(); }} data-testid={`${testId}-variant`} data-variant={variant}>{variant || "Default"}</button>)}
          </div>}
          {midConversation && (
            <div className="flex items-start gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-background-surface-warning-muted)] px-3 py-2 text-xs text-[var(--color-text-warning)]" role="note">
              <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>Switching models mid-conversation may increase latency and reduce efficiency. The new model won't benefit from the prior conversation's prompt cache.</span>
            </div>
          )}
          <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-2" role="listbox">
            {visiblePinned.length > 0 && <section data-testid={`${testId}-pinned-group`}>
              <h2 className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Pinned</h2>
              {visiblePinned.map((model) => modelRow(model, true))}
            </section>}
            {groups.map((group) => <section key={group.providerID}>
              <h2 className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{group.providerName}</h2>
              {group.models.map((model) => modelRow(model, false))}
            </section>)}
            {catalogue && visiblePinned.length === 0 && groups.length === 0 && <p className="px-3 py-10 text-center text-sm text-[var(--color-text-muted)]">No matching models</p>}
          </div>
          {pinError && <p className="border-t border-[var(--color-border-default)] px-3 py-2 text-xs text-[var(--color-text-danger)]" role="alert">Could not save model pins: {pinError}</p>}
        </div>
      </div>,
      document.body,
    )}
  </div>;
}
