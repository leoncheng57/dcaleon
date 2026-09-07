import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { Button } from "../ds/button.js";
import type { WorkflowSummary } from "../lib/api.js";
import { genericWorkflowPrompt, genericWorkflowValid } from "../lib/workflows.js";

/**
 * The Claude lane's workflow form (the Claude counterpart of workflow-dialog.tsx).
 *
 * Only the generic argument workflows are offered here: the five bespoke ones
 * submit into OpenCode routes (session update, managed child, start-DCA, the
 * two review capture flows) that have no Claude equivalent. Choosing a
 * workflow never sends anything — "Apply to composer" fills the draft and
 * attaches the workflow id, and the ordinary Send is the only mutation. The
 * preview shows the trusted, server-resolved injector before anything is
 * attached, the same read-before-send guarantee the OpenCode form gives.
 */
export function ClaudeWorkflowDialog({
  workflow,
  onClose,
  onApplyToComposer,
}: {
  workflow: WorkflowSummary;
  onClose: () => void;
  onApplyToComposer: (draft: string, workflowID: string) => void;
}) {
  const [argumentValue, setArgumentValue] = useState("");
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const prompt = genericWorkflowPrompt(workflow, argumentValue);
  const valid = genericWorkflowValid(workflow, argumentValue);

  useEffect(() => {
    fieldRef.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center" role="presentation" onClick={onClose}>
      <section
        className="w-full max-w-2xl rounded-lg border border-[var(--color-border-default)] bg-[var(--color-background-surface)] shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="claude-workflow-title"
        data-testid="claude-workflow-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start gap-3 border-b border-[var(--color-border-default)] px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="claude-workflow-title" className="text-sm font-semibold">{workflow.title}</h2>
            <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{workflow.description}</p>
          </div>
          <Button size="sm" variant="ghost" aria-label="Close" onClick={onClose} data-testid="claude-workflow-close"><X aria-hidden="true" size={15} /></Button>
        </header>
        <div className="space-y-3 px-4 py-3">
          {workflow.argument ? (
            <label className="block text-xs">
              <span className="font-medium">{workflow.argument.label}</span>
              {workflow.argument.hint && <span className="ml-1 text-[var(--color-text-muted)]">{workflow.argument.hint}</span>}
              <textarea
                ref={fieldRef}
                className="mt-1 min-h-24 w-full resize-y rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-base)] px-3 py-2 text-sm"
                value={argumentValue}
                maxLength={workflow.argument.maxLength}
                placeholder={workflow.argument.placeholder}
                onChange={(event) => setArgumentValue(event.target.value)}
                data-testid="claude-workflow-argument"
              />
            </label>
          ) : (
            <p className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-base)] px-3 py-2 text-sm" data-testid="claude-workflow-fixed-prompt">{prompt}</p>
          )}
          <details className="text-xs" data-testid="claude-workflow-injector">
            <summary className="cursor-pointer text-[var(--color-text-muted)]">What is appended for the agent (server-resolved, read-only)</summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-base)] p-2 font-mono text-[11px]">{workflow.injector}</pre>
          </details>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-[var(--color-border-default)] px-4 py-3">
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={!valid} onClick={() => onApplyToComposer(prompt, workflow.id)} data-testid="claude-workflow-apply">Apply to composer</Button>
        </footer>
      </section>
    </div>
  );
}
