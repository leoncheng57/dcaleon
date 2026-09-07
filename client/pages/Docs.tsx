import { ArrowRight, BookOpen, GitBranch, Radio, Server, ShieldCheck } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";

import { Badge } from "../ds/badge.js";
import {
  DOC_CATEGORY_LABELS,
  DOC_CATEGORY_ORDER,
  DOCS,
  type DocDefinition,
} from "../lib/docs.js";

function ArchitectureNode({
  icon: Icon,
  label,
  detail,
  step,
}: {
  icon: typeof BookOpen;
  label: string;
  detail: string;
  step: string;
}) {
  return (
    <li className="relative min-w-0 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-background-surface)] p-4 has-shadow-default">
      <div className="mb-5 flex items-center justify-between gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--color-background-surface-neutral-muted)] text-[var(--color-text-success)]">
          <Icon aria-hidden="true" size={18} />
        </span>
        <span className="font-mono text-[10px] tracking-[0.18em] text-[var(--color-text-muted)]">{step}</span>
      </div>
      <strong className="block text-sm">{label}</strong>
      <span className="mt-1 block text-xs leading-relaxed text-[var(--color-text-muted)]">{detail}</span>
    </li>
  );
}

function DocCard({ doc, href }: { doc: DocDefinition; href: string }) {
  return (
    <Link
      to={href}
      className="group flex min-h-40 flex-col rounded-xl border border-[var(--color-border-default)] bg-[var(--color-background-surface)] p-4 transition-colors hover:border-[var(--color-border-focus)]"
      data-testid={`opencode-doc-card-${doc.slug}`}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="font-mono text-[10px] text-[var(--color-text-muted)]">{doc.sourcePath}</span>
        <ArrowRight aria-hidden="true" className="shrink-0 text-[var(--color-text-muted)] transition-transform group-hover:translate-x-1" size={15} />
      </div>
      <h3 className="mt-6 text-base font-semibold group-hover:underline">{doc.title}</h3>
      <p className="mt-2 text-xs leading-relaxed text-[var(--color-text-muted)]">{doc.description}</p>
    </Link>
  );
}

export function DocsPage() {
  const [searchParams] = useSearchParams();
  const scopedHref = (path: string) => {
    const search = searchParams.toString();
    return search ? `${path}?${search}` : path;
  };

  return (
    <main className="h-full overflow-y-auto" data-testid="opencode-docs">
      <div className="mx-auto max-w-6xl space-y-14 px-5 py-8 sm:px-8 sm:py-12">
        <header className="grid gap-8 border-b border-[var(--color-border-default)] pb-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-end">
          <div>
            <div className="mb-4 flex items-center gap-2">
              <Badge variant="info">Engineering docs</Badge>
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-muted)]">host-native agent IDE</span>
            </div>
            <h1 className="max-w-3xl text-4xl font-bold leading-[0.98] tracking-[-0.04em] sm:text-6xl">
              Understand the system before changing the seam.
            </h1>
            <p className="mt-5 max-w-2xl text-sm leading-relaxed text-[var(--color-text-muted)] sm:text-base">
              A visual entry point to the architecture, operating boundaries, and evidence behind dcaleon.
            </p>
          </div>
          <aside className="border-l-4 border-[var(--color-border-focus)] bg-[var(--color-background-surface-neutral-muted)] p-5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-success)]">Source of truth</span>
            <strong className="mt-2 block text-lg">Markdown stays canonical.</strong>
            <p className="mt-2 text-xs leading-relaxed text-[var(--color-text-muted)]">
              These pages render repository-owned documents. Edit the Markdown, not a second copy in the UI.
            </p>
          </aside>
        </header>

        <section aria-labelledby="architecture-heading">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-success)]">01 / Runtime path</span>
              <h2 id="architecture-heading" className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">One server, every project</h2>
            </div>
            <Link
              to={scopedHref("/docs/architecture")}
              className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-info)] hover:underline"
              data-testid="opencode-docs-open-architecture"
            >
              Read architecture <ArrowRight aria-hidden="true" size={15} />
            </Link>
          </div>
          <ol className="grid gap-3 md:grid-cols-4" aria-label="Application request path">
            <ArchitectureNode icon={BookOpen} step="01" label="Browser" detail="Desktop or phone UI. No OpenCode or forge credentials." />
            <ArchitectureNode icon={GitBranch} step="02" label="React SPA" detail="Sessions, normalized transcripts, settings, and local device state." />
            <ArchitectureNode icon={Server} step="03" label="Express BFF" detail="Directory validation, credentials, Git, notifications, and SSE fan-out." />
            <ArchitectureNode icon={Radio} step="04" label="OpenCode server" detail="One host process serving every directory-scoped project and session." />
          </ol>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <div className="rounded-lg bg-[var(--color-background-surface-neutral-muted)] p-4">
              <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Prompts</span>
              <p className="mt-1 text-xs leading-relaxed"><code>prompt_async</code> returns immediately; work survives disconnected clients.</p>
            </div>
            <div className="rounded-lg bg-[var(--color-background-surface-neutral-muted)] p-4">
              <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Events</span>
              <p className="mt-1 text-xs leading-relaxed"><code>/global/event</code> is fanned out and demultiplexed by directory.</p>
            </div>
            <div className="rounded-lg bg-[var(--color-background-surface-neutral-muted)] p-4">
              <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Guardrail</span>
              <p className="mt-1 flex gap-2 text-xs leading-relaxed"><ShieldCheck aria-hidden="true" className="shrink-0 text-[var(--color-text-success)]" size={15} /> Host tools are bounded by permissions and canonicalized workspace roots.</p>
            </div>
          </div>
        </section>

        <section aria-labelledby="library-heading">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-success)]">02 / Reading library</span>
          <h2 id="library-heading" className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Follow the evidence trail</h2>
          <div className="mt-7 space-y-9">
            {DOC_CATEGORY_ORDER.map((category) => (
              <div key={category}>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">{DOC_CATEGORY_LABELS[category]}</h3>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {DOCS.filter((doc) => doc.category === category).map((doc) => (
                    <DocCard key={doc.slug} doc={doc} href={scopedHref(`/docs/${doc.slug}`)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
