import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { Globe2 } from "lucide-react";

export const TranscriptBrowserContext = createContext<((url: string) => void) | null>(null);

/** Only explicit web URLs enter the browser; file/mail/app links retain their semantics. */
export function transcriptBrowserUrl(href: string): string | null {
  if (!/^https?:\/\//i.test(href.trim())) return null;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}

export function TranscriptLink({ href = "", children, ...props }: ComponentProps<"a"> & { children?: ReactNode }) {
  const open = useContext(TranscriptBrowserContext);
  const url = transcriptBrowserUrl(href);
  if (!open || !url) return <a href={href} {...props}>{children}</a>;
  return <a {...props} href={href} title="Open in session browser" data-session-browser-link="true" data-testid="opencode-transcript-browser-link"
    className={`underline underline-offset-2 ${props.className ?? ""}`}
    onClick={(event) => {
      props.onClick?.(event);
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      open(url);
    }}>
    {children}<Globe2 aria-hidden="true" size={13} className="ml-1 inline-block align-[-0.125em]" />
    <span className="sr-only"> (open in session browser)</span>
  </a>;
}
