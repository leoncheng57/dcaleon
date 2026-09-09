/** MCP server name and tool, joined into the `--permission-prompt-tool` value. */
export const APPROVER_SERVER = "dcaleon_approvals";
export const APPROVER_TOOL = "approve";
export const APPROVER_PROMPT_TOOL = `mcp__${APPROVER_SERVER}__${APPROVER_TOOL}`;

/**
 * The in-session permission prompt handler, as source.
 *
 * Generated into the session directory at spawn time rather than shipped as a
 * file next to this one: `npm run build:server` is `tsc`, which emits only
 * compiled `.ts`, so a `.mjs` sibling would exist in dev and be missing from
 * `dist` in production. Generating it keeps one code path for both and pins the
 * script to the runtime that wrote it.
 *
 * It holds no policy of its own. It forwards the check to the BFF over loopback
 * and relays the answer, and every failure path denies — an approver that
 * cannot reach its gate must not let the call through.
 */
export const APPROVER_SOURCE = `
const url = process.env.DCALEON_APPROVAL_URL;
const token = process.env.DCALEON_APPROVAL_TOKEN;
const sessionId = process.env.DCALEON_SESSION_ID;

const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const deny = (message) => ({ behavior: "deny", message: "denied by dcaleon: " + message });

const TOOL = {
  name: ${JSON.stringify(APPROVER_TOOL)},
  description: "Permission prompt handler. Returns an allow/deny decision for a gated tool call.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object", additionalProperties: true },
      tool_use_id: { type: "string" },
    },
    additionalProperties: true,
  },
};

async function decide(args) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Dcaleon-Approval-Token": token },
    body: JSON.stringify({
      sessionId,
      toolName: args && args.tool_name,
      toolUseId: args && args.tool_use_id,
      input: (args && args.input) || {},
    }),
  });
  if (!response.ok) return deny("the approval gate answered HTTP " + response.status);
  const decision = await response.json();
  if (!decision || (decision.behavior !== "allow" && decision.behavior !== "deny")) {
    return deny("the approval gate returned no decision");
  }
  return decision;
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: (message.params && message.params.protocolVersion) || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: ${JSON.stringify(APPROVER_SERVER)}, version: "1.0.0" },
      } });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [TOOL] } });
    } else if (message.method === "tools/call") {
      const args = message.params && message.params.arguments;
      decide(args)
        .catch((cause) => deny("the approval gate was unreachable (" + (cause && cause.message) + ")"))
        .then((decision) => send({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: JSON.stringify(decision) }] },
        }));
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  }
});
`;

/**
 * The `--mcp-config` document naming the generated approver.
 *
 * The URL and token travel in the child's environment, not its argv, so they
 * do not show up in a process listing.
 */
export function claudeApproverConfig(input: {
  nodePath: string;
  scriptPath: string;
  url: string;
  token: string;
  sessionId: string;
}): Record<string, unknown> {
  return {
    mcpServers: {
      [APPROVER_SERVER]: {
        command: input.nodePath,
        args: [input.scriptPath],
        env: {
          DCALEON_APPROVAL_URL: input.url,
          DCALEON_APPROVAL_TOKEN: input.token,
          DCALEON_SESSION_ID: input.sessionId,
        },
      },
    },
  };
}
