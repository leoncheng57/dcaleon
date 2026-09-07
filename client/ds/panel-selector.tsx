import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Badge } from "./badge.js";
import { Button } from "./button.js";

export interface PanelOption<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
  wip?: boolean;
  testId?: string;
}

/** Button disclosure with ordinary Tab order; Escape/selection restores the trigger. */
export function PanelSelector<T extends string>({ options, value, onChange, testId, menuTestId }: {
  options: readonly PanelOption<T>[];
  value: T;
  onChange: (value: T) => void;
  testId: string;
  menuTestId?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const active = options.find((option) => option.id === value);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return (
    <div ref={root} className="relative" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }} onKeyDown={(event) => {
      if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); }
    }}>
      <Button ref={trigger} variant="ghost" size="sm" type="button" className="min-h-11 gap-2 px-2"
        aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)} data-testid={testId}>
        {active?.icon}{active?.label}{active?.wip && <Badge>WIP</Badge>}<ChevronDown size={14} aria-hidden="true" />
      </Button>
      {open && <div id={id} role="group" aria-label="Choose tools panel" data-testid={menuTestId ?? `${testId}-menu`}
        className="absolute left-0 top-full z-20 mt-1 w-56 max-w-[calc(100vw-2rem)] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-background-surface)] p-1 shadow-xl">
        {options.map((option) => <button key={option.id} type="button" aria-pressed={value === option.id}
          className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-[var(--color-background-surface-neutral-muted)] focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          onClick={() => { onChange(option.id); close(); }} data-testid={option.testId ?? `${testId}-${option.id}`}>
          {option.icon}<span className="flex-1">{option.label}</span>{option.wip && <Badge>Work in progress</Badge>}
        </button>)}
      </div>}
    </div>
  );
}
