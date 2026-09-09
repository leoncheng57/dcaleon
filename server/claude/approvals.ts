import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export type ClaudeApprovalReply = "once" | "always" | "reject";

export interface ClaudeApprovalRequest {
  id: string;
  sessionId: string;
  toolName: string;
  /** The CLI's own correlation key for the tool call being gated. */
  toolUseId: string;
  input: Record<string, unknown>;
  createdAt: number;
}

/** The decision shape the CLI's `--permission-prompt-tool` contract expects. */
export interface ClaudeApprovalDecision {
  behavior: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
  message?: string;
}

/**
 * How long a gated tool call waits for a human before it is refused. A turn
 * that outlives this is not left hanging: an unanswered ask denies, so a
 * forgotten notification stalls the agent rather than silently letting the
 * call through.
 */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

interface Waiter {
  request: ClaudeApprovalRequest;
  settle: (decision: ClaudeApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

/**
 * Pending permission checks for the Claude runtime, and the answers to them.
 *
 * The gate lives here rather than in the sandboxed child so a decision is made
 * by the BFF on the user's behalf. `ask()` is called by the in-session approver
 * over loopback HTTP and resolves only once someone replies, the standing rules
 * cover it, or it times out.
 *
 * Threat model, stated plainly: the session can reach the BFF (the profile
 * grants `network*`) and the API has no auth, so a deliberately hostile agent
 * could answer its own ask. `token` therefore is not a security boundary — it
 * only keeps unrelated local processes from injecting asks. What approvals do
 * buy is a gate against an *erring* agent, which is the actual risk here, and
 * that is strictly better than the `bypassPermissions` this replaces. Seatbelt
 * remains the containment boundary for the hostile case.
 */
export class ClaudeApprovalStore extends EventEmitter {
  private readonly waiting = new Map<string, Waiter>();
  /** toolUseId -> approval id, so a retried ask joins the existing wait. */
  private readonly byToolUse = new Map<string, string>();
  /** sessionId -> tool names answered "always" for the rest of the session. */
  private readonly standing = new Map<string, Set<string>>();
  /** Identifies the approver to the BFF; see the class note on why this is not authz. */
  readonly token = randomBytes(32).toString("hex");

  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    super();
  }

  list(sessionId?: string): ClaudeApprovalRequest[] {
    const all = [...this.waiting.values()].map((waiter) => waiter.request);
    return (sessionId ? all.filter((request) => request.sessionId === sessionId) : all)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  /** True when this session already answered "always" for this tool. */
  private standingAllows(sessionId: string, toolName: string): boolean {
    return this.standing.get(sessionId)?.has(toolName) === true;
  }

  ask(input: { sessionId: string; toolName: string; toolUseId: string; input: Record<string, unknown> }): Promise<ClaudeApprovalDecision> {
    if (this.standingAllows(input.sessionId, input.toolName)) {
      return Promise.resolve({ behavior: "allow", updatedInput: input.input });
    }
    // The CLI can re-issue an ask for a tool call already in flight (a dropped
    // MCP connection re-runs the check). Joining the existing wait keeps one
    // row in front of the user instead of a duplicate per retry.
    const existingId = this.byToolUse.get(input.toolUseId);
    const existing = existingId ? this.waiting.get(existingId) : undefined;
    if (existing) return new Promise((resolve) => this.chain(existing, resolve));

    const request: ClaudeApprovalRequest = {
      id: randomUUID(),
      sessionId: input.sessionId,
      toolName: input.toolName,
      toolUseId: input.toolUseId,
      input: input.input,
      createdAt: Date.now(),
    };
    return new Promise<ClaudeApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.finish(request.id, { behavior: "deny", message: `denied by dcaleon: no answer within ${Math.round(this.timeoutMs / 1000)}s` });
      }, this.timeoutMs);
      timer.unref();
      this.waiting.set(request.id, { request, settle: resolve, timer });
      this.byToolUse.set(request.toolUseId, request.id);
      this.emit("asked", request);
    });
  }

  /** Attach another caller to a wait that is already registered. */
  private chain(waiter: Waiter, resolve: (decision: ClaudeApprovalDecision) => void): void {
    const previous = waiter.settle;
    waiter.settle = (decision) => {
      previous(decision);
      resolve(decision);
    };
  }

  reply(id: string, reply: ClaudeApprovalReply, message?: string): boolean {
    const waiter = this.waiting.get(id);
    if (!waiter) return false;
    if (reply === "always") {
      let allowed = this.standing.get(waiter.request.sessionId);
      if (!allowed) this.standing.set(waiter.request.sessionId, (allowed = new Set()));
      allowed.add(waiter.request.toolName);
    }
    return this.finish(id, reply === "reject"
      ? { behavior: "deny", message: message || "denied by dcaleon: the user rejected this tool call" }
      : { behavior: "allow", updatedInput: waiter.request.input });
  }

  /** Refuse everything still pending for a session whose turn is over. */
  cancelSession(sessionId: string, message = "denied by dcaleon: the turn ended before this was answered"): void {
    for (const { request } of [...this.waiting.values()]) {
      if (request.sessionId === sessionId) this.finish(request.id, { behavior: "deny", message });
    }
  }

  /** Drop a session's standing "always" rules, so they never outlive it. */
  forgetSession(sessionId: string): void {
    this.standing.delete(sessionId);
  }

  private finish(id: string, decision: ClaudeApprovalDecision): boolean {
    const waiter = this.waiting.get(id);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    this.waiting.delete(id);
    this.byToolUse.delete(waiter.request.toolUseId);
    waiter.settle(decision);
    this.emit("settled", { request: waiter.request, decision });
    return true;
  }
}
