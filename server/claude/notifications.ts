import type { EventEmitter } from "node:events";

import type { ClaudeRunRecord, ClaudeSession } from "./store.js";

/**
 * Tell the notification lane that a Claude turn ended.
 *
 * The NotificationService only listens to the shared OpenCode event bus, so a
 * Claude run is translated into the two upstream events it already
 * understands. `session.updated` goes first: the service reads `info` to
 * remember the session as a root (never a sub-agent) with its title, which is
 * what lets the delivery path skip the OpenCode metadata lookup — a lookup
 * that would otherwise ask the OpenCode server about a session it has never
 * heard of. Then the terminal event: `session.idle` for a finished turn,
 * `session.error` for a failed one, and the abort shape for a cancel so a
 * Stop is reported exactly like an OpenCode Stop is.
 *
 * `directory` is the session's cwd. It keys the service's dedupe and abort
 * windows and scopes the in-app row; it is never used to reach the filesystem.
 */
export function publishClaudeRunEvents(
  bus: Pick<EventEmitter, "emit">,
  session: Pick<ClaudeSession, "id" | "title" | "directory">,
  outcome: ClaudeRunRecord["outcome"],
): void {
  if (outcome === "running") return;
  bus.emit("event", {
    type: "session.updated",
    directory: session.directory,
    properties: { info: { id: session.id, title: session.title } },
  });
  if (outcome === "completed") {
    bus.emit("event", { type: "session.idle", directory: session.directory, properties: { sessionID: session.id } });
    return;
  }
  bus.emit("event", {
    type: "session.error",
    directory: session.directory,
    properties: {
      sessionID: session.id,
      error: outcome === "cancelled" ? { name: "MessageAbortedError" } : { name: "ClaudeRunFailed", message: "Claude run failed" },
    },
  });
}
