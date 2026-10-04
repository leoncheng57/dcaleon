/**
 * Privacy-safe structured audit logs for the notification delivery pipeline
 * and auto-approval decisions.
 *
 * All identifiers (directory paths, session IDs, request IDs, notification
 * record IDs) are HMAC-hashed before logging. The raw values never appear in
 * logs — only their correlation IDs do. This lets operators correlate events
 * across the pipeline without exposing sensitive paths or identifiers.
 *
 * The HMAC key resolves in three stages, tried in order:
 * 1. `NOTIFICATION_AUDIT_HMAC_KEY` — an explicit override that never touches
 *    disk and always wins.
 * 2. A persisted key file (`.state/notification-audit-hmac.key`, overridable
 *    via `NOTIFICATION_AUDIT_HMAC_KEY_FILE`) — created atomically on first
 *    use and reused by every process sharing this checkout, so correlation
 *    IDs join across restarts AND across BFFs sharing one .env/.state
 *    (#320: per-process random keys meant a dev BFF and the supervised BFF
 *    produced different correlation IDs for the same session, which hid the
 *    duplicate deliveries).
 * 3. A per-process random key — the last resort, never thrown, because
 *    failing closed would block the entire notification system.
 */

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { auditLogWriter } from "./auditLog.js";
import type { SuppressionReason } from "./history.js";
import type { NotifyEvent } from "./preferences.js";

// -----------------------------------------------------------------------------
// HMAC correlation ID generation
// -----------------------------------------------------------------------------

/** The persisted key's path: the env override, else `.state/` under cwd. */
export function auditHmacKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.NOTIFICATION_AUDIT_HMAC_KEY_FILE
    || resolve(process.cwd(), ".state/notification-audit-hmac.key");
}

const HEX_KEY = /^[0-9a-f]{64}$/i;

/**
 * Resolve the audit HMAC key once per process (see the module header for the
 * three stages). Sync fs is deliberate: it runs once, lazily, on the first
 * correlation ID the process mints.
 *
 * Key file creation is atomic-with-content: the candidate is written to a
 * unique sibling temp file and hard-linked into place, so two processes
 * racing the create both converge on the winner's bytes — the loser re-reads
 * the file rather than keeping its own key.
 *
 * Never throws. An unreadable or invalid existing file is left untouched and
 * reported, then falls back to a per-process key: the key is secret, so the
 * warning names the path and the error — never the key or the file contents.
 */
export function resolveAuditHmacKey(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(message),
): Buffer {
  const configured = env.NOTIFICATION_AUDIT_HMAC_KEY;
  if (configured) return Buffer.from(configured, "utf8");

  const file = auditHmacKeyPath(env);
  const fallback = (reason: string): Buffer => {
    warn(`[notifications] cannot use audit HMAC key file ${file} (${reason}); falling back to a per-process key, so audit correlation IDs will not join across processes. Set NOTIFICATION_AUDIT_HMAC_KEY to provide a fixed key.`);
    return randomBytes(32);
  };

  let existing: string;
  try {
    existing = readFileSync(file, "utf8").trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? String(error);
    if (code !== "ENOENT") return fallback(`read failed: ${code}`);
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temp, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
        try {
          linkSync(temp, file);
        } catch (linkError) {
          // EEXIST means another process won the race; its key wins and ours
          // is discarded, so every racer converges on the same bytes.
          if ((linkError as NodeJS.ErrnoException).code !== "EEXIST") throw linkError;
        }
      } finally {
        try {
          unlinkSync(temp);
        } catch {
          // The temp is already gone if the link or a cleanup raced us.
        }
      }
      existing = readFileSync(file, "utf8").trim();
    } catch (createError) {
      const createCode = (createError as NodeJS.ErrnoException).code ?? String(createError);
      return fallback(`create failed: ${createCode}`);
    }
  }

  if (HEX_KEY.test(existing)) return Buffer.from(existing, "hex");
  return fallback("contents are not a 64-hex-digit key");
}

let cachedKey: Buffer | undefined;
function hmacKey(): Buffer {
  return cachedKey ??= resolveAuditHmacKey();
}

/**
 * Generate a privacy-safe correlation ID from a sensitive identifier.
 * Returns a truncated HMAC-SHA256 hex string (16 chars = 64 bits).
 *
 * The truncation is intentional: these are correlation tokens for log analysis,
 * not cryptographic commitments. 64 bits provides sufficient collision resistance
 * for the expected cardinality of sessions/directories/requests.
 */
export function correlationId(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return createHmac("sha256", hmacKey()).update(value).digest("hex").slice(0, 16);
}

// -----------------------------------------------------------------------------
// Audit event types (closed vocabulary)
// -----------------------------------------------------------------------------

/**
 * Audit event types. This is a closed vocabulary — only these exact strings
 * are valid. Adding a new event type requires updating this union and the
 * corresponding payload type.
 */
export type AuditEventType =
  | "auto_approval_restore_completed"
  | "permission_asked_observed"
  | "auto_approval_reply"
  | "notification_decided"
  | "webpush_delivery_finished";

// -----------------------------------------------------------------------------
// Audit event payloads (per-event-type structured data)
// -----------------------------------------------------------------------------

export interface AutoApprovalRestoreCompletedPayload {
  /** Number of directories restored from the state file. */
  restoredCount: number;
  /** Whether the restore succeeded or failed. */
  outcome: "success" | "file_not_found" | "parse_error" | "stat_error";
}

export interface PermissionAskedObservedPayload {
  /** Correlation ID for the directory (HMAC of path). */
  directoryCorrelation: string | undefined;
  /** Correlation ID for the session (HMAC of session ID). */
  sessionCorrelation: string | undefined;
  /** Correlation ID for the permission request (HMAC of request ID). */
  requestCorrelation: string | undefined;
  /** Whether auto-approval is enabled for this directory. */
  autoApprovalEnabled: boolean;
}

export interface AutoApprovalReplyPayload {
  /** Correlation ID for the directory (HMAC of path). */
  directoryCorrelation: string | undefined;
  /** Correlation ID for the permission request (HMAC of request ID). */
  requestCorrelation: string | undefined;
  /** The outcome of the auto-approval attempt. */
  outcome: "approved" | "already_handled" | "not_found" | "error";
}

export interface NotificationDecidedPayload {
  /** Correlation ID for the notification record (HMAC of record ID). */
  recordCorrelation: string | undefined;
  /** Correlation ID for the directory (HMAC of path). */
  directoryCorrelation: string | undefined;
  /** Correlation ID for the session (HMAC of session ID). */
  sessionCorrelation: string | undefined;
  /** The notification kind (permission, idle, error, etc.). */
  kind: NotifyEvent;
  /** The decision outcome. */
  outcome: "delivered" | "suppressed";
  /** If suppressed, the reason. */
  suppressionReason: SuppressionReason | undefined;
}

export interface WebpushDeliveryFinishedPayload {
  /** Correlation ID for the notification record (HMAC of record ID). */
  recordCorrelation: string | undefined;
  /** Number of subscriptions that received the push successfully. */
  sent: number;
  /** Number of subscriptions that failed. */
  failed: number;
  /** Number of expired subscriptions that were cleaned up. */
  expired: number;
}

// -----------------------------------------------------------------------------
// Audit event structure
// -----------------------------------------------------------------------------

export interface AuditEvent<T extends AuditEventType = AuditEventType> {
  /** ISO 8601 timestamp. */
  ts: string;
  /** The audit subsystem identifier. */
  audit: "notification";
  /** The event type from the closed vocabulary. */
  event: T;
  /** Event-specific payload (structure depends on event type). */
  payload: T extends "auto_approval_restore_completed"
    ? AutoApprovalRestoreCompletedPayload
    : T extends "permission_asked_observed"
    ? PermissionAskedObservedPayload
    : T extends "auto_approval_reply"
    ? AutoApprovalReplyPayload
    : T extends "notification_decided"
    ? NotificationDecidedPayload
    : T extends "webpush_delivery_finished"
    ? WebpushDeliveryFinishedPayload
    : never;
}

// -----------------------------------------------------------------------------
// Logging function
// -----------------------------------------------------------------------------

type PayloadFor<T extends AuditEventType> = AuditEvent<T>["payload"];

/**
 * Emit a structured audit log event as a single JSON line.
 *
 * The durable destination is `.state/logs/audit.jsonl`, a file this process
 * owns and bounds (see `auditLog.ts`). It is deliberately NOT duplicated to
 * stdout in production: audit lines were 83% of the unrotated launchd log, so
 * moving them is what bounds that file without rotating a descriptor launchd
 * holds open.
 *
 * Outside production the line is also echoed to stdout, because `npm run dev`
 * runs the BFF in a terminal and silently losing audit output there would be a
 * real regression. The supervised LaunchAgent sets NODE_ENV=production
 * (`scripts/launchd.ts`), so the echo is off exactly where growth matters.
 */
export function logAuditEvent<T extends AuditEventType>(
  event: T,
  payload: PayloadFor<T>,
): void {
  const auditEvent: AuditEvent<T> = {
    ts: new Date().toISOString(),
    audit: "notification",
    event,
    payload,
  };
  const line = JSON.stringify(auditEvent);
  if (process.env.NODE_ENV !== "production") console.log(line);
  auditLogWriter().append(line);
}
