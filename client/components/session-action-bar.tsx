import type { ReactNode } from "react";

import { cn } from "../ds/utils.js";

export interface SessionActionBarProps {
  children: ReactNode;
  className?: string;
  testId?: string;
}

/** Shared action row used by every runtime's conversation header. */
export function SessionActionBar({ children, className, testId }: SessionActionBarProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center justify-end gap-1 sm:ml-auto sm:w-fit sm:flex-none",
        className,
      )}
      aria-label="Session actions"
      data-testid={testId}
    >
      {children}
    </div>
  );
}
