import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RipplingClient } from "./rippling-client.ts";

const client = new RipplingClient();

const server = new McpServer(
  { name: "rippling", version: "0.1.0" },
  {
    instructions:
      "Read-only access to the Rippling HRIS. IDs are UUIDs and are not guessable — resolve a person with search_workers or list_workers before calling get_worker. Prefer the filtered list_* tools over fetching everything.",
  },
);

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

const readOnly = { readOnlyHint: true, openWorldHint: false };

function registerList(name: string, path: string, description: string) {
  server.registerTool(
    name,
    { description, inputSchema: {}, annotations: readOnly },
    async () => json(await client.getAll(path)),
  );
}

server.registerTool(
  "list_workers",
  {
    description:
      "List workers (employees and contractors) with their department, manager, level, teams, employment type and work location. Narrow with the optional filters where possible; unfiltered calls return up to `limit` workers.",
    inputSchema: {
      department_id: z.string().optional().describe("Only workers in this department"),
      team_id: z.string().optional().describe("Only workers on this team"),
      work_location_id: z.string().optional().describe("Only workers at this work location"),
      limit: z.number().int().min(1).max(1000).default(200).describe("Max workers to return"),
    },
    annotations: readOnly,
  },
  async ({ department_id, team_id, work_location_id, limit }) =>
    json(await client.getAll("/workers", { department_id, team_id, work_location_id }, limit)),
);

server.registerTool(
  "get_worker",
  {
    description:
      "Fetch one worker's full profile by their Rippling worker ID (a UUID). Use search_workers first if you only have a name.",
    inputSchema: { worker_id: z.string().describe("Rippling worker UUID") },
    annotations: readOnly,
  },
  async ({ worker_id }) => json(await client.getOne("/workers", worker_id)),
);

server.registerTool(
  "search_workers",
  {
    description:
      "Find workers whose name or email matches a query. Rippling has no server-side worker search, so this fetches the worker list and filters it locally — slower than the filtered list_workers, and capped at 1000 workers scanned.",
    inputSchema: {
      query: z.string().min(1).describe("Name or email fragment, case-insensitive"),
    },
    annotations: readOnly,
  },
  async ({ query }) => {
    const needle = query.toLowerCase();
    const workers = await client.getAll("/workers");
    const matches = workers.filter((worker) => {
      const w = worker as Record<string, any>;
      const haystack = [
        w.name,
        w.full_name,
        w.display_name,
        w.work_email,
        w.personal_email,
        w.user?.name,
        w.user?.full_name,
        w.user?.email,
        w.user?.work_email,
      ];
      return haystack.some(
        (field) => typeof field === "string" && field.toLowerCase().includes(needle),
      );
    });
    return json({ query, match_count: matches.length, matches });
  },
);

server.registerTool(
  "get_department",
  {
    description:
      "Fetch one department by ID, including its parent reference for walking the org hierarchy.",
    inputSchema: { department_id: z.string().describe("Rippling department UUID") },
    annotations: readOnly,
  },
  async ({ department_id }) => json(await client.getOne("/departments", department_id)),
);

server.registerTool(
  "list_leave_requests",
  {
    description:
      "List time-off / leave requests. Filter by worker to see one person's history.",
    inputSchema: {
      worker_id: z.string().optional().describe("Only requests for this worker"),
      limit: z.number().int().min(1).max(1000).default(200).describe("Max requests to return"),
    },
    annotations: readOnly,
  },
  async ({ worker_id, limit }) =>
    json(await client.getAll("/leave_requests", { worker_id }, limit)),
);

registerList(
  "list_departments",
  "/departments",
  "List all departments — the hierarchical org structure used to group workers and route approvals.",
);
registerList(
  "list_teams",
  "/teams",
  "List all teams. Teams group workers cross-functionally, independent of the department hierarchy.",
);
registerList(
  "list_groups",
  "/groups",
  "List all groups. Groups map to Rippling's app access policies, so use these to reason about who has access to what.",
);
registerList(
  "list_companies",
  "/companies",
  "List company-level metadata and legal entities for this Rippling account.",
);
registerList(
  "list_work_locations",
  "/work_locations",
  "List company work locations — office addresses and remote-work designations referenced by worker records.",
);
registerList(
  "list_levels",
  "/levels",
  "List position levels (for example Individual Contributor, Manager, Executive) used to rank workers.",
);
registerList(
  "list_custom_fields",
  "/custom_fields",
  "List the tenant-specific custom field definitions attached to workers and other Rippling resources.",
);

await server.connect(new StdioServerTransport());
