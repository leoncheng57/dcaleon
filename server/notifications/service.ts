import type { OpencodeConfig } from "../opencode/client.js";
import type { EventBus, OpencodeEvent } from "../opencode/events.js";
import { listPermissions, parsePermissionRequest, type PermissionRequest } from "../opencode/permissions.js";
import { parseQuestionRequests } from "../opencode/questions.js";
import {
  getSessionMetadata,
  latestAssistantExcerpt,
  parseSessionMetadata,
  type SessionMetadata,
} from "../opencode/sessions.js";
import { correlationId, logAuditEvent } from "./audit.js";
import { sendNtfy, type NotificationMessage } from "./ntfy.js";
import {
  HistoryStore,
  type NotificationDelivery,
  type NotificationRecord,
  type SuppressionReason,
} from "./history.js";
import { PreferenceStore, type NotificationPreferences, type NotifyEvent } from "./preferences.js";
import { PushSubscriptionStore, sendWebPush } from "./webpush.js";
import { eventClickUrl, isClaudeSessionId } from "../publicAppUrl.js";

export function classifyEvent(event: OpencodeEvent): NotifyEvent | null {
  if (event.type === "session.idle") return "idle";
  if (event.type === "permission.asked") return "permission";
  if (event.type === "question.asked") return "question";
  if (event.type === "session.error") {
    const error = event.properties.error;
    return error && typeof error === "object" && (error as Record<string, unknown>).name === "MessageAbortedError"
      ? "abort"
      : "error";
  }
  return null;
}

function permission(event: OpencodeEvent): PermissionRequest | null {
  return parsePermissionRequest(event.properties);
}

/** Upstream is inconsistent about which key carries the request id. */
function requestIdOf(properties: Record<string, unknown>): string | undefined {
  const candidate = properties.requestID ?? properties.id;
  return typeof candidate === "string" && candidate ? candidate : undefined;
}

type SessionMetadataLookup = (
  directory: string,
  sessionID: string,
  signal: AbortSignal,
) => Promise<SessionMetadata | null>;

type SessionKind = "root" | "child" | "unknown";

/** Injected so tests can drive the excerpt without a live transcript. */
type SessionExcerptLookup = (
  directory: string,
  sessionID: string,
  signal: AbortSignal,
) => Promise<string | undefined>;

/**
 * Is this permission still waiting when the parked timer fires? OpenCode asks
 * are listed by `GET /permission`; a Claude ask lives in the BFF's own approval
 * store, which that route knows nothing about. Injected so each runtime's
 * pending set is consulted rather than OpenCode's being assumed for both.
 */
type PendingPermissionLookup = (directory: string, pending: PermissionRequest) => Promise<boolean>;

const SESSION_CACHE_LIMIT = 500;
const SESSION_CACHE_MS = 5 * 60_000;
const UNKNOWN_SESSION_CACHE_MS = 5_000;
const SESSION_LOOKUP_TIMEOUT_MS = 2_000;
const SESSION_LOOKUP_CONCURRENCY = 4;
export const NTFY_TITLE_LIMIT = 80;
// Lock-screen notifications should remain glanceable and avoid pushing unrelated
// phone content below the action that needs attention.
export const NTFY_BODY_LIMIT = 140;

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

function compact(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

/**
 * The runtime a record belongs to, read from the session id alone. Claude
 * sessions are minted `claude-<uuid>` (decision 34b), and a "OpenCode needs
 * permission" card for a Claude tool call sends the reader to the wrong island.
 */
function runtimeName(sessionID: unknown): string {
  return isClaudeSessionId(sessionID) ? "Claude" : "OpenCode";
}

function genericTitle(kind: NotifyEvent, sessionID?: unknown): string {
  const runtime = runtimeName(sessionID);
  return kind === "permission" ? `${runtime} needs permission` : `${runtime}: ${kind}`;
}

/**
 * OpenCode permission names are lowercase (`bash`, `edit`); Claude's are the
 * CLI's tool names (`Bash`, `Write`, `mcp__server__tool`). Both are bare
 * identifiers, so the same shape check serves both — the point is to refuse
 * anything that is not a name, not to insist on one casing.
 */
function safeToolName(event: OpencodeEvent): string | undefined {
  const value = event.properties.permission;
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value) ? value : undefined;
}

function safePreview(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const preview = compact(value);
  if (!preview || preview.length > limit) return undefined;
  // Details come from an upstream agent. Reject identifiers, credentials, URLs,
  // and filesystem references instead of trying to redact arbitrary tool output.
  if (/(?:^|[\s("'`=])(?:\/|~\/)|\b[A-Za-z]:[\\/]|(?:https?|file):\/\/|\b(?:ses|perm|que)_[A-Za-z0-9_-]+|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]+|\bBearer\s+[A-Za-z0-9._-]+/iu.test(preview)) {
    return undefined;
  }
  return preview;
}

function safeQuestionPreview(event: OpencodeEvent, limit: number): string | undefined {
  try {
    return safePreview(parseQuestionRequests([event.properties])[0]?.questions[0]?.question, limit);
  } catch {
    return undefined;
  }
}

function safeErrorReason(event: OpencodeEvent): string | undefined {
  const error = event.properties.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const name = (error as Record<string, unknown>).name;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9 ._-]{0,47}$/u.test(name) && safePreview(name, 48)
    ? name
    : undefined;
}

function humanDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes} ${minutes === 1 ? "minute" : "minutes"} ${remainder} ${remainder === 1 ? "second" : "seconds"}` : `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

export function outboundMessage(
  event: OpencodeEvent,
  kind: NotifyEvent,
  sessionTitle: string | undefined,
  parkedSeconds?: number,
): NotificationMessage {
  const compactTitle = sessionTitle ? compact(sessionTitle) : "";
  const title = compactTitle && compactTitle !== String(event.properties.sessionID ?? "") && !/^ses_[A-Za-z0-9_-]+$/u.test(compactTitle)
    ? truncate(compactTitle, NTFY_TITLE_LIMIT)
    : genericTitle(kind, event.properties.sessionID);
  let body: string;
  if (kind === "permission") {
    const tool = safeToolName(event);
    body = tool ? `\u{1F510} Needs approval to run ${tool}` : "\u{1F510} Needs your approval";
  } else if (kind === "question") {
    const question = safeQuestionPreview(event, 100);
    body = question ? `\u{2753} Needs your answer: ${question}` : "\u{2753} Needs your answer";
  } else if (kind === "idle") {
    body = "Finished its turn and is waiting for you";
  } else if (kind === "error") {
    const reason = safeErrorReason(event);
    body = reason ? `\u{26A0}\u{FE0F} Stopped with an error: ${reason}` : "\u{26A0}\u{FE0F} Stopped with an error";
  } else if (kind === "parked") {
    const tool = safeToolName(event);
    const duration = humanDuration(parkedSeconds ?? 0);
    body = tool
      ? `\u{23F3} Still waiting ${duration} for approval: ${tool}`
      : `\u{23F3} Still waiting ${duration} for approval`;
  } else {
    body = "Stopped at your request";
  }
  return { event: kind, title, body: truncate(body, NTFY_BODY_LIMIT), ...(kind === "parked" ? { priority: "high" as const } : {}) };
}

/**
 * Authenticated history can carry a longer safe question preview than a phone
 * lock screen, but it still accepts only parsed fields and never raw metadata.
 */
export function inAppMessage(event: OpencodeEvent, kind: NotifyEvent, parkedSeconds?: number): string {
  if (kind === "permission") {
    const tool = safeToolName(event);
    return tool ? `Needs approval to run ${tool}` : "Needs your approval";
  }
  if (kind === "question") {
    const question = safeQuestionPreview(event, 240);
    return question ? `Needs your answer: ${question}` : "Needs your answer";
  }
  if (kind === "idle") return "Finished its turn and is waiting for you";
  if (kind === "error") {
    const reason = safeErrorReason(event);
    return reason ? `Stopped with an error: ${reason}` : "Stopped with an error";
  }
  if (kind === "parked") {
    const tool = safeToolName(event);
    const prefix = `Still waiting ${humanDuration(parkedSeconds ?? 0)} for approval`;
    return tool ? `${prefix}: ${tool}` : prefix;
  }
  return "Stopped at your request";
}

/**
 * OS notification identity: one slot per session, not one per record.
 *
 * The tag used to be the record id, whose only job was stopping a foreground
 * PWA and its own push from buzzing twice for one record. But every ask in a
 * busy session then piled its own entry into the OS notification center — a
 * session that asked for bash seven times left seven "Needs approval" cards,
 * most of them stale the moment the user answered in the app. Web Push cannot
 * retract a shown notification; the only correction it has is replacement, and
 * replacement needs a shared tag. Keying by session makes each session one
 * slot that the newest state overwrites: a later ask replaces the stale one,
 * the parked escalation replaces the ask it escalates, and the eventual idle
 * replaces whatever was left. The server computes the tag once and sends it on
 * both the push payload and `notification.recorded`, so the service worker and
 * an open tab can never disagree about identity. Records with no session keep
 * the record id — there is nothing meaningful to collapse them under.
 */
export function notificationTag(record: Pick<NotificationRecord, "id" | "sessionID">): string {
  return record.sessionID || record.id;
}

/**
 * How long after an abort an arriving `session.idle` is treated as part of that
 * same stop rather than a separate event worth telling anyone about.
 *
 * Pressing Stop makes upstream emit the abort and the idle back to back — 5 ms
 * apart in the capture that motivated this. A session that has been aborted is
 * idle by definition, so the pair is one occurrence described twice. Anything
 * genuinely new requires a fresh prompt, which cannot land inside this window,
 * so the bound can be generous without swallowing a real turn.
 */
const ABORT_IDLE_WINDOW_MS = 30_000;

export class NotificationService {
  private timers = new Map<string, NodeJS.Timeout>();
  private seen = new Map<string, number>();
  /** Session key -> time of its most recent abort, for ABORT_IDLE_WINDOW_MS. */
  private aborted = new Map<string, number>();
  private sessionKinds = new Map<string, { kind: SessionKind; expiresAt: number }>();
  /**
   * Best-effort session titles, populated only from data the service already
   * had — session lifecycle events and the parent/child lookups below. It
   * never issues a request of its own: a missing title costs the row a nicer
   * label, while an extra round trip per event would cost every notification
   * latency. Sessions are titled early, so in practice this is warm by the
   * time anything notifies.
   */
  private sessionTitles = new Map<string, { title: string; expiresAt: number }>();
  private sessionLookups = new Map<string, Promise<SessionKind>>();
  private activeSessionLookups = 0;
  private readonly onEvent = (event: OpencodeEvent) => void this.handle(event);
  private readonly lookupSessionMetadata: SessionMetadataLookup;
  private readonly lookupSessionExcerpt: SessionExcerptLookup;
  private readonly isPermissionPending: PendingPermissionLookup;

  constructor(
    private readonly config: OpencodeConfig,
    private readonly bus: EventBus,
    private readonly store: PreferenceStore,
    private readonly history: HistoryStore,
    private readonly publicAppUrl: string | null = null,
    private readonly autoPermissionsEnabled: (directory: string | undefined) => boolean | Promise<boolean> = () => false,
    lookupSessionMetadata?: SessionMetadataLookup,
    private readonly pushSubscriptions = new PushSubscriptionStore(),
    lookupSessionExcerpt?: SessionExcerptLookup,
    isPermissionPending?: PendingPermissionLookup,
  ) {
    this.isPermissionPending = isPermissionPending
      ?? (async (directory, pending) => (await listPermissions(this.config, directory)).some((item) => item.id === pending.id));
    this.lookupSessionMetadata = lookupSessionMetadata
      ?? ((directory, sessionID, signal) => getSessionMetadata(this.config, directory, sessionID, signal));
    this.lookupSessionExcerpt = lookupSessionExcerpt
      // DSH sessions are local to the experiment store, so OpenCode has no
      // transcript to look up after their title has been seeded above.
      ?? ((directory, sessionID, signal) => sessionID.startsWith("dsh-")
        ? Promise.resolve(undefined)
        : latestAssistantExcerpt(this.config, directory, sessionID, signal));
  }

  /**
   * Bounded excerpt of the agent's final answer, for kinds whose copy is
   * otherwise identical every single time.
   *
   * Only `idle` asks for it. A permission already names its tool, a question
   * carries its own preview, and an error carries its reason — those rows are
   * already distinguishable. "Finished its turn and is waiting for you" is not,
   * which is the whole complaint: three of them from one session say nothing
   * about which is which.
   *
   * Costs one upstream read on the delivery path, so it borrows the session
   * lookup's discipline exactly: a hard timeout, the shared concurrency budget,
   * and fail-open to `undefined` rather than delaying or dropping the
   * notification. A missing excerpt costs the row some specificity; a stalled
   * notification costs the user the ping.
   */
  private async excerptFor(directory: string | undefined, sessionID: string): Promise<string | undefined> {
    if (!directory || !sessionID) return undefined;
    if (this.activeSessionLookups >= SESSION_LOOKUP_CONCURRENCY) return undefined;
    this.activeSessionLookups += 1;
    try {
      return await this.lookupSessionExcerpt(
        directory,
        sessionID,
        AbortSignal.timeout(SESSION_LOOKUP_TIMEOUT_MS),
      );
    } catch (error) {
      console.warn("[notification-excerpt]", error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      this.activeSessionLookups -= 1;
    }
  }

  start(): void {
    this.bus.on("event", this.onEvent);
  }

  stop(): void {
    this.bus.off("event", this.onEvent);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private async handle(event: OpencodeEvent): Promise<void> {
    this.observeSessionMetadata(event);

    if (event.type === "permission.replied") {
      // requestIdOf, not properties.requestID: upstream is inconsistent about
      // which key carries the id, and reading only one of them collapses the
      // key to "<dir>:" and cancels nothing — leaving a parked escalation
      // armed for a permission the user already answered.
      const id = requestIdOf(event.properties);
      const key = `${event.directory ?? ""}:${id ?? ""}`;
      const timer = this.timers.get(key);
      if (timer) clearTimeout(timer);
      this.timers.delete(key);
      return;
    }

    const kind = classifyEvent(event);
    if (!kind) return;

    const sessionID = String(event.properties.sessionID ?? "");

    // Deduplicate FIRST, before the session-kind lookup below.
    //
    // This used to sit after the lookup, so every upstream echo paid a
    // round trip and consumed one of only SESSION_LOOKUP_CONCURRENCY slots
    // before being discarded. That made the sub-agent gate fail open under
    // exactly the bursts it exists for: a fan-out of children saturated the
    // budget, the lookup shed to "unknown", and the child's notification was
    // delivered as though it came from a root session.
    //
    // A repeat inside 5s is an upstream echo, not a second notification, and
    // logging it would inflate the badge.
    const identity = String(event.properties.id ?? event.properties.requestID ?? event.properties.sessionID ?? "");
    const dedupeKey = `${event.directory ?? ""}:${event.type}:${identity}`;
    const now = Date.now();
    if (now - (this.seen.get(dedupeKey) ?? 0) < 5_000) return;
    this.seen.set(dedupeKey, now);
    if (this.seen.size > 500) {
      for (const [key, timestamp] of this.seen) {
        if (now - timestamp > 60_000) this.seen.delete(key);
      }
    }

    // Pressing Stop produces two notifications for one action: upstream emits
    // the abort and then `session.idle`, observed 5 ms apart, and both were
    // delivered. The second says "Finished its turn and is waiting for you" —
    // which is not what happened, and it carries the *previous* turn's excerpt,
    // so on a phone it reads as a verbatim duplicate of the notification before
    // it.
    //
    // Dropped rather than recorded as suppressed. The suppression categories
    // exist so "why was I never told?" stays answerable; here the user was
    // told, by the abort they are about to receive for the very same stop.
    // Recording the idle too would put a row in the inbox whose only content is
    // a restatement of its neighbour. Same reasoning as the echo dedupe above,
    // which also returns without recording.
    const sessionKey = `${event.directory ?? ""}:${sessionID}`;
    if (kind === "abort" && sessionID) this.aborted.set(sessionKey, now);
    if (kind === "idle" && sessionID && now - (this.aborted.get(sessionKey) ?? 0) < ABORT_IDLE_WINDOW_MS) return;
    if (this.aborted.size > 500) {
      for (const [key, timestamp] of this.aborted) {
        if (now - timestamp > ABORT_IDLE_WINDOW_MS) this.aborted.delete(key);
      }
    }

    // Sub-agent activity is recorded but not delivered — with one exception.
    // A child that finishes hands back to its parent, so telling the human is
    // noise; but a child stopped on an unanswered permission ask is stalled
    // work nobody else can unblock, and suppressing that ask meant a delegated
    // task could sit frozen for hours while the inbox swore nothing needed
    // anyone. Permission asks therefore take the delivery path regardless of
    // lineage (the auto-permissions gate below still answers them silently in
    // an auto-approved directory); everything else a child emits stays a
    // recorded-only audit trail.
    const child = (await this.sessionKind(event.directory, sessionID)) === "child";
    const subagent = child && kind !== "permission";

    const preferences = await this.store.read();
    const details = kind === "permission" ? permission(event) : null;
    const requestID = requestIdOf(event.properties);
    const sessionTitle = this.sessionTitle(event.directory, sessionID);
    // History retains its generic operational copy; outbound ntfy copy is
    // intentionally session-first and lock-screen-safe.
    const historyTitle = genericTitle(kind, sessionID);
    const historyBody = details ? `${details.permission} requires review` : `Session ${sessionID || "updated"}`;
    // Suppressed records are never read as an inbox row, so they do not earn an
    // upstream read; only a delivered `idle` does.
    const detail = kind === "idle" && !subagent ? await this.excerptFor(event.directory, sessionID) : undefined;
    const message = {
      ...outboundMessage(event, kind, sessionTitle),
      // Supersedes decision 26's in-app-only boundary (see decision 29): the
      // generic idle body was identical every time, which was the actual
      // complaint — the in-app-only excerpt never reached the channel people
      // actually look at. Re-truncated to NTFY_BODY_LIMIT for the lock-screen
      // body; falls back to the generic body when no excerpt is available.
      ...(kind === "idle" && detail ? { body: truncate(detail, NTFY_BODY_LIMIT) } : {}),
      ...(eventClickUrl(this.publicAppUrl, event) ? { click: eventClickUrl(this.publicAppUrl, event) } : {}),
    };
    const common = {
      kind,
      ...(event.directory ? { directory: event.directory } : {}),
      ...(sessionID ? { sessionID } : {}),
      ...(sessionTitle ? { sessionTitle } : {}),
      ...(requestID ? { requestID } : {}),
      title: historyTitle,
      body: historyBody,
      displayBody: inAppMessage(event, kind),
      // Deliberately absent from `message`/`outboundMessage`: the excerpt is
      // agent-authored prose for an authenticated in-app row, not something to
      // push to a third-party relay or a phone lock screen.
      ...(detail ? { detail } : {}),
      ...(message.click ? { click: message.click } : {}),
    };

    if (subagent) {
      const record = await this.history.append({
        ...common,
        delivery: { ntfy: "off", desktop: "off", webPush: "off", suppressed: "subagent" },
      });
      this.emitRecorded(record, "subagent");
      logAuditEvent("notification_decided", {
        recordCorrelation: correlationId(record.id),
        directoryCorrelation: correlationId(event.directory),
        sessionCorrelation: correlationId(sessionID),
        kind,
        outcome: "suppressed",
        suppressionReason: "subagent",
      });
      return;
    }

    // Auto-approved permissions still belong in the log — "why was I never
    // asked?" is exactly the question it should answer — but they are not a
    // decision the user owes anyone, so they are suppressed and, by default,
    // filtered out of the inbox and the badge.
    if (event.type === "permission.asked" && await this.autoPermissionsEnabled(event.directory)) {
      const record = await this.history.append({
        ...common,
        delivery: { ntfy: "off", desktop: "off", webPush: "off", suppressed: "auto-permissions" },
      });
      this.emitRecorded(record, "auto-permissions");
      logAuditEvent("notification_decided", {
        recordCorrelation: correlationId(record.id),
        directoryCorrelation: correlationId(event.directory),
        sessionCorrelation: correlationId(sessionID),
        kind,
        outcome: "suppressed",
        suppressionReason: "auto-permissions",
      });
      return;
    }

    const record = await this.history.append({
      ...common,
      delivery: this.pendingDelivery(preferences, message),
    });
    const badge = await this.history.appBadgeSnapshot();
    const delivery = await this.deliver(preferences, {
      ...message,
      badgeCount: badge.count,
      badgeRevision: badge.revision,
      tag: notificationTag(record),
    });
    await this.history.setDelivery(record.id, delivery);
    this.emitRecorded(record, delivery.suppressed);
    logAuditEvent("notification_decided", {
      recordCorrelation: correlationId(record.id),
      directoryCorrelation: correlationId(event.directory),
      sessionCorrelation: correlationId(sessionID),
      kind,
      outcome: delivery.suppressed ? "suppressed" : "delivered",
      suppressionReason: delivery.suppressed,
    });

    // Only arm the escalation if a parked alert could actually reach the user.
    // It used to arm unconditionally, so switching `parked` off silenced the
    // ping but still produced a second unresolved record per slow permission —
    // doubling the badge for anyone who stepped away for 30 seconds.
    if (
      kind === "permission"
      && details
      && event.directory
      && !this.preferenceOff(preferences, "parked")
    ) {
      this.scheduleParked(event.directory, details, preferences.parkedPermissionSeconds);
    }
  }

  private sessionKey(directory: string, sessionID: string): string {
    return `${directory}\0${sessionID}`;
  }

  private observeSessionMetadata(event: OpencodeEvent): void {
    if (!event.directory) return;
    if (event.type === "session.deleted") {
      const metadata = parseSessionMetadata(event.properties.info);
      if (metadata) {
        const key = this.sessionKey(event.directory, metadata.id);
        this.sessionKinds.delete(key);
        this.sessionTitles.delete(key);
      }
      return;
    }
    if (event.type !== "session.created" && event.type !== "session.updated") return;
    const metadata = parseSessionMetadata(event.properties.info);
    if (!metadata) return;
    const key = this.sessionKey(event.directory, metadata.id);
    this.rememberSessionKind(key, metadata.parentID ? "child" : "root", SESSION_CACHE_MS);
    this.rememberSessionTitle(key, metadata.title);
  }

  /** Latest known title, or undefined — never a fabricated placeholder. */
  private sessionTitle(directory: string | undefined, sessionID: string): string | undefined {
    if (!directory || !sessionID) return undefined;
    const key = this.sessionKey(directory, sessionID);
    const cached = this.sessionTitles.get(key);
    if (!cached) return undefined;
    if (cached.expiresAt <= Date.now()) {
      this.sessionTitles.delete(key);
      return undefined;
    }
    return cached.title;
  }

  private rememberSessionTitle(key: string, title: string | undefined): void {
    if (!title) return;
    this.sessionTitles.delete(key);
    this.sessionTitles.set(key, { title, expiresAt: Date.now() + SESSION_CACHE_MS });
    while (this.sessionTitles.size > SESSION_CACHE_LIMIT) {
      const oldest = this.sessionTitles.keys().next().value;
      if (oldest === undefined) break;
      this.sessionTitles.delete(oldest);
    }
  }

  private async sessionKind(directory: string | undefined, sessionID: string): Promise<SessionKind> {
    // Events without a scoped identity cannot be verified, so fail open rather
    // than hiding a legitimate root notification.
    if (!directory || !sessionID) return "unknown";
    const key = this.sessionKey(directory, sessionID);
    const cached = this.sessionKinds.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.kind;
    if (cached) this.sessionKinds.delete(key);

    const existing = this.sessionLookups.get(key);
    if (existing) return existing;

    const lookup = this.lookupSessionKind(directory, sessionID)
      .then((kind) => {
        const observed = this.sessionKinds.get(key);
        if (observed && observed.expiresAt > Date.now()) return observed.kind;
        this.rememberSessionKind(
          key,
          kind,
          kind === "unknown" ? UNKNOWN_SESSION_CACHE_MS : SESSION_CACHE_MS,
        );
        return kind;
      })
      .finally(() => this.sessionLookups.delete(key));
    this.sessionLookups.set(key, lookup);
    return lookup;
  }

  private async lookupSessionKind(directory: string, sessionID: string): Promise<SessionKind> {
    // Under a burst, fail open immediately instead of building an unbounded
    // queue that delays root notifications and retains every incoming event.
    if (this.activeSessionLookups >= SESSION_LOOKUP_CONCURRENCY) return "unknown";
    this.activeSessionLookups += 1;
    try {
      const metadata = await this.lookupSessionMetadata(
        directory,
        sessionID,
        AbortSignal.timeout(SESSION_LOOKUP_TIMEOUT_MS),
      );
      if (!metadata || metadata.id !== sessionID) return "unknown";
      this.rememberSessionTitle(this.sessionKey(directory, sessionID), metadata.title);
      return metadata.parentID ? "child" : "root";
    } catch (error) {
      console.warn("[notification-session]", error instanceof Error ? error.message : String(error));
      return "unknown";
    } finally {
      this.activeSessionLookups -= 1;
    }
  }

  private rememberSessionKind(key: string, kind: SessionKind, ttl: number): void {
    this.sessionKinds.delete(key);
    this.sessionKinds.set(key, { kind, expiresAt: Date.now() + ttl });
    while (this.sessionKinds.size > SESSION_CACHE_LIMIT) {
      const oldest = this.sessionKinds.keys().next().value;
      if (oldest === undefined) break;
      this.sessionKinds.delete(oldest);
    }
  }

  /**
   * Browser nudge emitted only after the durable append completes.
   *
   * Carries the delivery verdict, not just the id, because this is now the
   * ONLY event the browser is allowed to ring a bell for. The client used to
   * re-derive the notification kind from raw upstream events, which gave it no
   * knowledge of session lineage: every delegated child's turn produced a
   * desktop popup, a sound and speech, while the server filed the same event as
   * `suppressed: "subagent"` and hid it from the inbox. "I got pinged but
   * nothing is in my list" was the result, and it is the loudest half of the
   * over-notification report. The server already decides who gets told; this
   * hands the browser that decision instead of a second opinion.
   */
  private emitRecorded(record: NotificationRecord, suppressed?: SuppressionReason): void {
    this.bus.emit("event", {
      type: "notification.recorded",
      properties: {
        id: record.id,
        kind: record.kind,
        tag: notificationTag(record),
        ...(record.sessionID ? { sessionID: record.sessionID } : {}),
        ...(suppressed ? { suppressed } : {}),
        ...(record.sessionTitle ? { sessionTitle: record.sessionTitle } : {}),
        ...(record.displayBody ? { displayBody: record.displayBody } : {}),
        ...(record.click ? { click: record.click } : {}),
      },
      ...(record.directory ? { directory: record.directory } : {}),
    } satisfies OpencodeEvent);
  }

  /**
   * True when the user has switched this event kind off in every channel's
   * event matrix.
   *
   * Distinguished from a channel merely being unconfigured: "I never set up
   * ntfy" is not the same statement as "do not tell me about idle sessions".
   * Only the second is an instruction, and only the second should keep the
   * record out of the badge.
   */
  private preferenceOff(preferences: NotificationPreferences, event: NotifyEvent): boolean {
    return !preferences.ntfy.events[event]
      && !preferences.browser.events[event]
      && !preferences.webPush.events[event];
  }

  /** Send over every enabled channel and report what actually happened. */
  private pendingDelivery(
    preferences: NotificationPreferences,
    message: NotificationMessage,
  ): NotificationDelivery {
    return {
      ntfy: preferences.ntfy.enabled && Boolean(preferences.ntfy.topic) && preferences.ntfy.events[message.event]
        ? "pending"
        : "off",
      desktop: preferences.browser.desktop && preferences.browser.events[message.event] ? "allowed" : "off",
      webPush: preferences.webPush.enabled && preferences.webPush.events[message.event] ? "pending" : "off",
      // Recorded, never delivered, and filtered out of the inbox and the badge
      // by default — the same bounded-audit-trail treatment the other two
      // suppression categories get. The record still exists to answer "why was
      // I never told?".
      ...(this.preferenceOff(preferences, message.event) ? { suppressed: "preference-off" as const } : {}),
    };
  }

  /** Send over every enabled channel and report what actually happened. */
  private async deliver(
    preferences: NotificationPreferences,
    message: NotificationMessage,
  ): Promise<NotificationDelivery> {
    // The BFF has no view of open tabs, so this is the preference, not proof.
    const desktop =
      preferences.browser.desktop && preferences.browser.events[message.event] ? "allowed" : "off";
    const wantsNtfy =
      preferences.ntfy.enabled && Boolean(preferences.ntfy.topic) && preferences.ntfy.events[message.event];
    const wantsWebPush = preferences.webPush.enabled && preferences.webPush.events[message.event];
    let subscriptions: Awaited<ReturnType<PushSubscriptionStore["list"]>> = [];
    let subscriptionError: string | undefined;
    if (wantsWebPush) {
      try {
        subscriptions = await this.pushSubscriptions.list();
      } catch (error) {
        subscriptionError = error instanceof Error ? error.message : String(error);
      }
    }
    const [ntfy, webPush] = await Promise.all([
      wantsNtfy
        ? sendNtfy(preferences, message).then(() => ({ state: "sent" as const })).catch((error: unknown) => ({ state: "failed" as const, error: error instanceof Error ? error.message : String(error) }))
        : Promise.resolve({ state: "off" as const }),
      subscriptionError
        ? Promise.resolve({ state: "failed" as const, error: subscriptionError })
        : subscriptions.length
        ? sendWebPush(subscriptions, message).then(async (result) => {
          await Promise.allSettled(result.expired.map((endpoint) => {
            const stale = subscriptions.find((item) => item.endpoint === endpoint);
            return this.pushSubscriptions.remove(endpoint, stale?.keys);
          }));
          // Logged here, inside the single `deliver()` implementation, rather
          // than via a field read back by each caller: `handle()` fires
          // `deliver()` without awaiting a serialized queue, so two
          // notifications in flight at once would otherwise race on a shared
          // mutable field and could log one record's stats under another's
          // correlation id. This also naturally covers both call sites
          // (normal delivery and the parked-escalation timer) instead of only
          // one of them.
          logAuditEvent("webpush_delivery_finished", {
            recordCorrelation: correlationId(message.tag),
            sent: result.sent,
            failed: result.failed,
            expired: result.expired.length,
          });
          const reasons = result.failures.length ? `: ${result.failures.join("; ")}` : "";
          return result.failed && result.sent
            ? { state: "partial" as const, error: `${result.sent} sent; ${result.failed} failed${reasons}` }
            : result.failed
              ? { state: "failed" as const, error: `${result.failed} subscription(s) failed${reasons}` }
            : { state: "sent" as const };
        }).catch((error: unknown) => ({ state: "failed" as const, error: error instanceof Error ? error.message : String(error) }))
        : Promise.resolve({ state: "off" as const }),
    ]);
    if (ntfy.state === "failed") console.warn("[ntfy]", ntfy.error);
    if (webPush.state === "failed" || webPush.state === "partial") console.warn("[web-push]", webPush.error);
    return {
      ntfy: ntfy.state,
      ...(ntfy.state === "failed" ? { ntfyError: ntfy.error } : {}),
      desktop,
      webPush: webPush.state,
      ...(webPush.state === "failed" || webPush.state === "partial" ? { webPushError: webPush.error } : {}),
      ...(this.preferenceOff(preferences, message.event) ? { suppressed: "preference-off" as const } : {}),
    };
  }

  private scheduleParked(directory: string, pending: PermissionRequest, seconds: number): void {
    const key = `${directory}:${pending.id}`;
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void Promise.resolve(this.autoPermissionsEnabled(directory))
          .then(async (enabled) => {
            // No lineage gate here any more: a child permission ask is
            // delivered (a stalled delegate is the one child event that needs
            // a human), so its escalation must follow the same policy as the
            // ask it escalates.
            if (enabled) return;
            if (!await this.isPermissionPending(directory, pending)) return;
            const preferences = await this.store.read();
            const parkedEvent: OpencodeEvent = {
              type: "permission.asked",
              properties: { sessionID: pending.sessionID, permission: pending.permission },
              directory,
            };
            const message = {
              ...outboundMessage(parkedEvent, "parked", this.sessionTitle(directory, pending.sessionID), seconds),
              ...(eventClickUrl(this.publicAppUrl, parkedEvent) ? { click: eventClickUrl(this.publicAppUrl, parkedEvent) } : {}),
            };
            const parkedTitle = this.sessionTitle(directory, pending.sessionID);
            const record = await this.history.append({
              kind: "parked",
              directory,
              sessionID: pending.sessionID,
              ...(parkedTitle ? { sessionTitle: parkedTitle } : {}),
              requestID: pending.id,
              title: `${runtimeName(pending.sessionID)} is parked`,
              body: `${pending.permission} has waited ${seconds}s for a reply`,
              displayBody: inAppMessage(parkedEvent, "parked", seconds),
              ...(message.click ? { click: message.click } : {}),
              delivery: this.pendingDelivery(preferences, message),
            });
            const badge = await this.history.appBadgeSnapshot();
            const delivery = await this.deliver(preferences, {
              ...message,
              badgeCount: badge.count,
              badgeRevision: badge.revision,
              tag: notificationTag(record),
            });
            await this.history.setDelivery(record.id, delivery);
            // The parked alert is a separately delivered notification and also
            // stamps its parent permission for the in-app escalation marker.
            this.emitRecorded(record, delivery.suppressed);
            await this.history.markParked(directory, pending.id);
            this.bus.emit("event", {
              type: "notification.parked",
              properties: { requestID: pending.id, sessionID: pending.sessionID },
              directory,
            } satisfies OpencodeEvent);
          })
          .catch((error) => console.warn("[parked-permission]", String(error)));
      }, seconds * 1000),
    );
  }
}
