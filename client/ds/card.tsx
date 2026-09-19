import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "./utils.js";

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        // Raised, not the page field: on the warm paper background a card that
        // shares the field's colour is separated by its shadow alone, which is
        // the weakest cue the theme has. Raised lifts it toward white in light
        // mode and away from black in dark, so the shadow reinforces an edge
        // that already reads.
        "rounded-[var(--border-radius-12)] bg-[var(--color-background-surface-raised)] has-shadow-default",
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex flex-col space-y-1.5 p-6", className)} {...props} />
  ),
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn("text-lg font-semibold leading-none tracking-tight", className)}
      {...props}
    />
  ),
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn("text-sm text-[var(--color-text-muted)]", className)} {...props} />
));
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
  ),
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex items-center p-6 pt-0", className)} {...props} />
  ),
);
CardFooter.displayName = "CardFooter";

/** A Card that wraps its content in a <details> element so it can be collapsed. */
function CollapsibleCard({
  title,
  defaultOpen = true,
  className,
  headerRight,
  children,
}: {
  title: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className={className}>
      <details className="group" open={defaultOpen || undefined}>
        <summary className="flex cursor-pointer list-none items-center justify-between p-4 text-sm font-semibold transition-colors hover:bg-[var(--color-background-action-ghost-hover)] rounded-[var(--border-radius-12)]">
          <span className="flex items-center gap-2">{title}</span>
          <span className="flex items-center gap-2">
            {headerRight}
            <span
              aria-hidden="true"
              className="flex h-6 w-6 items-center justify-center rounded-full text-[var(--color-text-muted)] transition-all duration-200 ease-out group-open:rotate-180 group-hover:bg-[var(--color-background-action-ghost-hover)] group-hover:text-[var(--color-text-default)]"
            >
              <ChevronDown className="h-4 w-4" strokeWidth={2} />
            </span>
          </span>
        </summary>
        <div className="border-t border-[var(--color-border-default)] p-4 pt-3">
          {children}
        </div>
      </details>
    </Card>
  );
}

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent, CollapsibleCard };
