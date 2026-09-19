const e=`# Research

The investigation that produced this repo. Open the HTML files in a browser.

| File | What it is |
|---|---|
| \`opencode-build-plan.html\` | **The plan being executed.** 10 phases, the OpenCode \`Part\` → \`TranscriptEvent\` mapping, endpoint cheat sheet, effort estimates. Authoritative where the others disagree. |
| \`opencode-migration-decision.html\` | Comparison of three paths (plugins+cmux · custom UI · adopt OpenChamber) and the full migration risk register R1–R13. |
| \`opencode-vs-openhands-report.html\` | The original feature-gap analysis: what the OpenHands runner had, the five OpenCode customization tiers, cmux Dock/sidebar limits, the desktop app. |

## Method

Five parallel research agents, plus direct inspection of a live server:

- **Live API probe** — \`GET /doc\` on a running instance returned OpenAPI 3.1 with
  162 paths / 188 operations / 472 schemas. The published docs describe ~60. Real
  response payloads were captured for MCP status, todos, and cost/tokens.
- **SDK type inventory** — 16 data-availability questions answered against the
  installed \`@opencode-ai/sdk\`, which is how the stale-type traps were found.
- **Predecessor route map** — all 58 BFF routes of \`custom-dca-ide-with-openhands\`
  classified by dependency (proxy / local / third-party / derived), producing a
  per-page reuse estimate.
- **Ecosystem survey** — eight third-party OpenCode UIs scored against 12 surfaces.
- **Operational audit** — SQLite schema, \`dbstat\`, binary string analysis, and live
  endpoint verification, which is where the isolation and auto-resume gaps surfaced.

## Load-bearing conclusions

1. **One server hosts every project** (\`?directory=\` scoping) and **work continues
   when every client disconnects** (\`prompt_async\`) — the predecessor's topology
   survives intact.
2. **~74% of the transcript stack was backend-neutral**, so the port is a ~363-line
   adapter rewrite rather than a rebuild. That is the single reason this migration is
   cheap, and it is only true because the renderer never touched raw event shapes.
3. **No container isolation and no auto-resume.** Both accepted deliberately — see
   decisions #3 and #5 in \`AGENTS.md\`.

> These documents are a snapshot of the decision, not living docs. \`AGENTS.md\` is the
> living record; where it and these disagree, \`AGENTS.md\` wins.
`;export{e as default};
