// client/ds/markdown.tsx
//
// Markdown rendering for LLM-generated prose (assistant turns, forge review
// bodies, repository documentation).
//
// This used to be a chain of regexes producing an HTML string that was handed
// to `dangerouslySetInnerHTML`. Issue #140 needed *interactive* nodes — a
// verified `scripts/launchd.ts:222` has to become a real button — and injecting
// controls by pattern-matching generated HTML is precisely the design that
// turns a rendering bug into an injection bug. The renderer therefore works on
// parsed markdown nodes now (`react-markdown` + `remark-gfm`), and emits React
// elements. Nothing on this path builds or interprets an HTML string.
//
// Sanitization, restated because it moved rather than disappeared:
//
//   - Raw HTML in the source is NOT rendered. `react-markdown` drops `html`
//     nodes unless `rehype-raw` is installed, and it is deliberately not.
//     `untrusted` additionally entity-escapes the source first, so the markup
//     survives as visible text instead of vanishing — the previous behaviour.
//   - Link targets are gated by `isSafeHref`. An unsafe target renders as
//     plain text, exactly as before.
//   - Images never reach the network. `Attachment.url` in the transcript is
//     "not necessarily an http URL", and an `<img>` built from agent prose is
//     an SSRF and tracking-pixel surface for a value the agent chose. The alt
//     text is rendered instead.
//   - Workspace file references only become interactive where a
//     WorkspaceReferenceProvider is mounted AND the server confirmed the path
//     is readable. `untrusted` opts out entirely: forge comments must not gain
//     workspace affordances.

import { Children, Fragment, createContext, isValidElement, memo, useContext } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { describeLineRange } from "../lib/fileReferences.js";
import { useWorkspaceReference } from "../lib/workspaceReferences.js";
import { FileReference } from "./file-reference.js";
import { MermaidDiagram } from "./mermaid-diagram.js";
import { cn } from "./utils.js";
import { TranscriptLink } from "../lib/transcriptBrowser.js";

/** Allowed link protocols when rendering markdown. Relative targets pass. */
export function isSafeHref(url: string): boolean {
  const value = url.trim();
  if (/^(https?:\/\/|mailto:|\/|#)/i.test(value)) return true;
  // No scheme at all is a relative link, which cannot escape the origin.
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

/**
 * Attributes for an outbound link.
 *
 * Root-relative and hash targets stay in this tab when the caller opts in
 * (repository documentation rendered inside the app); everything else opens
 * in a new tab without a referrer.
 */
export function linkAttributes(
  url: string,
  internalLinksInSameTab?: boolean,
): { target?: "_blank"; rel?: "noreferrer" } {
  const sameTab = internalLinksInSameTab && /^(?:\/|#)/u.test(url.trim());
  return sameTab ? {} : { target: "_blank", rel: "noreferrer" };
}

/** Bare http(s) URL in plain text, for autolinking. */
const BARE_URL_PATTERN = "https?:\\/\\/[^\\s<>\"']+";

/**
 * Split a matched URL into the link target and any trailing sentence
 * punctuation that shouldn't be part of it ("see https://x.dev." →
 * link https://x.dev, text "."). A closing paren stays in the URL only
 * while the URL still has an unmatched opening paren.
 */
function splitTrailingPunctuation(match: string): [url: string, trailing: string] {
  let end = match.length;
  while (end > 0) {
    const ch = match[end - 1];
    if (".,;:!?".includes(ch)) {
      end--;
    } else if (ch === ")") {
      const body = match.slice(0, end);
      const opens = (body.match(/\(/g) ?? []).length;
      const closes = (body.match(/\)/g) ?? []).length;
      if (closes > opens) end--;
      else break;
    } else {
      break;
    }
  }
  return [match.slice(0, end), match.slice(end)];
}

/** Escape raw HTML so it renders as text instead of markup or nothing. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Node components ─────────────────────────────────────────────────────────

/**
 * Fenced-block marker.
 *
 * `react-markdown` renders both an inline code span and a fenced block through
 * the `code` component, and a fenced block without an info string carries no
 * className to tell them apart. The `pre` wrapper flags its subtree instead,
 * which is exact rather than heuristic — and the distinction matters: a path
 * inside a fenced example must stay documentation.
 */
const FencedBlockContext = createContext(false);

interface MarkdownOptions {
  untrusted: boolean;
  internalLinksInSameTab: boolean;
  renderMermaid: boolean;
}

const MarkdownOptionsContext = createContext<MarkdownOptions>({
  untrusted: false,
  internalLinksInSameTab: false,
  renderMermaid: false,
});

export function isMermaidClassName(className: string | undefined): boolean {
  return className?.split(/\s+/u).includes("language-mermaid") ?? false;
}

function InlineCode({ text, className }: { text: string; className?: string }) {
  const { untrusted } = useContext(MarkdownOptionsContext);
  // Hooks cannot be called conditionally, so the lookup always runs and the
  // untrusted opt-out is applied to its result.
  const reference = useWorkspaceReference(text);
  if (!untrusted && reference) {
    return (
      <FileReference path={reference.target.path} lineLabel={describeLineRange(reference.target)} onOpen={reference.open}>
        {text}
      </FileReference>
    );
  }
  return <code className={className}>{text}</code>;
}

function MarkdownLink({ href, children }: { href: string; children: React.ReactNode }) {
  const { untrusted, internalLinksInSameTab } = useContext(MarkdownOptionsContext);
  const reference = useWorkspaceReference(href);
  if (!untrusted && reference) {
    return (
      <FileReference path={reference.target.path} lineLabel={describeLineRange(reference.target)} onOpen={reference.open}>
        {children}
      </FileReference>
    );
  }
  // An unsafe or unresolvable target degrades to its own text rather than
  // rendering an anchor the reader cannot trust.
  if (!isSafeHref(href)) return <>{children}</>;
  return (
    <TranscriptLink href={href} {...linkAttributes(href, internalLinksInSameTab)}>
      {children}
    </TranscriptLink>
  );
}

const COMPONENTS: Components = {
  pre: function PreNode({ children }) {
    const { renderMermaid } = useContext(MarkdownOptionsContext);
    const code = Children.toArray(children).find(isValidElement);
    const props = code?.props as { className?: string; children?: React.ReactNode } | undefined;
    const source = typeof props?.children === "string" ? props.children : "";
    if (renderMermaid && isMermaidClassName(props?.className) && source) return <MermaidDiagram source={source} />;
    return <FencedBlockContext.Provider value={true}><pre>{children}</pre></FencedBlockContext.Provider>;
  },
  code: function CodeNode({ className, children }) {
    const fenced = useContext(FencedBlockContext);
    const text = typeof children === "string" ? children : "";
    if (fenced || !text) return <code className={className}>{children}</code>;
    return <InlineCode text={text} className={className} />;
  },
  a: ({ href, children }) => <MarkdownLink href={href ?? ""}>{children}</MarkdownLink>,
  // See the module header: agent-chosen image sources are never fetched.
  img: ({ alt }) => <>{alt ?? ""}</>,
};

/**
 * Treat a single newline as a line break.
 *
 * CommonMark folds them into spaces, but agent prose (and the previous
 * renderer, which emitted `<br/>`) uses them as hard breaks. Restoring that
 * here keeps existing transcripts reading the way they were written; the
 * alternative was a further runtime dependency for fifteen lines of visitor.
 */
function remarkSoftBreaks() {
  interface Node {
    type: string;
    value?: string;
    children?: Node[];
  }
  const walk = (node: Node): void => {
    if (!node.children) return;
    const next: Node[] = [];
    for (const child of node.children) {
      if (child.type === "text" && typeof child.value === "string" && child.value.includes("\n")) {
        child.value.split("\n").forEach((piece, index) => {
          if (index > 0) next.push({ type: "break" });
          if (piece) next.push({ type: "text", value: piece });
        });
        continue;
      }
      next.push(child);
      walk(child);
    }
    node.children = next;
  };
  return (tree: Node) => walk(tree);
}

const PLUGINS = [remarkGfm, remarkSoftBreaks];

interface MarkdownProps {
  /** Raw markdown source. Empty/whitespace renders as nothing. */
  source: string;
  /** Optional extra classes appended to the `prose-markdown` wrapper. */
  className?: string;
  /**
   * Escape raw HTML and opt out of workspace file references. Set for content
   * derived from external users (forge comments, review bodies).
   */
  untrusted?: boolean;
  /** Keep root-relative and hash links in this tab. */
  internalLinksInSameTab?: boolean;
  /** Render strict Mermaid SVG only for repository-owned documentation. */
  renderMermaid?: boolean;
}

export const Markdown = memo(function Markdown({
  source,
  className,
  untrusted = false,
  internalLinksInSameTab = false,
  renderMermaid = false,
}: MarkdownProps) {
  if (!source || !source.trim()) return null;
  return (
    <MarkdownOptionsContext.Provider value={{ untrusted, internalLinksInSameTab, renderMermaid: renderMermaid && !untrusted }}>
      <div className={cn("prose-markdown", className)}>
        <ReactMarkdown
          remarkPlugins={PLUGINS}
          components={COMPONENTS}
          // Targets are inspected by MarkdownLink, which gates them and may
          // turn them into workspace references; react-markdown's own
          // transform would rewrite `file:` before that decision is made.
          urlTransform={(url) => url}
        >
          {untrusted ? escapeHtml(source) : source}
        </ReactMarkdown>
      </div>
    </MarkdownOptionsContext.Provider>
  );
});

/**
 * Render plain text with bare http(s) URLs turned into clickable links.
 * Emits real React elements, so it is safe for raw user input — use it where
 * text should stay verbatim (e.g. chat user bubbles) but pasted links should
 * still open.
 */
export function LinkifiedText({ text }: { text: string }) {
  // Split on a capturing group: odd indices are the matched URLs.
  const parts = text.split(new RegExp(`(${BARE_URL_PATTERN})`, "g"));
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return part;
        const [url, trailing] = splitTrailingPunctuation(part);
        return (
          <Fragment key={i}>
            <TranscriptLink href={url} target="_blank" rel="noreferrer" className="underline hover:opacity-80">
              {url}
            </TranscriptLink>
            {trailing}
          </Fragment>
        );
      })}
    </>
  );
}
