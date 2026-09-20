// server/bindHost.ts — which interfaces the BFF accepts connections on.
//
// This app has no authentication of its own: all ~116 routes under /api are
// open to anyone who can open a socket, and the Claude island hands a session
// the authority `claude` holds in a terminal (server/claude/supervisor.ts —
// there is no Seatbelt wrapper off macOS). So the bind address *is* the
// access-control boundary, and it differs per host:
//
//   - macOS: the operator's own machine, reachable over their tailnet. The
//     phone needs to reach it, so bind every interface. This is the original
//     deployment and nothing about it changes.
//   - Linux: a Coder workspace pod. The pod is a node on the corporate
//     tailnet (verified: tailscale0 / tail8635c.ts.net), so 0.0.0.0 publishes
//     the app to any tailnet peer permitted to route here — bypassing Coder's
//     owner-private port gate entirely. The Coder agent proxies from
//     localhost, so loopback costs nothing and closes that path.
//
// BIND_HOST overrides both. It exists because the default is a judgement about
// the *typical* host, not a security control — an operator who has put a real
// gate in front of the app should be able to widen this without patching. A
// deliberate override is fine; a silent default that publishes a credential-
// bearing shell to a corporate tailnet is not.
export const LOOPBACK = "127.0.0.1";
export const ALL_INTERFACES = "0.0.0.0";

export function chooseBindHost(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const override = environment.BIND_HOST?.trim();
  if (override) return override;
  return platform === "linux" ? LOOPBACK : ALL_INTERFACES;
}

/** Why this bind was chosen, for the startup line — a silent bind is hard to diagnose. */
export function describeBindHost(host: string, environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.BIND_HOST?.trim()) return `${host} (BIND_HOST)`;
  return host === LOOPBACK ? `${host} (loopback only; reach it through the Coder port URL)` : host;
}
