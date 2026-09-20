const e=`# Hosting dcaleon

Where to run dcaleon, and what each choice costs. This page is the decision;
[\`DEPLOYMENT.md\`](../DEPLOYMENT.md) is the runbook once the decision is made,
and [\`deploy/README.md\`](../deploy/README.md) is the operational detail behind it.

The question is not really "which machine has spare CPU". dcaleon supervises
agent CLIs that hold your model credentials, and a Build turn holds the Unix
authority of the user running it. Choosing a host is therefore choosing **who
else can reach that authority** — and, on a machine somebody else administers,
the honest answer is: they can. Everything below follows from that.

## The three shapes

| | Your laptop | A workspace someone else operates | A personal cloud VM |
|---|---|---|---|
| Always on | No — sleeps with the lid | Yes, until the workspace is stopped | Yes |
| Who can root the box | You | You *and* the platform team | You |
| Supervisor | launchd | tmux | tmux |
| Survives a host restart | Yes (\`RunAtLoad\`) | **No** — rerun \`service:install\` | No, unless you add an init unit |
| Islands available | OpenCode, Claude, DSH | Claude (OpenCode optional) | Claude, OpenCode |
| Safe to hold a personal API key | Yes | **No** — see [Credentials on a host you do not own](#credentials-on-a-host-you-do-not-own) | Yes |
| Reachable from a phone | Tailscale Serve | Owner-private port URL | Tailscale Serve |

Running more than one host at a time is fine and is the current arrangement:
company work on the workspace, personal work on the personal VM. What is not
free is that each host has its own \`PUBLIC_APP_URL\`, its own VAPID subject, and
therefore its own Web Push subscriptions — a phone subscribed to one is not
subscribed to the other.

## On a local machine

The default, and the only host where all three islands exist. DSH needs macOS
Seatbelt and cannot run anywhere else; OpenCode is a separate long-lived process
you already have.

\`\`\`bash
cp .env.example .env
chmod 600 .env
npm ci
npm run service:install -- --port=3210
\`\`\`

launchd holds the process with \`KeepAlive\`, and \`RunAtLoad\` brings it back after
a reboot — the one durability property no other host here gets for free.

Point \`OPENCODE_URL\` at the OpenCode server that is already running. The BFF
connects to it and never starts a second one, so an application upgrade does not
interrupt an OpenCode turn.

To reach it from a phone, proxy the supervised port and set the resulting origin
as \`PUBLIC_APP_URL\`:

\`\`\`bash
tailscale serve --bg http://127.0.0.1:3210
tailscale serve status
\`\`\`

**The cost is the obvious one.** A laptop that sleeps is a host that stops
answering, and every notification it would have sent arrives whenever the lid
next opens. If that is the problem you are solving, the rest of this page is the
answer to it.

## On a cloud host you do not own

A hosted development workspace is usually one container, built from an image the
platform controls and scheduled by something that can stop it. That shape
decides the supervision: such an image typically already runs its own agent
session under tmux, the workspace user cannot bootstrap into systemd, and the
container's restart policy generally does not bring workloads back anyway. So
tmux is what \`service:install\` uses on Linux.

What that means in practice, stated plainly: **a stopped workspace comes back
with no tmux sessions and nothing restarts dcaleon for you.** Rerun
\`npm run service:install -- --port=3210\` after every restart. Platforms also
reap workspaces left stopped for long enough, deleting the volume with them;
that is the one loss no care inside the box prevents.

Durable state belongs on the home volume — \`.state/\` in the checkout, and
\`CLAUDE_STATE_DIR\` for Claude's own worktrees. Nothing durable belongs in
\`/tmp\`, which does not survive the container.

### Ports are not a free choice

Reachability is usually free: platforms of this kind publish each listening port
at a per-port hostname that authenticates the workspace owner before proxying.
Set that origin as \`PUBLIC_APP_URL\` and rerun \`service:install\`.

**Check what the workspace template already publishes, and how.** A template can
declare a port as publicly shared, which means reachable with no authentication
at all — and templates routinely do that for the ports a development stack uses
by convention, \`3000\` among them. Pick a port the template says nothing about;
\`3210\` is the supervised default for exactly this reason. Do not raise a port's
sharing to make a link easier to hand out: the owner-private URL is already a
real SSO gate, and what sits behind it is a runtime with your shell.

VPN reachability is not authorization either. The workspace is typically a node
on a network the platform operates, so a BFF bound to \`0.0.0.0\` is reachable
around the owner gate entirely; on Linux the BFF now binds loopback for exactly
that reason.

### Credentials on a host you do not own

The Claude island is **not** Seatbelt-wrapped off macOS, so a \`bypassPermissions\`
Build turn holds its Unix user's full authority with no OS backstop. Run the BFF
as an unprivileged user, and give any process that does hold a key its own Unix
user with a home the agent user cannot read.

That mitigates the agent. It does not mitigate the platform. A model API key has
to exist in plaintext in the memory of some process on hardware the platform
team administers, so no storage mechanism hides it from them — not a
\`0600\` \`.env\`, and not a server-side secret store, however genuinely write-only
its API is. Detection does not close the gap either, because direct cluster
access bypasses the workspace's own audit trail.

So the workable answers are the two that involve no personal key at all:

- **Credentials the platform already grants the workspace**, such as a cloud
  model endpoint reached through the workload's own role. Nothing is stored,
  rotation is somebody else's problem, and every call is attributable.
- **Keep the key on a host you do own**, and accept that the island which needs
  it lives there rather than here.

This is why the workspace deployment normally sets \`DCALEON_ISLANDS=claude\`:
Claude authenticates from its own credential store on the host, so the BFF never
holds a key for it. The BFF then starts without an event bus and answers every
OpenCode route with a \`503\` naming the reason, rather than failing connections
at an upstream that was never there.

## On a personal cloud VM

An always-on host you administer: the shape that has no platform-team caveat, at
the price of being the one who patches it.

Provisioning with cloud-init is straightforward — a user, Git, Node, Tailscale —
but two details are load-bearing and easy to get wrong:

- **Use a single-use, short-expiry Tailscale auth key.** Cloud-init user-data
  stays readable from the instance metadata service for the life of the
  instance, so a reusable key pasted there is a standing credential leak.
- **Accept traffic on the Tailscale interface explicitly**
  (\`iptables -I INPUT -i tailscale0 -j ACCEPT\`, then persist it). Without it,
  \`tailscale status\` cheerfully reports "connected" while every packet dies in
  the \`INPUT\` chain — a failure that looks like a Tailscale problem and is not.

Supervision is tmux here too, so the same "does not survive a reboot" caveat
applies unless you add an init unit yourself. Being root is what makes the
credential mitigations above actually available.

## Which login works where

dcaleon does not broker model authentication for anything. Each runtime
authenticates itself, which is why the login story differs per island rather
than per host.

| Runtime | How it authenticates | Where that works | Stated restriction |
|---|---|---|---|
| Claude | \`claude\` signs in on the host; the store is the macOS Keychain on darwin and \`$CLAUDE_CONFIG_DIR/.credentials.json\` (default \`~/.claude\`, mode \`0600\`) elsewhere | Any host, macOS or Linux | Subscription OAuth is restricted to first-party clients, so it cannot be reused to authenticate a third-party app. Sign in on the host instead |
| OpenCode | A separate server process holding its own provider credentials; dcaleon reaches it over \`OPENCODE_URL\` | Any host where you run that server | Optional HTTP Basic auth via \`OPENCODE_SERVER_PASSWORD\` (username defaults to \`opencode\`). Unset means an unsecured server — bind it to loopback |
| DSH | Provider keys cross the bridge through a fixed allowlist (\`DEEPSEEK_API_KEY\`, \`OPENAI_API_KEY\`, \`ANTHROPIC_API_KEY\`) | **macOS only** — the bridge requires Seatbelt | Keys live only in mode-\`0600\` environment files; never accepted from browser input |
| Codex and other agent CLIs | Not an island. dcaleon does not launch or supervise them | Anywhere you run them yourself | Outside dcaleon's surface entirely; their own sign-in restrictions apply unchanged |

Two things about the Claude lane are deliberate and worth not re-litigating:

**Do not set \`CLAUDE_CODE_OAUTH_TOKEN\` or \`ANTHROPIC_API_KEY\` for the BFF.** The
supervisor's \`SAFE_ENV\` allowlist strips both on the way into the child process.
That is the design, not an oversight: the binary authenticates from its own
store and the BFF never brokers auth, so there is no credential in the BFF to
leak in the first place. Run \`claude\` on the host and use \`/login\`.

**Confirm the seat before enabling the lane.** Enabling fails closed unless the
CLI version is pinned, the binary path is absolute, and every preset and
workspace is allowlisted — but nothing in code can check *which* subscription
the host's \`claude\` is signed in to, and usage bills to that seat. Verify that a
headless \`claude -p\` answers under the intended account first.

### Reading credential health

\`/api/health\` reports \`claude.credentials\` as one of \`ok\`, \`stale\`, \`missing\` or
\`unchecked\`. Only \`missing\` is a problem: it means every turn will fail until
someone signs in on the host. \`stale\` is normal on an idle box — the access
token lives about eight hours and the CLI refreshes it lazily, when a turn next
needs one. Alerting on expiry itself produces a permanent alarm and teaches you
to ignore it.

On a headless host, wire that alert somewhere you will actually see it. The BFF
pushes on the transition into \`missing\` and again on recovery, so it needs Web
Push configured — see [\`docs/notifications.md\`](notifications.md).

## Next

- [\`DEPLOYMENT.md\`](../DEPLOYMENT.md) — the update runbook, identical on both
  supervised hosts, plus the traps around \`npm ci\` and worktrees.
- [\`deploy/README.md\`](../deploy/README.md) — supervision design, failure modes,
  first-time setup, remote access.
- [\`docs/claude-runtime.md\`](claude-runtime.md) — what the Claude island is and
  where its boundaries are.
`;export{e as default};
