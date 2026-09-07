import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "./button.js";
import { cn } from "./utils.js";

export interface ResponsivePanelProps {
  label: string;
  header: ReactNode;
  subtitle?: string;
  width?: "wide" | "standard";
  onClose: () => void;
  children: ReactNode;
  testId: string;
  closeTestId?: string;
  destination?: string;
}

/** In-flow desktop slot; full-screen modal below lg. Mount only while open. */
export const ResponsivePanel = forwardRef<HTMLElement, ResponsivePanelProps>(function ResponsivePanel(
  { label, header, subtitle, width = "standard", onClose, children, testId, closeTestId, destination }, ref,
) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useImperativeHandle(ref, () => panelRef.current!);
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 1023px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  useEffect(() => {
    if (!narrow) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [narrow]);
  return (
    <section ref={panelRef} tabIndex={-1} role={narrow ? "dialog" : "complementary"}
      aria-modal={narrow || undefined} aria-label={label} data-testid={testId} data-destination={destination}
      onKeyDown={(event) => {
        if (event.defaultPrevented) return;
        if (event.key === "Escape") {
          event.stopPropagation();
          closeRef.current();
        }
        if (!narrow || event.key !== "Tab") return;
        const panel = panelRef.current!;
        const elements = [...panel.querySelectorAll<HTMLElement>(
          "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
        )].filter((element) => element.getClientRects().length > 0);
        const first = elements[0];
        const last = elements.at(-1);
        const current = document.activeElement;
        if (!first || (event.shiftKey && (current === first || current === panel)) || (!event.shiftKey && current === last)) {
          event.preventDefault();
          (event.shiftKey ? last ?? panel : first ?? panel).focus();
        }
      }}
      className={cn("ds-panel-motion fixed inset-0 z-[70] flex min-w-0 flex-col overflow-hidden bg-[var(--color-background-surface)] outline-none lg:static lg:z-auto lg:h-full lg:shrink-0 lg:border-l lg:border-[var(--color-border-default)]",
        width === "wide" ? "lg:w-[42rem]" : "lg:w-[28rem]")}
    >
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-[var(--color-border-default)] px-2 pt-[env(safe-area-inset-top)] lg:pt-0">
        {header}
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-muted)]">{subtitle}</span>
        <Button size="sm" variant="ghost" type="button" className="min-w-11 px-0" aria-label="Close tools panel"
          onClick={onClose} data-testid={closeTestId ?? `${testId}-close`}><X aria-hidden="true" size={16} /></Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col pb-[env(safe-area-inset-bottom)] lg:pb-0">{children}</div>
    </section>
  );
});
