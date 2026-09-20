// server/islands.ts — which runtime islands this host is allowed to run.
//
// Two switches, not one, because they answer different questions (cloud
// deployment decision):
//   - `process.platform` decides what an island *can* do here. DSH is hard
//     macOS-only (`server/dsh/config.ts` — "DSH V1 requires macOS Seatbelt"),
//     so no env var may claim otherwise. An env var that disagrees with the
//     OS is a footgun.
//   - `DCALEON_ISLANDS` decides what the operator *wants* this host to run.
//     That is a genuine preference — the cloud box runs Claude only even
//     though OpenCode would work there — so it gets a real env var.
//
// Availability is the AND of the two, and every unavailable island carries a
// reason string. The point of the phase is that a host without an island says
// "unavailable" instead of failing connections at it.

export type IslandId = "opencode" | "dsh" | "claude";

export const ISLAND_IDS: readonly IslandId[] = ["opencode", "dsh", "claude"];

export interface IslandAvailability {
  id: IslandId;
  /** The operator listed this island in DCALEON_ISLANDS (or left the var unset). */
  selected: boolean;
  /** This platform can host the island at all. */
  supported: boolean;
  /** `selected && supported` — the only field a caller normally needs. */
  available: boolean;
  /** Why not, stated for the UI. Null when available. */
  reason: string | null;
}

export interface IslandConfig {
  /** Parse failures, mirroring the `errors` convention in the DSH/Claude configs. */
  errors: string[];
  opencode: IslandAvailability;
  dsh: IslandAvailability;
  claude: IslandAvailability;
}

function isIslandId(value: string): value is IslandId {
  return (ISLAND_IDS as readonly string[]).includes(value);
}

/**
 * Why a platform cannot host an island, or null when it can.
 *
 * Only DSH is gated today. The Claude island is not Seatbelt-wrapped
 * (`server/claude/supervisor.ts`), so it ports to Linux unchanged, and
 * OpenCode is a Bun binary that ships for both.
 */
function platformBlocker(id: IslandId, platform: NodeJS.Platform): string | null {
  if (id === "dsh" && platform !== "darwin") {
    return "Requires macOS — the DSH bridge runs under Seatbelt, which has no Linux equivalent";
  }
  return null;
}

/**
 * `DCALEON_ISLANDS` is a comma-separated allowlist. Unset or blank means every
 * island, so an existing macOS deployment that never sets it is unchanged.
 */
export function readIslandConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): IslandConfig {
  const errors: string[] = [];
  const raw = (env.DCALEON_ISLANDS || "").trim();
  const requested = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  const unknown = requested.filter((entry) => !isIslandId(entry));
  if (unknown.length > 0) {
    errors.push(`DCALEON_ISLANDS names unknown islands: ${unknown.join(", ")} (known: ${ISLAND_IDS.join(", ")})`);
  }

  const known = requested.filter(isIslandId);
  if (raw.length > 0 && known.length === 0) {
    errors.push("DCALEON_ISLANDS was set but selected no known island");
  }

  // A malformed value must not silently disable everything: fall back to the
  // unset meaning (all islands) and surface the error instead.
  const selectAll = known.length === 0;
  const selected = new Set<IslandId>(selectAll ? ISLAND_IDS : known);

  const describe = (id: IslandId): IslandAvailability => {
    const isSelected = selected.has(id);
    const blocker = platformBlocker(id, platform);
    const supported = blocker === null;
    const available = isSelected && supported;
    const reason = available
      ? null
      : !supported
        ? blocker
        : `Not enabled on this host — add "${id}" to DCALEON_ISLANDS to turn it on`;
    return { id, selected: isSelected, supported, available, reason };
  };

  return { errors, opencode: describe("opencode"), dsh: describe("dsh"), claude: describe("claude") };
}

/** The wire shape the browser reads from `/api/app-config`. */
export function publicIslands(config: IslandConfig): { id: IslandId; available: boolean; reason: string | null }[] {
  return ISLAND_IDS.map((id) => ({ id, available: config[id].available, reason: config[id].reason }));
}
