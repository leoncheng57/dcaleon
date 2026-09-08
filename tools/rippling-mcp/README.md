# rippling-mcp

Read-only MCP server over the [Rippling REST API](https://developer.rippling.com/documentation/rest-api). 12 tools covering workers, org structure, leave, and account metadata.

Runs TypeScript directly on Node 22+ via `--experimental-strip-types` — no build step.

This is a standalone tool that happens to live in this repo. It has its own
`package.json` and dependency tree, and no root tsconfig, Vitest, or build script
covers it — so `npm run typecheck` and `npm test` at the repo root neither check nor
break it. Run its own `npm run typecheck` from this directory instead.

## Setup

1. Generate an API token in the Rippling admin console ([docs](https://developer.rippling.com/documentation/rest-api/guides/api-tokens)). Grant read scope for the resources you want: `workers`, `departments`, `teams`, `groups`, `leave_requests`, `companies`, `custom_fields`.

2. Install:
   ```bash
   cd tools/rippling-mcp && npm install
   ```

3. Register with your MCP client. For OpenCode (`~/.config/opencode/opencode.jsonc`):
   ```jsonc
   "mcpServers": {
     "rippling": {
       "command": "node",
       "args": ["--experimental-strip-types", "/absolute/path/to/rippling-mcp/src/server.ts"],
       "env": { "RIPPLING_API_TOKEN": "your-token" }
     }
   }
   ```

   For Claude Code:
   ```bash
   claude mcp add rippling --scope user \
     --env RIPPLING_API_TOKEN=your-token \
     -- node --experimental-strip-types /absolute/path/to/rippling-mcp/src/server.ts
   ```

## Tools

| Tool | Rippling endpoint |
|---|---|
| `list_workers` | `GET /workers` — filter by department, team, or work location |
| `get_worker` | `GET /workers/:id` |
| `search_workers` | `GET /workers` + local name/email filter |
| `list_departments` | `GET /departments` |
| `get_department` | `GET /departments/:id` |
| `list_teams` | `GET /teams` |
| `list_groups` | `GET /groups` |
| `list_leave_requests` | `GET /leave_requests` — filter by worker |
| `list_companies` | `GET /companies` |
| `list_work_locations` | `GET /work_locations` |
| `list_levels` | `GET /levels` |
| `list_custom_fields` | `GET /custom_fields` |

All tools are annotated `readOnlyHint` — nothing here writes to Rippling.

## Configuration

| Variable | Required | Default |
|---|---|---|
| `RIPPLING_API_TOKEN` | yes | — |
| `RIPPLING_BASE_URL` | no | `https://rest.ripplingapis.com` |

Point `RIPPLING_BASE_URL` at `https://rest.ripplingsandboxapis.com` to test against the sandbox.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run inspect     # MCP Inspector UI
```

Smoke-test the tool list without a real token:

```bash
{ printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"s","version":"0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  sleep 1
} | RIPPLING_API_TOKEN=x node --experimental-strip-types src/server.ts | tail -1
```

## Notes

- **Pagination** is handled internally (100 per page, capped at 1000 records) so tools return a flat array.
- **Rate limits**: a 429 is retried once, honoring `Retry-After`.
- **Response envelopes**: Rippling has shipped several shapes across API versions, so list responses are normalized from a bare array, `{results}`, `{data}`, or `{items}`.
- **`search_workers` filters client-side** — Rippling has no server-side worker search. Prefer `list_workers` with a filter when you can.
- **Avoid TypeScript enums and parameter properties** in this codebase; Node's strip-only mode rejects them even though `tsc` accepts them.
