// client/lib/notificationGroups.ts
//
// Groups notification records by the session that produced them, and resolves
// the in-app route a row or header links to.
//
// This is presentation only. Unlike the two noise filters it is never sent to
// the server: it changes neither which records exist nor the unresolved count,
// so the badge cannot disagree with the rows however it is set.
//
// Identity is the session id, never the title. `sessionTitle` is snapshotted at
// append time (server/notifications/history.ts), so one session contributes
// several different titles across its life as it is renamed, and two unrelated
// sessions can easily share one. Keying on the title would therefore both split
// a session and merge strangers.

import type { NotificationRecord, NotifyEvent } from "./api.js";

/** Bucket for records the server never attached a session to. Always sorts last. */
export const NO_SESSION_KEY = "__no-session__";
export const NO_SESSION_LABEL = "No session";

/** Shown when a session is known but never had a title we could snapshot. */
export const UNTITLED_SESSION_LABEL = "Untitled session";

/**
 * Kind order, most blocking first.
 *
 * Still the ordering every aggregate summary of a group uses — the Hub's
 * attention band prints these as text — even though the notification group
 * header no longer renders them as a chip strip (issue #288). Leading with the
 * kind that blocks an agent keeps the first thing said about a group the reason
 * to open it.
 */
export const CHIP_ORDER: readonly NotifyEvent[] = [
  "permission",
  "question",
  "parked",
  "error",
  "abort",
  "idle",
];

/**
 * Kinds that mean an agent is stopped, waiting for a human.
 *
 * This is the safety property AGENTS.md decision 23 used to hang on the chip
 * strip: groups ship folded, so a header showing nothing but a count could hide
 * an unanswered permission behind a number. The strip is gone; this list is
 * what replaces it, reduced to the single question the folded header has to
 * answer — is something in here waiting on me?
 *
 * `question` is included alongside `permission` and `parked` even though issue
 * #288 named only the latter two. An unanswered question stalls a turn exactly
 * as an unanswered permission does, and the two failure directions are not
 * symmetric: marking a group that turns out not to need you costs a glance,
 * while failing to mark one that does is precisely the hiding this indicator
 * exists to prevent. `error`, `abort` and `idle` are terminal — the work has
 * already stopped and nothing is waiting on an answer — so they do not mark.
 */
export const BLOCKING_KINDS: readonly NotifyEvent[] = ["permission", "question", "parked"];

/**
 * Whether the group holds unresolved work that is waiting on a human.
 *
 * Resolved records are excluded deliberately: the marker's claim is "something
 * in here still needs you", and a permission the user already dealt with does
 * not. Without that filter the Resolved section — which groups too — would
 * carry a permanent "needs you" on every archived request.
 */
export function blockingFor(records: readonly NotificationRecord[]): boolean {
  return records.some(
    (record) => record.resolvedAt === undefined && BLOCKING_KINDS.includes(record.kind),
  );
}

/**
 * The in-app route for the session a record came from.
 *
 * Deliberately built here rather than reusing `record.click`. That field is the
 * link posted to ntfy and Web Push, so it is an absolute URL to PUBLIC_APP_URL
 * and is `undefined` whenever that variable is unset (server/publicAppUrl.ts) —
 * which would leave every in-app row unclickable on a deployment that never
 * configured outbound delivery. The route is the same one `conversationUrl`
 * builds, so this changes the destination for nobody; it only stops an
 * outbound-delivery setting from deciding whether the UI can navigate, and
 * keeps the click inside the SPA instead of forcing a cross-origin reload.
 */
export function sessionRoute(record: Pick<NotificationRecord, "sessionID" | "directory">): string | undefined {
  if (!record.sessionID) return undefined;
  // Claude runtime sessions (`claude-<uuid>`, minted in server/claude/store.ts)
  // have their own surface and no directory scope; server/publicAppUrl.ts
  // applies the same discriminator for the outbound click URL.
  if (record.sessionID.startsWith("claude-")) return `/claude/sessions/${encodeURIComponent(record.sessionID)}`;
  const query = record.directory ? `?${new URLSearchParams({ directory: record.directory })}` : "";
  return `/sessions/${encodeURIComponent(record.sessionID)}${query}`;
}

export interface SessionGroupChip {
  kind: NotifyEvent;
  count: number;
}

export interface SessionGroup {
  /** Stable identity — a session id, or NO_SESSION_KEY. Never the title. */
  key: string;
  /** Header text, taken from the newest record that carries a title. */
  label: string;
  /** Untruncated session title for the tooltip, when one was ever snapshotted. */
  title?: string;
  /** In-app route to the session. Present whenever the group has a session id,
   *  so a folded group is still one click from the work it describes. */
  route?: string;
  /** Newest first. */
  records: NotificationRecord[];
  chips: SessionGroupChip[];
  /** True when an unresolved record in this group is waiting on a human. */
  blocking: boolean;
  /** Timestamp of the newest record; the group ordering key. */
  latest: number;
}

function groupKey(record: NotificationRecord): string {
  return record.sessionID ?? NO_SESSION_KEY;
}

/**
 * Tally kinds present in the group, in blocking-first order.
 *
 * Kinds absent from the group are omitted rather than rendered as zero: a
 * folded group has one line to spend and empty categories are not news.
 */
function chipsFor(records: NotificationRecord[]): SessionGroupChip[] {
  const counts = new Map<NotifyEvent, number>();
  for (const record of records) counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1);
  return CHIP_ORDER.filter((kind) => counts.has(kind)).map((kind) => ({
    kind,
    count: counts.get(kind) ?? 0,
  }));
}

/**
 * Group records by session, newest group first.
 *
 * Input order is not trusted — records are sorted by timestamp within each
 * group — but the sort is stable, so records sharing a timestamp keep the
 * order the server returned them in.
 */
export function groupBySession(records: NotificationRecord[]): SessionGroup[] {
  const buckets = new Map<string, NotificationRecord[]>();
  for (const record of records) {
    const key = groupKey(record);
    const existing = buckets.get(key);
    if (existing) existing.push(record);
    else buckets.set(key, [record]);
  }

  const groups = [...buckets.entries()].map(([key, bucket]) => {
    const ordered = [...bucket].sort((left, right) => right.at - left.at);
    const newest = ordered[0];
    // The label follows the row's own precedence (session title, then the
    // outbound title) so a group header never says less than the row it
    // replaced.
    const titled = ordered.find((record) => record.sessionTitle !== undefined);
    const label =
      key === NO_SESSION_KEY
        ? NO_SESSION_LABEL
        : (titled?.sessionTitle || newest?.title || UNTITLED_SESSION_LABEL);
    const route = newest ? sessionRoute(newest) : undefined;
    return {
      key,
      label,
      ...(key !== NO_SESSION_KEY && titled?.sessionTitle ? { title: titled.sessionTitle } : {}),
      ...(route ? { route } : {}),
      records: ordered,
      chips: chipsFor(ordered),
      blocking: blockingFor(ordered),
      latest: newest?.at ?? 0,
    } satisfies SessionGroup;
  });

  return groups.sort((left, right) => {
    // Records with no session are structural leftovers rather than work, so
    // they sit below every real session no matter how recent they are.
    if (left.key === NO_SESSION_KEY) return 1;
    if (right.key === NO_SESSION_KEY) return -1;
    return right.latest - left.latest;
  });
}
