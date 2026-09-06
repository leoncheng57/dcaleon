import { useEffect, useState } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { Alert } from "../ds/alert.js";
import { Markdown } from "../ds/markdown.js";
import { getDoc, rewriteDocLinks } from "../lib/docs.js";

const REPOSITORY_BLOB_URL = "https://github.com/leoncheng57/dcaleon/blob/main";

export function DocPage() {
  const { slug } = useParams();
  const [searchParams] = useSearchParams();
  const doc = getDoc(slug);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState("");
  const docsHref = searchParams.size ? `/docs?${searchParams}` : "/docs";

  useEffect(() => {
    let active = true;
    setSource(null);
    setError("");
    if (!doc) return () => { active = false; };
    void doc.load()
      .then((content) => {
        if (active) setSource(rewriteDocLinks(content.replace(/^# .+\n+/u, ""), doc.sourcePath));
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Unable to load this document.");
      });
    return () => { active = false; };
  }, [doc]);

  if (!doc) {
    return (
      <main className="mx-auto max-w-3xl p-6" data-testid="opencode-doc">
        <Alert variant="warning">This document is not in the in-app catalogue.</Alert>
        <Link to={docsHref} className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-[var(--color-text-info)] hover:underline" data-testid="opencode-doc-back">
          <ArrowLeft aria-hidden="true" size={15} /> Back to docs
        </Link>
      </main>
    );
  }

  return (
    <main className="h-full overflow-y-auto" data-testid="opencode-doc">
      <div className="mx-auto max-w-4xl px-5 py-7 sm:px-8 sm:py-10">
        <header className="mb-8 border-b border-[var(--color-border-default)] pb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Link to={docsHref} className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--color-text-info)] hover:underline" data-testid="opencode-doc-back">
              <ArrowLeft aria-hidden="true" size={15} /> Docs
            </Link>
            <a
              href={`${REPOSITORY_BLOB_URL}/${doc.sourcePath}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 font-mono text-[10px] text-[var(--color-text-muted)] hover:underline"
              data-testid="opencode-doc-source"
            >
              {doc.sourcePath} <ExternalLink aria-hidden="true" size={12} />
            </a>
          </div>
          <h1 className="mt-6 text-3xl font-bold tracking-tight sm:text-4xl">{doc.title}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--color-text-muted)]">{doc.description}</p>
        </header>
        {error && <Alert variant="danger">{error}</Alert>}
        {!error && source === null && <p className="text-sm text-[var(--color-text-muted)]">Loading document...</p>}
        {source !== null && <Markdown source={source} internalLinksInSameTab renderMermaid className="docs-markdown" />}
      </div>
    </main>
  );
}
