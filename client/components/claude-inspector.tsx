import { useMemo, useState } from "react";
import { Download } from "lucide-react";

import { Badge } from "../ds/badge.js";
import { Button } from "../ds/button.js";
import { cn } from "../ds/utils.js";
import { extractCommands, serializeCommands, formatClockTime, type CommandCategory, type CommandEntry } from "../lib/derive.js";
import type { TranscriptEvent } from "../lib/transcript.js";

type InspectorTab = "todo" | "runlog" | "subagents";
type RunLogFilter = "all" | "edit" | "command" | "read" | "failure" | "other";

const TABS: Array<{ id: InspectorTab; label: string }> = [
  { id: "todo", label: "Todo" },
  { id: "runlog", label: "Run log" },
  { id: "subagents", label: "Subagents" },
];

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

export function ClaudeInspector({ events, title }: { events: TranscriptEvent[]; title: string }) {
  const [tab, setTab] = useState<InspectorTab>("todo");
  const [filter, setFilter] = useState<RunLogFilter>("all");
  const commands = useMemo(() => extractCommands(events), [events]);
  const visible = commands.filter((command) => matches(command, filter));
  const hasCommands = commands.some((command) => command.category === "command" && command.commandText);
  const todoCount = 0;
  const doneCount = 0;

  return (
    <aside className="flex min-h-0 w-full flex-col border-l border-[var(--color-border-default)] bg-[var(--color-background-surface)] lg:w-80 xl:w-96" data-testid="claude-inspector">
      <div className="flex shrink-0 border-b border-[var(--color-border-default)]">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={cn(
              "flex-1 px-3 py-2 text-xs font-medium transition-colors",
              tab === t.id
                ? "border-b-2 border-[var(--color-text-info)] text-[var(--color-text-info)]"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]",
            )}
            onClick={() => setTab(t.id)}
            data-testid={`claude-inspector-tab-${t.id}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "todo" && (
          <div className="p-3" data-testid="claude-inspector-todo">
            <div className="mb-3 flex items-center justify-between text-xs">
              <span className="font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Session todo</span>
              <span className="tabular-nums text-[var(--color-text-muted)]">{doneCount}/{todoCount} done</span>
            </div>
            <p className="text-sm text-[var(--color-text-muted)]">No todos reported.</p>
            <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">
              The Claude binary's headless stream does not expose todo items. This tab will populate when capture infrastructure is added.
            </p>
          </div>
        )}

        {tab === "runlog" && (
          <div data-testid="claude-inspector-runlog">
            <div className="flex flex-wrap items-center gap-1 border-b border-[var(--color-border-default)] p-2">
              {FILTERS.map((candidate) => {
                const count = commands.filter((c) => matches(c, candidate.id)).length;
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    className={cn(
                      "rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                      filter === candidate.id
                        ? "bg-[var(--color-background-surface-info-muted)] text-[var(--color-text-info)]"
                        : "text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]",
                    )}
                    onClick={() => setFilter(candidate.id)}
                    data-testid={`claude-inspector-runlog-filter-${candidate.id}`}
                  >
                    {candidate.label} <span className="ml-0.5 tabular-nums opacity-70">{count}</span>
                  </button>
                );
              })}
              {hasCommands && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => download(`${title || "claude-session"}.commands.sh`, serializeCommands(commands), "text/x-shellscript")}
                  aria-label="Export commands"
                  title="Export commands as .sh"
                  data-testid="claude-inspector-runlog-export"
                >
                  <Download aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            <div className="p-2">
              {visible.length === 0
                ? <p className="p-2 text-sm text-[var(--color-text-muted)]">No matching actions.</p>
                : <ol className="space-y-1" data-testid="claude-inspector-runlog-timeline">
                    {visible.map((command) => (
                      <li key={command.id} className="rounded-md border border-[var(--color-border-default)] p-2 text-xs">
                        <div className="flex items-center gap-1.5">
                          <Badge variant="neutral" className="text-[10px]">{command.category}</Badge>
                          <span className="min-w-0 truncate font-medium">{command.name}</span>
                          {command.status === "error" && <Badge variant="neutral" className="text-[10px]">failed</Badge>}
                          <span className="ml-auto shrink-0 text-[10px] text-[var(--color-text-muted)]">{formatClockTime(command.timestamp)}</span>
                        </div>
                        {command.text && <p className="mt-1 truncate font-mono text-[10px] text-[var(--color-text-muted)]">{command.text}</p>}
                      </li>
                    ))}
                  </ol>}
            </div>
          </div>
        )}

        {tab === "subagents" && (
          <div className="p-3" data-testid="claude-inspector-subagents">
            <p className="text-sm text-[var(--color-text-muted)]">No subagents reported.</p>
            <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">
              The Claude binary spawns subagents internally, but the headless stream-json output does not expose structured child session data. This tab will populate when subagent capture infrastructure is added.
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}
