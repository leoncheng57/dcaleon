import type { Todo } from "./api.js";

export type TodoStatusKind = "completed" | "in_progress" | "cancelled" | "pending";
export type TodoPriorityKind = "high" | "medium" | "low";

/** Normalises the agent-reported status; anything unrecognised is treated as pending. */
export function todoStatusKind(status: string): TodoStatusKind {
  const value = status.trim().toLowerCase().replaceAll("-", "_");
  if (value === "completed" || value === "done") return "completed";
  if (value === "in_progress" || value === "active") return "in_progress";
  if (value === "cancelled" || value === "canceled") return "cancelled";
  return "pending";
}

export function todoPriorityKind(priority: string): TodoPriorityKind {
  const value = priority.trim().toLowerCase();
  return value === "high" || value === "medium" ? value : "low";
}

export const TODO_STATUS_LABEL: Record<TodoStatusKind, string> = {
  completed: "Completed",
  in_progress: "In progress",
  cancelled: "Cancelled",
  pending: "Pending",
};

/** Counts for the header. Cancelled items are excluded from the denominator of the progress bar. */
export function todoSummary(todos: Todo[]) {
  const counts: Record<TodoStatusKind, number> = { completed: 0, in_progress: 0, cancelled: 0, pending: 0 };
  for (const todo of todos) counts[todoStatusKind(todo.status)] += 1;
  const active = todos.length - counts.cancelled;
  return { ...counts, total: todos.length, active, percent: active === 0 ? 0 : Math.round((counts.completed / active) * 100) };
}
