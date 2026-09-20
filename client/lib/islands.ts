// client/lib/islands.ts — one place that decides what an island's badge says.
//
// Two independent reasons an island can be unusable, and they read differently
// to the operator, so the UI must not collapse them:
//   - the host does not run the island at all (DCALEON_ISLANDS, or a platform
//     that cannot host it — DSH needs macOS Seatbelt). Nothing in this
//     deployment's settings will change that, so the copy says "unavailable"
//     and carries the server's reason.
//   - the island runs here but its own env is off or incomplete. That is the
//     long-standing "Not configured" state and keeps its wording.

export interface IslandStatus {
  id: string;
  available: boolean;
  reason: string | null;
}

export interface IslandConfigSource {
  dshEnabled: boolean;
  dshConfigured: boolean;
  claudeEnabled: boolean;
  claudeConfigured: boolean;
  /** Absent on an older BFF, which is read as "this host runs every island". */
  islands?: IslandStatus[];
}

export interface IslandAvailability {
  available: boolean;
  /** Badge text. */
  label: string;
  /** Tooltip / detail line. Null when available. */
  reason: string | null;
}

function hostAllows(id: string, config: IslandConfigSource): IslandStatus | null {
  const entry = config.islands?.find((island) => island.id === id);
  if (!entry || entry.available) return null;
  return entry;
}

function envConfigured(id: string, config: IslandConfigSource): boolean {
  if (id === "opencode") return true;
  if (id === "dsh") return config.dshEnabled && config.dshConfigured;
  if (id === "claude") return config.claudeEnabled && config.claudeConfigured;
  return false;
}

export function islandAvailability(id: string, config: IslandConfigSource): IslandAvailability {
  const blocked = hostAllows(id, config);
  if (blocked) return { available: false, label: "Unavailable here", reason: blocked.reason };
  if (!envConfigured(id, config)) return { available: false, label: "Not configured", reason: null };
  return { available: true, label: "Available", reason: null };
}
