import type { EventEmitter } from "node:events";

import type { ClaudeApprovalDecision, ClaudeApprovalReply, ClaudeApprovalRequest, ClaudeApprovalStore } from "./approvals.js";
import type { ClaudeSession, ClaudeSessionStore } from "./store.js";

/** What the browser may see of a pending check: never the raw tool input. */
export interface PublicClaudeApproval {
  id: string;
  toolName: string;
  /** Bounded, human-readable summary of what the tool wants to do. */
  detail?: string;
  createdAt: number;
}

const DETAIL_LIMIT = 2_000;

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/**
 * The one line a human needs to decide. Bash shows its command; the file tools
 * show their path (never the content — a Write body can be the whole file);
 * anything else lists the input keys so an unfamiliar MCP tool is still
 * identifiable without dumping its arguments.
 */
export function approvalDetail(toolName: string, input: Record<string, unknown>): string | undefined {
  const text = (key: string) => (typeof input[key] === "string" && input[key] ? String(input[key]) : undefined);
  if (toolName === "Bash") return text("command") && truncate(text("command")!, DETAIL_LIMIT);
  const filePath = text("file_path") ?? text("notebook_path") ?? text("path");
  if (filePath) return truncate(filePath, DETAIL_LIMIT);
  const pattern = text("pattern") ?? text("query") ?? text("url");
  if (pattern) return truncate(pattern, DETAIL_LIMIT);
  const keys = Object.keys(input);
  return keys.length ? truncate(keys.join(", "), 200) : undefined;
}

export function publicApproval(request: ClaudeApprovalRequest): PublicClaudeApproval {
  const detail = approvalDetail(request.toolName, request.input);
  return { id: request.id, toolName: request.toolName, ...(detail ? { detail } : {}), createdAt: request.createdAt };
}

/** How a decision reads on the transcript's status row. */
export function decisionLabel(toolName: string, decision: ClaudeApprovalDecision, reply?: ClaudeApprovalReply): string {
  if (decision.behavior === "allow") return reply === "always" ? `Approved ${toolName} for the rest of this session` : `Approved ${toolName} once`;
  return `Denied ${toolName}`;
}

/**
 * Connect the approval gate to everything that used to be deaf to it.
 *
 * `ClaudeApprovalStore` emitted `asked` and nothing listened: the approver
 * MCP posted its check, the store queued a waiter, and the call sat for the
 * full timeout while no notification fired, the session SSE stayed silent and
 * the conversation page had no row to answer. From the browser this read as a
 * hang — a `Write` spinner that never finished — and from a phone it read as
 * nothing at all.
 *
 * Every ask is now translated into the `permission.asked` event the
 * NotificationService already understands, keyed by the session's *project*
 * directory (the directory the auto-permissions toggle is scoped to, and the
 * one the in-app row is filed under). The service then does what it does for
 * OpenCode: records, delivers over ntfy/Web Push/desktop, or suppresses as
 * `auto-permissions` when the directory toggle answered first. A settled ask
 * becomes `permission.replied`, which is what disarms the parked escalation.
 * Both directions also nudge the session store so `/claude/events` tells the
 * open page to refetch, and the decision lands on the transcript as a status
 * row so a later reader can see *why* a tool call was refused.
 */
export function bindClaudeApprovalEvents(
  bus: Pick<EventEmitter, "emit">,
  approvals: ClaudeApprovalStore,
  store: ClaudeSessionStore,
): () => void {
  const seed = (session: ClaudeSession) => {
    // The service remembers this id as a titled root session, so it never asks
    // the OpenCode server about an id OpenCode did not issue.
    bus.emit("event", {
      type: "session.updated",
      directory: session.projectDirectory,
      properties: { info: { id: session.id, title: session.title } },
    });
  };

  const asked = (request: ClaudeApprovalRequest) => {
    const session = store.get(request.sessionId);
    if (!session) return;
    seed(session);
    const detail = approvalDetail(request.toolName, request.input);
    bus.emit("event", {
      type: "permission.asked",
      directory: session.projectDirectory,
      properties: {
        id: request.id,
        sessionID: session.id,
        permission: request.toolName,
        patterns: detail ? [detail] : [],
        metadata: { runtime: "claude", toolUseId: request.toolUseId },
        always: [request.toolName],
      },
    });
    store.nudge(session.id);
  };

  const settled = ({ request, decision, reply }: { request: ClaudeApprovalRequest; decision: ClaudeApprovalDecision; reply?: ClaudeApprovalReply }) => {
    const session = store.get(request.sessionId);
    if (!session) return;
    bus.emit("event", {
      type: "permission.replied",
      directory: session.projectDirectory,
      properties: { requestID: request.id, sessionID: session.id, reply: decision.behavior === "allow" ? (reply ?? "once") : "reject" },
    });
    store.note(session, decisionLabel(request.toolName, decision, reply), decision.behavior === "deny" ? decision.message : undefined);
  };

  // A directory whose toggle is on answers before anyone is asked. The
  // service files that as a suppressed `auto-permissions` record — the audit
  // trail for "why was I never asked?" — because the same directory check
  // that approved it here is the one the service consults.
  const autoApproved = ({ sessionId, toolName, toolUseId }: { sessionId: string; toolName: string; toolUseId: string }) => {
    const session = store.get(sessionId);
    if (!session) return;
    seed(session);
    bus.emit("event", {
      type: "permission.asked",
      directory: session.projectDirectory,
      properties: { id: `auto-${toolUseId}`, sessionID: session.id, permission: toolName, patterns: [], metadata: { runtime: "claude", autoApproved: true }, always: [] },
    });
  };

  approvals.on("asked", asked);
  approvals.on("settled", settled);
  approvals.on("auto-approved", autoApproved);
  return () => {
    approvals.off("asked", asked);
    approvals.off("settled", settled);
    approvals.off("auto-approved", autoApproved);
  };
}
