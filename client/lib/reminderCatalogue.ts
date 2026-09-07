import { ArrowRightLeft, Bird, BookOpen, FileText, Footprints, GitFork, ListChecks, MessageCircleQuestion, Search, Send, Waves, type LucideIcon } from "lucide-react";

import type { ReminderSummary } from "./api.js";

/**
 * Presentation taxonomy for reminders, shared by the composer picker and the
 * Playbooks catalogue.
 *
 * This lived inside `reminder-picker.tsx` while the picker was the only place
 * that rendered a reminder. Playbooks now renders the same catalogue, and two
 * private copies of the grouping would drift silently: a reminder could appear
 * under "Delegate & Parallelize" in the composer and somewhere else on the
 * page describing that same composer.
 *
 * Like `WORKFLOW_GROUPS`, this is presentation only. It confers no authority,
 * gates nothing, and is never sent to the server — the server decides which
 * reminders exist and what their bodies say.
 */
export const REMINDER_GROUPS: ReadonlyArray<{ label: string; ids: readonly string[] }> = [
  { label: "Plan & Design", ids: ["grill-me", "build-waves"] },
  // Its own group rather than a seat in "Research & Evidence": the four groups
  // around it all end in an artifact — a plan, a citation, a delegated session,
  // a document. This one ends in a person understanding something, and filing
  // it under research would describe the agent's reading rather than the human's.
  { label: "Learn & Understand", ids: ["brink-nudge-learning"] },
  { label: "Research & Evidence", ids: ["deep-research-subagents", "parallel-research-handoff", "cite-file-lines"] },
  { label: "Delegate & Parallelize", ids: ["background-subagent", "session-handoff", "native-worktree-subagents"] },
  { label: "Documentation & Delivery", ids: ["docs-and-diagram-tooling", "ascii-diagrams", "human-verification-steps"] },
  { label: "Examples / Display", ids: ["duck-mode"] },
];

export const REMINDER_ICONS: Readonly<Record<string, LucideIcon>> = {
  "grill-me": MessageCircleQuestion,
  "build-waves": Waves,
  "brink-nudge-learning": Footprints,
  "deep-research-subagents": Search,
  "parallel-research-handoff": Send,
  "cite-file-lines": FileText,
  "background-subagent": Send,
  "session-handoff": ArrowRightLeft,
  "native-worktree-subagents": GitFork,
  "docs-and-diagram-tooling": BookOpen,
  "ascii-diagrams": FileText,
  "human-verification-steps": ListChecks,
  "duck-mode": Bird,
};

export interface ReminderGroup {
  label: string;
  reminders: ReminderSummary[];
}

/**
 * Groups a catalogue in `REMINDER_GROUPS` order.
 *
 * A reminder this build has never heard of still has to appear: the server may
 * ship one before the client names it. Those land in a trailing "Other" bucket
 * rather than being dropped, exactly as `groupWorkflows` handles the same case.
 */
export function groupReminders(catalogue: ReminderSummary[]): ReminderGroup[] {
  const grouped: ReminderGroup[] = REMINDER_GROUPS.map(({ label, ids }) => ({
    label,
    reminders: ids.flatMap((id) => {
      const reminder = catalogue.find((candidate) => candidate.id === id);
      return reminder ? [reminder] : [];
    }),
  })).filter(({ reminders }) => reminders.length > 0);
  const knownIds = new Set<string>(REMINDER_GROUPS.flatMap(({ ids }) => ids));
  const other = catalogue.filter((reminder) => !knownIds.has(reminder.id));
  if (other.length) grouped.push({ label: "Other", reminders: other });
  return grouped;
}

/** The group a reminder renders under, for a detail page's eyebrow. */
export function reminderGroupLabel(catalogue: ReminderSummary[], id: string): string {
  return groupReminders(catalogue).find(({ reminders }) => reminders.some((candidate) => candidate.id === id))?.label ?? "Other";
}
