import type { EventEmitter } from "node:events";
import type { OpencodeEvent } from "../opencode/events.js";
import type { BrowserManager } from "./manager.js";

/** The global bus includes deletions originating outside this browser client. */
export function bindBrowserSessionLifecycle(bus: EventEmitter, manager: BrowserManager): () => void {
  const onEvent = (event: OpencodeEvent) => {
    if (event.type !== "session.deleted") return;
    const info = event.properties.info as { id?: unknown } | undefined;
    if (typeof info?.id === "string") {
      void manager.close(info.id).catch((error: unknown) => console.warn("[browser] session cleanup", error));
    }
  };
  bus.on("event", onEvent);
  return () => { bus.off("event", onEvent); };
}
