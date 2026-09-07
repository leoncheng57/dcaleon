import { useMemo, useState } from "react";
import { Download, ListTree, X } from "lucide-react";

import { Badge } from "../ds/badge.js";
import { Button } from "../ds/button.js";
import { extractCommands, serializeCommands, formatClockTime, type CommandCategory, type CommandEntry } from "../lib/derive.js";
import type { TranscriptEvent } from "../lib/transcript.js";

// The run log, derived from the SAME events the transcript renders (via the
// shared derive.ts helpers), so the two views can never disagree about what the
// agent did. Backend-agnostic — no coupling to the opencode session inspector.
type RunLogFilter = "all" | "edit" | "command" | "read" | "failure" | "other";

const FILTERS: Array<{ id: RunLogFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "edit", label: "Edits" },
  { id: "command", label: "Commands" },
  { id: "read", label: "Reads" },
  { id: "failure", label: "Failures" },
  { id: "other", label: "Other" },
];

function matches(command: CommandEntry, filter: RunLogFilter): boolean {
  if (filter === "all") return true;
  if (filter === "failure") return command.status === "error";
  return command.category === (filter as CommandCategory);
}

function download(name: string, body: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ClaudeRunLogDrawer({ events, title, onClose }: { events: TranscriptEvent[]; title: string; onClose: () => void }) {
  const [filter, setFilter] = useState<RunLogFilter>("all");
  const commands = useMemo(() => extractCommands(events), [events]);
  const visible = commands.filter((command) => matches(command, filter));
  const hasCommands = commands.some((command) => command.category === "command" && command.commandText);

  return (
    <section className="fixed inset-x-0 bottom-0 top-11 z-50 flex flex-col border-l border-[var(--color-border-default)] bg-[var(--color-background-surface)] shadow-xl sm:left-auto sm:w-[46rem]" role="dialog" aria-modal="true" aria-label="Run log" data-testid="claude-runlog">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border-default)] p-2">
        <ListTree aria-hidden="true" size={16} />
        <strong className="text-sm">Run log</strong>
        <Badge variant="neutral">{commands.length} {commands.length === 1 ? "action" : "actions"}</Badge>
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="secondary" disabled={!hasCommands} onClick={() => download(`${title || "claude-session"}.commands.sh`, serializeCommands(commands), "text/x-shellscript")} data-testid="claude-runlog-export"><Download aria-hidden="true" size={14} className="mr-1" /> Commands</Button>
          <Button size="sm" variant="ghost" onClick={onClose} data-testid="claude-runlog-close"><X aria-hidden="true" size={15} /> Close</Button>
        </div>
      </header>
      <div className="flex flex-wrap gap-1 border-b border-[var(--color-border-default)] p-2">
        {FILTERS.map((candidate) => {
          const count = commands.filter((command) => matches(command, candidate.id)).length;
          return (
            <Button key={candidate.id} size="sm" variant={filter === candidate.id ? "secondary" : "ghost"} onClick={() => setFilter(candidate.id)} data-testid={`claude-runlog-filter-${candidate.id}`}>
              {candidate.label} <span className="ml-1 tabular-nums text-[var(--color-text-muted)]">{count}</span>
            </Button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {visible.length === 0
          ? <p className="p-3 text-sm text-[var(--color-text-muted)]" data-testid="claude-runlog-empty">No matching actions.</p>
          : <ol className="space-y-1.5" data-testid="claude-runlog-timeline">
              {visible.map((command) => (
                <li key={command.id} className="rounded-md border border-[var(--color-border-default)] p-2 text-sm" data-testid="claude-runlog-row" data-category={command.category}>
                  <div className="flex items-center gap-2">
                    <Badge variant="neutral">{command.category}</Badge>
                    <strong className="min-w-0 truncate">{command.name}</strong>
                    {command.status === "error" && <Badge variant="neutral">failed</Badge>}
                    <span className="ml-auto shrink-0 text-xs text-[var(--color-text-muted)]">{formatClockTime(command.timestamp)}</span>
                  </div>
                  {command.text && <p className="mt-1 break-words font-mono text-[11px] leading-5 text-[var(--color-text-muted)]">{command.text}</p>}
                  {command.fileSummary && <p className="mt-1 text-xs text-[var(--color-text-muted)]">{command.fileSummary}</p>}
                </li>
              ))}
            </ol>}
      </div>
    </section>
  );
}
