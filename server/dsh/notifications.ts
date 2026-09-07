import type { EventEmitter } from "node:events";

import type { DshSession, ExperimentRecord } from "./store.js";

/** Translate terminal local DSH runs to the event vocabulary NotificationService consumes. */
export function publishDshRunEvents(
  bus: Pick<EventEmitter, "emit">,
  session: Pick<DshSession, "id" | "title">,
  directory: string,
  outcome: ExperimentRecord["outcome"],
): void {
  if (outcome === "running") return;
  bus.emit("event", {
    type: "session.updated",
    directory,
    properties: { info: { id: session.id, title: session.title } },
  });
  if (outcome === "completed") {
    bus.emit("event", { type: "session.idle", directory, properties: { sessionID: session.id } });
    return;
  }
  bus.emit("event", {
    type: "session.error",
    directory,
    properties: {
      sessionID: session.id,
      error: outcome === "cancelled"
        ? { name: "MessageAbortedError" }
        : { name: "DshRunFailed", message: "DSH run failed" },
    },
  });
}
