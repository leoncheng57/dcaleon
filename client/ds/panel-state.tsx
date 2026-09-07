import { forwardRef, type ReactNode } from "react";
import { CircleDashed, Inbox, MessageSquareText, WifiOff } from "lucide-react";
import { Badge } from "./badge.js";
import { cn } from "./utils.js";

export type PanelStateKind = "empty" | "loading" | "wip" | "disconnected";
export const PanelState = forwardRef<HTMLDivElement, {
  kind: PanelStateKind;
  title: string;
  description: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
  testId?: string;
}>(function PanelState({ kind, title, description, icon, action, className, testId }, ref) {
  const Icon = { empty: Inbox, loading: CircleDashed, wip: MessageSquareText, disconnected: WifiOff }[kind];
  return <div ref={ref} data-testid={testId} className={cn("flex min-h-0 flex-1 items-center justify-center p-6", className)}>
    <div className="max-w-sm text-center">
      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-[var(--color-border-default)] bg-[var(--color-background-surface-neutral-muted)]">
        {icon ?? <Icon size={22} aria-hidden="true" className={kind === "loading" ? "motion-safe:animate-spin" : undefined} />}
      </span>
      {kind === "wip" && <Badge className="mt-4">Work in progress</Badge>}
      <div role={kind === "loading" || kind === "disconnected" ? "status" : undefined}>
        <h2 className="mt-3 text-base font-semibold">{title}</h2>
        <p className="mt-2 text-sm leading-6 text-[var(--color-text-muted)]">{description}</p>
      </div>
      {action && <div className="mt-4">{action}</div>}
    </div>
  </div>;
});
