// server/routes/recents.ts — the cross-project "recently active" panel.
//
// Every other session route is deliberately single-project (see
// routes/sessions.ts). This one is the exception: the Hub shows recent work
// before a project has been chosen, so it takes a *set* of directories and
// fans out.
//
// Two choices worth knowing about:
//
//   - Invalid directories are DROPPED, not rejected. The client's half of the
//     list comes from browser localStorage, which outlives renames, deletions
//     and moves between machines. Failing the whole request on one stale path
//     would make the panel disappear entirely for the least interesting
//     reason. Every path still goes through requireWorkspaceDirectory, so
//     dropping is a containment decision, never a trust one.
//   - The candidate set is pins plus client history, not every project on
//     disk. Project discovery is capped at 500 directories; fanning out over
//     all of them would cost 1000 upstream calls per poll for a five-row list.

import { Router } from "express";

import { requireWorkspaceDirectory } from "../paths.js";
import { isClaudeSessionId } from "../publicAppUrl.js";
import { ProjectPinStore } from "../projects.js";
import { listSessionsAcross, type SessionSummary } from "../opencode/sessions.js";
import type { OpencodeConfig } from "../opencode/client.js";

/** Minimal read interface so the recents route can resolve Claude sessions. */
export interface ClaudeSessionLookup {
  get(id: string): { id: string; title: string; projectDirectory: string; running: boolean; createdAt: string; updatedAt: string } | undefined;
}

/** Upper bound on directories fanned out to, after dedupe. */
export const RECENT_DIRECTORY_LIMIT = 40;
// Raised from 5 to 25 (issue #44): the client cap in recentSessions.ts moved in lockstep,
// and both panels needed room to actually show that many rows rather than being capped
// here before the client ever sees them.
export const RECENT_SESSION_LIMIT = 25;
/** Match the full Hub list so an older parent can still contextualize a recent child. */
export const RECENT_SESSION_CONTEXT_LIMIT = 100;
/** Upper bound on ids the client may ask to have resolved by name. */
export const RECENT_LOOKUP_LIMIT = 50;

function sessionKey(session: { directory: string; id: string }): string {
  return `${session.directory}\u0000${session.id}`;
}

/** Keep the loaded family around each limited result so the client can render context. */
export function recentSessionContext<T extends { directory: string; id: string; parentID?: string }>(
  pool: T[],
  selected: T[],
): T[] {
  const byKey = new Map(pool.map((session) => [sessionKey(session), session]));
  const children = new Map<string, string[]>();
  for (const session of pool) {
    if (!session.parentID) continue;
    const parentKey = `${session.directory}\u0000${session.parentID}`;
    if (!byKey.has(parentKey)) continue;
    children.set(parentKey, [...(children.get(parentKey) ?? []), sessionKey(session)]);
  }
  const included = new Set(selected.map(sessionKey));
  const pending = [...included];
  while (pending.length > 0) {
    const key = pending.shift();
    if (!key) continue;
    const session = byKey.get(key);
    const related = [
      ...(session?.parentID ? [`${session.directory}\u0000${session.parentID}`] : []),
      ...(children.get(key) ?? []),
    ];
    for (const next of related) {
      if (!byKey.has(next) || included.has(next)) continue;
      included.add(next);
      pending.push(next);
    }
  }
  return pool.filter((session) => included.has(sessionKey(session)));
}

function stringList(value: unknown, limit: number): string[] {
  const raw = typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  return raw.filter((item) => item).slice(0, limit);
}

/**
 * Client history first, then pins.
 *
 * localStorage arrives newest-first, so under RECENT_DIRECTORY_LIMIT the
 * projects most likely to hold recent work survive the cap.
 */
export async function resolveRecentDirectories(
  requested: string[],
  pinned: string[],
  limit = RECENT_DIRECTORY_LIMIT,
): Promise<string[]> {
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [...requested, ...pinned]) {
    if (resolved.length >= limit) break;
    let canonical: string;
    try {
      canonical = await requireWorkspaceDirectory(candidate);
    } catch {
      continue; // Stale browser history must not break the panel.
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    resolved.push(canonical);
  }
  return resolved;
}

export function recentRoutes(config: OpencodeConfig, claudeSessionLookup?: ClaudeSessionLookup, store = new ProjectPinStore()): Router {
  const router = Router();

  router.get("/recent-sessions", async (req, res) => {
    const requested = stringList(req.query.directory, RECENT_DIRECTORY_LIMIT);
    const lookupIDs = new Set(stringList(req.query.session, RECENT_LOOKUP_LIMIT));
    const rawLimit = Number(req.query.limit ?? RECENT_SESSION_LIMIT);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(RECENT_SESSION_LIMIT, Math.max(0, Math.floor(rawLimit)))
      : RECENT_SESSION_LIMIT;

    // A pin store failure degrades the candidate set; it must not 500 a panel
    // the client can still populate from its own history.
    const pinned = await store.read().catch(() => [] as string[]);
    const directories = await resolveRecentDirectories(requested, pinned);
    if (directories.length === 0) {
      res.json({ sessions: [], directories: [] });
      return;
    }

    try {
      const pool = await listSessionsAcross(config, directories, {
        perDirectoryLimit: RECENT_SESSION_CONTEXT_LIMIT,
      });

      // Resolve Claude sessions from the in-process store so notification
      // rows can show running/idle instead of always-unknown (#505).
      if (claudeSessionLookup) {
        for (const id of lookupIDs) {
          if (!isClaudeSessionId(id)) continue;
          const cs = claudeSessionLookup.get(id);
          if (!cs) continue;
          const summary: SessionSummary = {
            id: cs.id,
            title: cs.title,
            directory: cs.projectDirectory,
            childCount: 0,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            createdAt: cs.createdAt,
            updatedAt: cs.updatedAt,
            archived: false,
            running: cs.running,
          };
          pool.push(summary);
        }
      }

      // Two panels, two selections, one fan-out. "Recently active" wants the
      // newest few; "recently opened" wants specific sessions the browser
      // remembers, which are usually NOT the newest. Sending only the newest
      // would leave the opened panel permanently empty.
      const selected = new Map(pool.slice(0, limit).map((session) => [sessionKey(session), session]));
      for (const session of pool) {
        if (lookupIDs.has(session.id)) selected.set(sessionKey(session), session);
      }
      res.json({ sessions: recentSessionContext(pool, [...selected.values()]), directories });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
