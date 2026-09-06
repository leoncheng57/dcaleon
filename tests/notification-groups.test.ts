import { describe, expect, it } from "vitest";

import {
  BLOCKING_KINDS,
  CHIP_ORDER,
  NO_SESSION_KEY,
  NO_SESSION_LABEL,
  UNTITLED_SESSION_LABEL,
  groupBySession,
  sessionRoute,
} from "../client/lib/notificationGroups.js";
import type { NotificationRecord, NotifyEvent } from "../client/lib/api.js";

function record(overrides: Partial<NotificationRecord> & { id: string; at: number }): NotificationRecord {
  return {
    kind: "idle" as NotifyEvent,
    title: "OpenCode finished",
    body: "",
    delivery: { ntfy: "off", desktop: "off" },
    ...overrides,
  };
}

describe("notification session grouping", () => {
  it("keys groups by session id, never by the snapshotted title", () => {
    // Titles are snapshotted at append time, so one session contributes
    // several as it is renamed and two unrelated sessions can share one.
    // Keying on the title would both split a session and merge strangers.
    const groups = groupBySession([
      record({ id: "a", at: 30, sessionID: "ses_1", sessionTitle: "Renamed later" }),
      record({ id: "b", at: 20, sessionID: "ses_1", sessionTitle: "Original name" }),
      record({ id: "c", at: 10, sessionID: "ses_2", sessionTitle: "Renamed later" }),
    ]);

    expect(groups.map((group) => group.key)).toEqual(["ses_1", "ses_2"]);
    expect(groups[0]?.records.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(groups[1]?.records.map((entry) => entry.id)).toEqual(["c"]);
  });

  it("labels a group from the newest record that carries a title", () => {
    const groups = groupBySession([
      record({ id: "a", at: 30, sessionID: "ses_1", sessionTitle: "Newest title" }),
      record({ id: "b", at: 20, sessionID: "ses_1", sessionTitle: "Older title" }),
    ]);

    expect(groups[0]?.label).toBe("Newest title");
    // Untruncated: truncation is the component's business, and the tooltip
    // needs the whole thing.
    expect(groups[0]?.title).toBe("Newest title");
  });

  it("falls back through the outbound title before admitting it has no name", () => {
    const [titled, untitled] = groupBySession([
      record({ id: "a", at: 20, sessionID: "ses_1", title: "OpenCode needs permission" }),
      record({ id: "b", at: 10, sessionID: "ses_2", title: "" }),
    ]);

    expect(titled?.label).toBe("OpenCode needs permission");
    expect(titled?.title).toBeUndefined();
    expect(untitled?.label).toBe(UNTITLED_SESSION_LABEL);
  });

  it("sorts groups by their newest record, with sessionless records always last", () => {
    // A record with no session is a structural leftover rather than a piece of
    // work, so it sits below every real session however recent it is.
    const groups = groupBySession([
      record({ id: "orphan", at: 99 }),
      record({ id: "a", at: 30, sessionID: "ses_old" }),
      record({ id: "b", at: 50, sessionID: "ses_new" }),
    ]);

    expect(groups.map((group) => group.key)).toEqual(["ses_new", "ses_old", NO_SESSION_KEY]);
    expect(groups.at(-1)?.label).toBe(NO_SESSION_LABEL);
    expect(groups.at(-1)?.title).toBeUndefined();
  });

  it("orders records newest first regardless of input order, stably", () => {
    const groups = groupBySession([
      record({ id: "middle", at: 20, sessionID: "ses_1" }),
      record({ id: "oldest", at: 10, sessionID: "ses_1" }),
      record({ id: "tie-first", at: 30, sessionID: "ses_1" }),
      record({ id: "tie-second", at: 30, sessionID: "ses_1" }),
    ]);

    expect(groups[0]?.records.map((entry) => entry.id)).toEqual([
      "tie-first",
      "tie-second",
      "middle",
      "oldest",
    ]);
    expect(groups[0]?.latest).toBe(30);
  });

  it("tallies chips blocking-first, omitting absent kinds", () => {
    // The group header no longer renders these as a strip (issue #288), but
    // they remain the aggregate summary the Hub's attention band prints, and
    // the kind that blocks an agent still has to come first.
    const groups = groupBySession([
      record({ id: "a", at: 40, sessionID: "ses_1", kind: "idle" }),
      record({ id: "b", at: 30, sessionID: "ses_1", kind: "idle" }),
      record({ id: "c", at: 20, sessionID: "ses_1", kind: "permission" }),
      record({ id: "d", at: 10, sessionID: "ses_1", kind: "parked" }),
    ]);

    expect(groups[0]?.chips).toEqual([
      { kind: "permission", count: 1 },
      { kind: "parked", count: 1 },
      { kind: "idle", count: 2 },
    ]);
  });

  it("ranks every notify event so no kind can fall out of the chip strip", () => {
    const groups = groupBySession(
      CHIP_ORDER.map((kind, index) => record({ id: kind, at: index, sessionID: "ses_1", kind })),
    );

    expect(groups[0]?.chips.map((chip) => chip.kind)).toEqual([...CHIP_ORDER]);
    expect(groups[0]?.chips).toHaveLength(CHIP_ORDER.length);
  });

  describe("the folded header's blocking marker", () => {
    // Groups ship folded, so this flag is the whole of what stops a collapsed
    // header hiding an unanswered permission behind a count. It replaced the
    // chip strip in issue #288; AGENTS.md decision 23 records the swap.
    it("marks a group holding unresolved work that is waiting on a human", () => {
      for (const kind of BLOCKING_KINDS) {
        const [group] = groupBySession([record({ id: "a", at: 10, sessionID: "ses_1", kind })]);
        expect(group?.blocking, `${kind} should mark`).toBe(true);
      }
    });

    it("leaves terminal kinds unmarked, so the marker's presence still means something", () => {
      // error/abort/idle describe work that already stopped. Nothing is
      // waiting on an answer, and an indicator that is always on says nothing.
      for (const kind of CHIP_ORDER.filter((entry) => !BLOCKING_KINDS.includes(entry))) {
        const [group] = groupBySession([record({ id: "a", at: 10, sessionID: "ses_1", kind })]);
        expect(group?.blocking, `${kind} should not mark`).toBe(false);
      }
    });

    it("ignores resolved records, so the Resolved section never claims it needs you", () => {
      const [group] = groupBySession([
        record({ id: "a", at: 20, sessionID: "ses_1", kind: "permission", resolvedAt: 25, resolvedBy: "checked" }),
        record({ id: "b", at: 10, sessionID: "ses_1", kind: "idle" }),
      ]);

      expect(group?.blocking).toBe(false);
      // The chips still tally it: the strip's descendants describe what is in
      // the group, while the marker describes what is still owed.
      expect(group?.chips.map((chip) => chip.kind)).toEqual(["permission", "idle"]);
    });

    it("marks a mixed group on the strength of its one unresolved blocker", () => {
      const [group] = groupBySession([
        record({ id: "a", at: 30, sessionID: "ses_1", kind: "idle" }),
        record({ id: "b", at: 20, sessionID: "ses_1", kind: "permission", resolvedAt: 25 }),
        record({ id: "c", at: 10, sessionID: "ses_1", kind: "question" }),
      ]);

      expect(group?.blocking).toBe(true);
    });
  });

  it("hoists an in-app session route onto the group so rows stop repeating it", () => {
    const groups = groupBySession([
      record({ id: "a", at: 30, sessionID: "ses_1", directory: "/srv/work" }),
      record({ id: "b", at: 20, sessionID: "ses_1", directory: "/srv/work" }),
    ]);

    expect(groups[0]?.route).toBe("/sessions/ses_1?directory=%2Fsrv%2Fwork");
  });

  it("gives a sessionless group no route rather than a dead link", () => {
    expect(groupBySession([record({ id: "orphan", at: 10 })])[0]?.route).toBeUndefined();
  });
});

describe("notification session route", () => {
  it("targets the in-app conversation route, directory included", () => {
    expect(sessionRoute({ sessionID: "ses_1", directory: "/srv/my project" })).toBe(
      "/sessions/ses_1?directory=%2Fsrv%2Fmy+project",
    );
  });

  it("still links a record whose directory was never recorded", () => {
    expect(sessionRoute({ sessionID: "ses_1" })).toBe("/sessions/ses_1");
    // Claude runtime records route to the Claude surface, never the OpenCode one.
    expect(sessionRoute({ sessionID: "claude-0f3c", directory: "/srv/work" })).toBe("/claude/sessions/claude-0f3c");
  });

  it("does not depend on the outbound click URL, which needs PUBLIC_APP_URL", () => {
    // record.click is the ntfy/Web Push link and is undefined whenever
    // PUBLIC_APP_URL is unset. Deriving the route from the session id instead
    // is what keeps in-app rows clickable on a deployment that never
    // configured outbound delivery.
    expect(sessionRoute({ sessionID: "ses_1", directory: "/srv/work" })).toBeDefined();
  });

  it("has nothing to link when the record names no session", () => {
    expect(sessionRoute({})).toBeUndefined();
    expect(sessionRoute({ directory: "/srv/work" })).toBeUndefined();
  });

  it("returns nothing for an empty history rather than an empty bucket", () => {
    expect(groupBySession([])).toEqual([]);
  });
});
