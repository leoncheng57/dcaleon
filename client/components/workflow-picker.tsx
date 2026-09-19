import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowRightLeft, Blocks, BookOpen, Check, ChevronDown, Circle, ClipboardList, ExternalLink, FolderGit2, GitBranch, GitPullRequest, GraduationCap, Image, ListChecks, LogOut, Megaphone, MessageSquareText, MonitorCheck, PencilRuler, Search, Split, SquarePlus, Swords, Target, Telescope, Terminal, Users, X, type LucideIcon } from "lucide-react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";

import type { WorkflowSummary } from "../lib/api.js";
import { groupWorkflows } from "../lib/workflows.js";

const LISTBOX_ID = "composer-workflow-listbox";

/**
 * Search title and id only.
 *
 * The description used to be searched too, which was harmless at six workflows
 * and is not at 22: a plain substring match over 22 descriptions turns "review"
 * into a hit on "Start a DCA session" (its description says *reviewing* its
 * mode) and on "Send an update to another session" (whose description contains
 * "pre**view**"). Both surface a tile whose visible text does not contain what
 * was typed, which reads as a bug rather than as a feature. The description is
 * no longer on the tile either, so matching on it would be matching on text the
 * reader cannot see.
 */
function matches(workflow: WorkflowSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || `${workflow.title} ${workflow.id}`.toLowerCase().includes(needle);
}

/**
 * One distinct symbol per workflow. In a 22-tile grid whose tiles carry only a
 * two-line title, the icon rail is the primary scanning aid — a shared fallback
 * would carry zero information for most of the catalogue, so every shipped id
 * is named here. `Circle` remains only for a workflow a newer server ships that
 * this build has never heard of.
 */
const WORKFLOW_ICONS: Record<string, LucideIcon> = {
  // Review
  "playwright-ui-review": MonitorCheck,
  "pr-snippet-review": GitPullRequest,
  // Execute
  goal: Target,
  dca: Terminal,
  "leaving-now-wrap-up": LogOut,
  // Delegate
  "managed-child": Split,
  "start-dca-session": SquarePlus,
  "session-handoff": ArrowRightLeft,
  // Coordinate
  "session-update": MessageSquareText,
  standup: Megaphone,
  // Document
  "design-doc-prototype": Image,
  "docs-preview": BookOpen,
  "mini-design-doc": PencilRuler,
  "system-design-artifacts": Blocks,
};

/**
 * The composer's Workflows entry point (issue #167). Choosing a workflow only
 * OPENS its form — nothing is ever sent or launched from this picker. The
 * "attached" value names a workflow whose trusted injector will ride the next
 * composer send (set by the form's explicit "Apply to composer"), mirroring
 * how the reminder picker displays its per-message selection.
 */
export function WorkflowPicker({
  catalogue,
  attached,
  onDetach,
  onPick,
}: {
  catalogue: WorkflowSummary[];
  attached: string;
  onDetach: () => void;
  onPick: (workflow: WorkflowSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const attachedWorkflow = catalogue.find((workflow) => workflow.id === attached);
  const groupedWorkflows = groupWorkflows(catalogue)
    .map(({ label, workflows }) => ({ label, workflows: workflows.filter((workflow) => matches(workflow, query)) }))
    .filter(({ workflows }) => workflows.length > 0);
  const visibleWorkflows = groupedWorkflows.flatMap(({ workflows }) => workflows);
  // The detach row only exists while something is attached; a "no workflow"
  // placeholder would suggest workflows are a mode rather than an action.
  const options: Array<WorkflowSummary | null> = attachedWorkflow ? [null, ...visibleWorkflows] : [...visibleWorkflows];

  useEffect(() => {
    if (!open) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    setActive(0);
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      document.body.style.overflow = overflow;
      if (triggerRef.current?.isConnected) triggerRef.current.focus();
    };
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, open, query]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const choose = (workflow: WorkflowSummary | null) => {
    close();
    if (workflow) onPick(workflow);
    else onDetach();
  };
  const activeOption = options[active];
  const activeID = activeOption ? `composer-workflow-option-${activeOption.id}` : "composer-workflow-option-none";
  const move = (delta: number) => {
    // Unlike the reminder picker there is no unconditional sentinel row, so a
    // query that matches nothing empties `options` entirely and the modulo
    // would divide by zero.
    if (options.length === 0) return;
    setActive((index) => (index + delta + options.length) % options.length);
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    switch (event.key) {
      case "Escape": event.preventDefault(); close(); break;
      case "ArrowDown": event.preventDefault(); move(1); break;
      case "ArrowUp": event.preventDefault(); move(-1); break;
      case "Home": event.preventDefault(); setActive(0); break;
      case "End": event.preventDefault(); if (options.length) setActive(options.length - 1); break;
      case "Enter": event.preventDefault(); choose(activeOption ?? null); break;
    }
  };

  return <div className="min-w-0 shrink">
    <button
      ref={triggerRef}
      type="button"
      onClick={() => setOpen(true)}
      className={`flex min-h-11 min-w-0 max-w-56 items-center gap-1.5 rounded-md border px-2.5 text-left text-sm sm:min-h-8 sm:text-xs ${
        attachedWorkflow
          ? "border-[var(--color-border-focus)] bg-[var(--color-background-surface)] text-[var(--color-text-default)]"
          : "border-transparent bg-transparent text-[var(--color-text-muted)] hover:border-[var(--color-border-default)]"
      }`}
      data-testid="composer-workflow-select"
      aria-label="Run a guided workflow"
      aria-haspopup="dialog"
      aria-expanded={open}
      title={attachedWorkflow
        ? `${attachedWorkflow.title}\n\nIts trusted injector rides the next send. Choose "Detach workflow" to remove it.`
        : "Guided, explicit actions. Choosing one opens a form; nothing is sent or launched until you confirm."}
      value={attached}
    >
      {attachedWorkflow && <WorkflowIcon workflow={attachedWorkflow} />}
      <span className="min-w-0 flex-1 truncate">{attachedWorkflow?.title ?? "Workflows"}</span>
      <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
    </button>
    {open && createPortal(
      <div className="fixed inset-0 z-[90] flex items-end justify-center sm:items-start sm:p-4 sm:pt-[10vh]" data-testid="composer-workflow-panel">
        <button type="button" aria-label="Close workflow picker" className="absolute inset-0 bg-[var(--color-background-overlay)]" onClick={close} data-testid="composer-workflow-backdrop" />
        <div className="relative flex max-h-[82dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-[var(--color-border-default)] bg-[var(--color-background-surface-raised)] shadow-xl sm:max-h-[72vh] sm:max-w-2xl sm:rounded-xl" role="dialog" aria-modal="true" aria-label="Workflow picker" onKeyDown={handleKeyDown}>
          {/*
            * One header row — search on the left, close on the right — exactly
            * as the reminder picker builds it. The heading and the promise that
            * used to sit above the search cost a whole band of a panel whose
            * scarce resource is vertical space; the promise moves to the footer
            * hint, where it is still on screen at all times and no longer
            * competes with the catalogue for the first fold.
            */}
          <div className="flex items-center gap-2 border-b border-[var(--color-border-default)] p-3">
            <div className="relative min-w-0 flex-1">
              <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search workflows"
                className="h-11 w-full rounded-md border border-[var(--color-border-default)] bg-transparent pl-9 pr-3 text-base text-[var(--color-text-default)] outline-none sm:h-9 sm:text-sm"
                data-testid="composer-workflow-search"
                role="combobox"
                aria-label="Search workflows"
                aria-controls={LISTBOX_ID}
                aria-expanded="true"
                aria-autocomplete="list"
                aria-activedescendant={activeID}
              />
            </div>
            <button type="button" onClick={close} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-[var(--hh-row-hover)] sm:h-9 sm:w-9" aria-label="Close workflow picker" data-testid="composer-workflow-close"><X aria-hidden="true" className="h-4 w-4" /></button>
          </div>
          {/*
            * No tag chip row here, deliberately — see the PR body. Workflows
            * have no `tags` field, the five group headings already sit in the
            * scroll flow, and a second taxonomy would have to be authored,
            * served and kept true. This is the one place the two pickers
            * differ structurally, and it is a choice rather than an omission.
            */}
          <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-2" id={LISTBOX_ID} ref={listRef} role="listbox" aria-label="Workflows" aria-activedescendant={activeID}>
            {attachedWorkflow && (
              <button
                type="button"
                id="composer-workflow-option-none"
                role="option"
                aria-selected={false}
                data-active={active === 0}
                data-testid="composer-workflow-option-none"
                onClick={() => choose(null)}
                onMouseMove={() => setActive(0)}
                className={`flex min-h-14 w-full items-center gap-3 rounded-lg px-3 py-2 text-left ${active === 0 ? "bg-[var(--color-background-surface-neutral-muted)]" : "hover:bg-[var(--hh-row-hover)]"}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-[var(--color-text-default)]">Detach workflow</span>
                  <span className="block text-xs text-[var(--color-text-muted)]">Send the next message without the "{attachedWorkflow.title}" injector.</span>
                </span>
              </button>
            )}
            {/*
              * A title-only tile grid, structurally identical to the reminder
              * picker's. One full-width row carrying a two-to-three line
              * description fit roughly 4.5 workflows on a desktop screen and
              * about four on a phone, with at most one and a half group
              * headings visible at once — so the grouping never organised
              * anything for the reader it was there to help.
              *
              * The description is relocated, not lost: it stays on the form's
              * preview stage, where it is read before sending rather than
              * while scanning, and on the tile as `aria-description` and
              * `title` so a screen reader and a hover still get it.
              *
              * The tile carries a detail link, matching the reminder tile.
              * It deliberately did NOT while the detail page only restated
              * the injector, because the form already shows the exact prompt
              * and the exact trusted injector before sending (decision 21) —
              * spending tile width on a guarantee the next click already
              * makes would have been waste.
              *
              * That reasoning expired when the page gained a worked example.
              * A simulation is the one thing the form cannot show: what this
              * workflow actually did on a real task, including where it went
              * wrong. The link now buys something the next click does not.
              */}
            {groupedWorkflows.map(({ label, workflows }) => <section key={label} role="group" aria-label={label} className="mb-4 last:mb-0" data-testid="composer-workflow-group">
              <h3 className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-text-muted)]">{label}</h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {workflows.map((workflow) => {
                  const optionIndex = visibleWorkflows.indexOf(workflow) + (attachedWorkflow ? 1 : 0);
                  const isActive = active === optionIndex;
                  const isAttached = attached === workflow.id;
                  // Two independent touch targets: the button selects, the
                  // link opens the worked example. The link is a real ~44px
                  // target of its own, bordered so its boundary is visible.
                  return <div key={workflow.id} className={`relative flex min-h-14 min-w-0 overflow-hidden rounded-lg border ${isActive ? "border-[var(--color-border-focus)] bg-[var(--color-background-surface-neutral-muted)]" : "border-[var(--color-border-default)]"}`} data-testid="composer-workflow-tile" data-workflow-id={workflow.id}>
                    <button
                    type="button"
                    id={`composer-workflow-option-${workflow.id}`}
                    role="option"
                    aria-selected={isAttached}
                    // The description leaves the tile but not the accessible
                    // name tree: a screen reader still hears what the workflow
                    // does before choosing it, and so does a hover.
                    aria-label={workflow.title}
                    aria-description={workflow.description}
                    title={`${workflow.title}\n\n${workflow.description}`}
                    data-active={isActive}
                    data-workflow-id={workflow.id}
                    data-testid="composer-workflow-option"
                    onClick={() => choose(workflow)}
                    onMouseMove={() => setActive(optionIndex)}
                    className={`flex min-h-14 min-w-0 flex-1 items-center gap-2 px-2 text-left ${isActive ? "" : "hover:bg-[var(--hh-row-hover)]"}`}
                  >
                    <WorkflowIcon workflow={workflow} />
                    <span className="line-clamp-2 min-w-0 flex-1 text-left text-xs font-medium leading-4 text-[var(--color-text-default)]" data-testid="composer-workflow-title">{workflow.title}</span>
                    {isAttached && <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-info)]" />}
                    </button>
                    <Link
                      to={`/playbooks/workflows/${workflow.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="flex h-full w-11 shrink-0 items-center justify-center border-l border-[var(--color-border-default)] text-[var(--color-text-link)] hover:bg-[var(--hh-row-hover)]"
                      data-testid="composer-workflow-details"
                      data-workflow-id={workflow.id}
                      aria-label={`Open ${workflow.title} details in a new tab`}
                    >
                      <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
                    </Link>
                  </div>;
                })}
              </div>
            </section>)}
            {visibleWorkflows.length === 0 && <p className="px-3 py-10 text-center text-sm text-[var(--color-text-muted)]" data-testid="composer-workflow-empty">No matching workflows</p>}
          </div>
          {/*
            * The reminder picker's footer leads with what attaching a reminder
            * actually does ("applies to the next message only") before the key
            * hints. The workflow equivalent has to lead with the same kind of
            * fact, and the honest one is that Enter opens a form: this picker
            * cannot send or launch anything, which is the promise that used to
            * live in the header.
            */}
          <p className="shrink-0 border-t border-[var(--color-border-default)] px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-[11px] text-[var(--color-text-muted)]" aria-live="polite">Choosing a workflow opens its form. Nothing is sent or launched until you confirm. Up/Down to navigate - Enter to open the form - Esc to close</p>
        </div>
      </div>,
      document.body,
    )}
  </div>;
}

function WorkflowIcon({ workflow }: { workflow: WorkflowSummary }) {
  const Icon = WORKFLOW_ICONS[workflow.id] ?? Circle;
  return <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-surface-neutral-muted)] text-[var(--color-text-default)]" data-testid="composer-workflow-icon">
    <Icon aria-hidden="true" className="h-3.5 w-3.5" />
  </span>;
}
