import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { correlationId, logAuditEvent } from "../server/notifications/audit.js";
import { AuditLogWriter, setAuditLogWriter } from "../server/notifications/auditLog.js";

describe("notification audit", () => {
  // logAuditEvent now persists as well as echoing to stdout. Without an
  // explicit writer every case below would append to the real .state/logs in
  // the repository root, so the destination is redirected for the whole file.
  let temporaryRoot: string;
  let writer: AuditLogWriter;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "audit-log-"));
    writer = new AuditLogWriter(path.join(temporaryRoot, "audit.jsonl"));
    setAuditLogWriter(writer);
  });

  afterEach(async () => {
    // append() is fire-and-forget, so pending work must settle before the
    // directory goes away; otherwise the writer logs a swallowed EINVAL.
    await writer.flush();
    setAuditLogWriter(null);
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  describe("correlationId", () => {
    it("returns undefined for empty values", () => {
      expect(correlationId(undefined)).toBeUndefined();
      expect(correlationId(null)).toBeUndefined();
      expect(correlationId("")).toBeUndefined();
    });

    it("returns a 16-character hex string for non-empty values", () => {
      const id = correlationId("/some/directory/path");
      expect(id).toBeDefined();
      expect(id).toHaveLength(16);
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    });

    it("returns consistent results for the same input", () => {
      const input = "ses_abc123";
      expect(correlationId(input)).toBe(correlationId(input));
    });

    it("returns different results for different inputs", () => {
      const id1 = correlationId("/path/a");
      const id2 = correlationId("/path/b");
      expect(id1).not.toBe(id2);
    });
  });

  describe("logAuditEvent", () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let capturedOutput: string[];

    beforeEach(() => {
      capturedOutput = [];
      consoleLogSpy = vi.spyOn(console, "log").mockImplementation((message: string) => {
        capturedOutput.push(message);
      });
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });

    it("emits a valid JSON line", () => {
      logAuditEvent("auto_approval_restore_completed", {
        restoredCount: 3,
        outcome: "success",
      });

      expect(capturedOutput).toHaveLength(1);
      const parsed = JSON.parse(capturedOutput[0]);
      expect(parsed.audit).toBe("notification");
      expect(parsed.event).toBe("auto_approval_restore_completed");
      expect(parsed.payload.restoredCount).toBe(3);
      expect(parsed.payload.outcome).toBe("success");
      expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("emits permission_asked_observed correctly", () => {
      logAuditEvent("permission_asked_observed", {
        directoryCorrelation: "abc123def456",
        sessionCorrelation: "789xyz000111",
        requestCorrelation: "reqid123456",
        autoApprovalEnabled: true,
      });

      const parsed = JSON.parse(capturedOutput[0]);
      expect(parsed.event).toBe("permission_asked_observed");
      expect(parsed.payload.directoryCorrelation).toBe("abc123def456");
      expect(parsed.payload.autoApprovalEnabled).toBe(true);
    });

    it("emits auto_approval_reply correctly", () => {
      logAuditEvent("auto_approval_reply", {
        directoryCorrelation: "abc123def456",
        requestCorrelation: "req123",
        outcome: "approved",
      });

      const parsed = JSON.parse(capturedOutput[0]);
      expect(parsed.event).toBe("auto_approval_reply");
      expect(parsed.payload.outcome).toBe("approved");
    });

    it("emits notification_decided correctly", () => {
      logAuditEvent("notification_decided", {
        recordCorrelation: "rec123",
        directoryCorrelation: "dir456",
        sessionCorrelation: "ses789",
        kind: "permission",
        outcome: "suppressed",
        suppressionReason: "auto-permissions",
      });

      const parsed = JSON.parse(capturedOutput[0]);
      expect(parsed.event).toBe("notification_decided");
      expect(parsed.payload.kind).toBe("permission");
      expect(parsed.payload.outcome).toBe("suppressed");
      expect(parsed.payload.suppressionReason).toBe("auto-permissions");
    });

    it("emits webpush_delivery_finished correctly", () => {
      logAuditEvent("webpush_delivery_finished", {
        recordCorrelation: "rec123",
        sent: 2,
        failed: 1,
        expired: 0,
      });

      const parsed = JSON.parse(capturedOutput[0]);
      expect(parsed.event).toBe("webpush_delivery_finished");
      expect(parsed.payload.sent).toBe(2);
      expect(parsed.payload.failed).toBe(1);
      expect(parsed.payload.expired).toBe(0);
    });
  });

  describe("privacy/redaction guarantees", () => {
    /**
     * These tests verify that sensitive data never appears in audit logs.
     * The "poison" strings represent common sensitive patterns that must
     * be HMAC-hashed before logging.
     */
    const POISON_STRINGS = [
      // Directory paths
      "/Users/",
      "/home/",
      "/tmp/",
      "/var/",
      "C:\\",
      // Session IDs (various formats)
      "ses_",
      "session_",
      // Common secrets patterns
      "password",
      "secret",
      "token",
      "api_key",
      "apikey",
      // URLs
      "https://",
      "http://",
      // Email patterns
      "@",
      ".com",
    ];

    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let capturedOutput: string[];

    beforeEach(() => {
      capturedOutput = [];
      consoleLogSpy = vi.spyOn(console, "log").mockImplementation((message: string) => {
        capturedOutput.push(message);
      });
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });

    it("correlationId never returns the original sensitive value", () => {
      const sensitiveInputs = [
        "/Users/someone/Projects/secret-project",
        "ses_abc123xyz789",
        "https://api.example.com/endpoint?token=secret",
        "user@example.com",
      ];

      for (const input of sensitiveInputs) {
        const id = correlationId(input);
        expect(id).toBeDefined();
        // The correlation ID should never contain any substring of the input
        // that could identify it (beyond single hex chars that might coincide).
        expect(id).not.toContain(input.slice(0, 8));
        // And the original should never be recoverable
        for (const poison of POISON_STRINGS) {
          if (input.includes(poison)) {
            expect(id).not.toContain(poison);
          }
        }
      }
    });

    it("audit events with directory paths only log correlationIds", () => {
      const directory = "/Users/someone/Projects/dcaleon";
      const sessionID = "ses_abc123xyz789";
      const requestID = "req_sensitive_data_here";

      logAuditEvent("permission_asked_observed", {
        directoryCorrelation: correlationId(directory),
        sessionCorrelation: correlationId(sessionID),
        requestCorrelation: correlationId(requestID),
        autoApprovalEnabled: true,
      });

      expect(capturedOutput).toHaveLength(1);
      const output = capturedOutput[0];

      // Verify the raw sensitive values are NOT in the output
      expect(output).not.toContain(directory);
      expect(output).not.toContain(sessionID);
      expect(output).not.toContain(requestID);

      // Verify poison substrings are not present
      for (const poison of POISON_STRINGS) {
        expect(output).not.toContain(poison);
      }

      // Verify the output IS valid JSON with correlation IDs
      const parsed = JSON.parse(output);
      expect(parsed.payload.directoryCorrelation).toMatch(/^[0-9a-f]{16}$/);
      expect(parsed.payload.sessionCorrelation).toMatch(/^[0-9a-f]{16}$/);
      expect(parsed.payload.requestCorrelation).toMatch(/^[0-9a-f]{16}$/);
    });

    it("notification_decided never logs raw identifiers", () => {
      const recordID = "notif_rec_sensitive123";
      const directory = "/home/user/secret-project";
      const sessionID = "ses_should_not_appear";

      logAuditEvent("notification_decided", {
        recordCorrelation: correlationId(recordID),
        directoryCorrelation: correlationId(directory),
        sessionCorrelation: correlationId(sessionID),
        kind: "idle",
        outcome: "delivered",
        suppressionReason: undefined,
      });

      const output = capturedOutput[0];

      // Raw values must not appear
      expect(output).not.toContain(recordID);
      expect(output).not.toContain(directory);
      expect(output).not.toContain(sessionID);

      // No path-like or ID-like patterns
      for (const poison of POISON_STRINGS) {
        expect(output).not.toContain(poison);
      }
    });

    it("webpush_delivery_finished only logs counts, not endpoints", () => {
      // Webpush endpoints contain sensitive URLs
      const recordID = "rec_12345";

      logAuditEvent("webpush_delivery_finished", {
        recordCorrelation: correlationId(recordID),
        sent: 5,
        failed: 2,
        expired: 1,
      });

      const output = capturedOutput[0];
      const parsed = JSON.parse(output);

      // Only correlation IDs and numeric counts
      expect(parsed.payload.recordCorrelation).toMatch(/^[0-9a-f]{16}$/);
      expect(typeof parsed.payload.sent).toBe("number");
      expect(typeof parsed.payload.failed).toBe("number");
      expect(typeof parsed.payload.expired).toBe("number");

      // No sensitive URL patterns
      expect(output).not.toContain("fcm.googleapis.com");
      expect(output).not.toContain("push.services.mozilla.com");
      expect(output).not.toContain("web.push.apple.com");
      expect(output).not.toContain("notify.windows.com");
    });

    it("auto_approval_restore_completed logs only counts and enum outcomes", () => {
      logAuditEvent("auto_approval_restore_completed", {
        restoredCount: 10,
        outcome: "success",
      });

      const output = capturedOutput[0];
      const parsed = JSON.parse(output);

      // Only safe primitive values
      expect(typeof parsed.payload.restoredCount).toBe("number");
      expect(["success", "file_not_found", "parse_error", "stat_error"]).toContain(parsed.payload.outcome);

      // No paths even though this is about loading a state file
      for (const poison of POISON_STRINGS) {
        expect(output).not.toContain(poison);
      }
    });

    it("auto_approval_reply only logs outcome enum, not permission details", () => {
      const directory = "/path/to/project";
      const requestID = "req_with_permission_name_bash_execute";

      logAuditEvent("auto_approval_reply", {
        directoryCorrelation: correlationId(directory),
        requestCorrelation: correlationId(requestID),
        outcome: "approved",
      });

      const output = capturedOutput[0];

      // No path or request details
      expect(output).not.toContain(directory);
      expect(output).not.toContain(requestID);
      expect(output).not.toContain("bash");
      expect(output).not.toContain("execute");
      expect(output).not.toContain("permission");

      // Outcome is from the closed vocabulary
      const parsed = JSON.parse(output);
      expect(["approved", "already_handled", "not_found", "error"]).toContain(parsed.payload.outcome);
    });
  });

  describe("allowlist enforcement", () => {
    /**
     * Verify that ONLY allowlisted fields appear in audit output.
     * This is the complement to the redaction tests above.
     */
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let capturedOutput: string[];

    beforeEach(() => {
      capturedOutput = [];
      consoleLogSpy = vi.spyOn(console, "log").mockImplementation((message: string) => {
        capturedOutput.push(message);
      });
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });

    const ALLOWED_TOP_LEVEL_KEYS = ["ts", "audit", "event", "payload"];
    const ALLOWED_AUTO_APPROVAL_RESTORE_KEYS = ["restoredCount", "outcome"];
    const ALLOWED_PERMISSION_ASKED_KEYS = ["directoryCorrelation", "sessionCorrelation", "requestCorrelation", "autoApprovalEnabled"];
    const ALLOWED_AUTO_APPROVAL_REPLY_KEYS = ["directoryCorrelation", "requestCorrelation", "outcome"];
    const ALLOWED_NOTIFICATION_DECIDED_KEYS = ["recordCorrelation", "directoryCorrelation", "sessionCorrelation", "kind", "outcome", "suppressionReason"];
    const ALLOWED_WEBPUSH_DELIVERY_KEYS = ["recordCorrelation", "sent", "failed", "expired"];

    it("auto_approval_restore_completed has exactly the allowed payload keys", () => {
      logAuditEvent("auto_approval_restore_completed", {
        restoredCount: 5,
        outcome: "success",
      });

      const parsed = JSON.parse(capturedOutput[0]);
      expect(Object.keys(parsed).sort()).toEqual(ALLOWED_TOP_LEVEL_KEYS.sort());
      expect(Object.keys(parsed.payload).sort()).toEqual(ALLOWED_AUTO_APPROVAL_RESTORE_KEYS.sort());
    });

    it("permission_asked_observed has exactly the allowed payload keys", () => {
      logAuditEvent("permission_asked_observed", {
        directoryCorrelation: "abc",
        sessionCorrelation: "def",
        requestCorrelation: "ghi",
        autoApprovalEnabled: false,
      });

      const parsed = JSON.parse(capturedOutput[0]);
      expect(Object.keys(parsed).sort()).toEqual(ALLOWED_TOP_LEVEL_KEYS.sort());
      expect(Object.keys(parsed.payload).sort()).toEqual(ALLOWED_PERMISSION_ASKED_KEYS.sort());
    });

    it("auto_approval_reply has exactly the allowed payload keys", () => {
      logAuditEvent("auto_approval_reply", {
        directoryCorrelation: "abc",
        requestCorrelation: "def",
        outcome: "approved",
      });

      const parsed = JSON.parse(capturedOutput[0]);
      expect(Object.keys(parsed).sort()).toEqual(ALLOWED_TOP_LEVEL_KEYS.sort());
      expect(Object.keys(parsed.payload).sort()).toEqual(ALLOWED_AUTO_APPROVAL_REPLY_KEYS.sort());
    });

    it("notification_decided has exactly the allowed payload keys", () => {
      logAuditEvent("notification_decided", {
        recordCorrelation: "abc",
        directoryCorrelation: "def",
        sessionCorrelation: "ghi",
        kind: "idle",
        outcome: "delivered",
        suppressionReason: undefined,
      });

      const parsed = JSON.parse(capturedOutput[0]);
      expect(Object.keys(parsed).sort()).toEqual(ALLOWED_TOP_LEVEL_KEYS.sort());
      // suppressionReason may be undefined and thus not serialized
      const payloadKeys = Object.keys(parsed.payload).sort();
      const expectedKeys = ALLOWED_NOTIFICATION_DECIDED_KEYS.filter(k => k !== "suppressionReason").sort();
      expect(payloadKeys).toEqual(expectedKeys);
    });

    it("notification_decided with suppression includes suppressionReason", () => {
      logAuditEvent("notification_decided", {
        recordCorrelation: "abc",
        directoryCorrelation: "def",
        sessionCorrelation: "ghi",
        kind: "permission",
        outcome: "suppressed",
        suppressionReason: "subagent",
      });

      const parsed = JSON.parse(capturedOutput[0]);
      expect(Object.keys(parsed.payload).sort()).toEqual(ALLOWED_NOTIFICATION_DECIDED_KEYS.sort());
    });

    it("webpush_delivery_finished has exactly the allowed payload keys", () => {
      logAuditEvent("webpush_delivery_finished", {
        recordCorrelation: "abc",
        sent: 1,
        failed: 0,
        expired: 0,
      });

      const parsed = JSON.parse(capturedOutput[0]);
      expect(Object.keys(parsed).sort()).toEqual(ALLOWED_TOP_LEVEL_KEYS.sort());
      expect(Object.keys(parsed.payload).sort()).toEqual(ALLOWED_WEBPUSH_DELIVERY_KEYS.sort());
    });
  });
});
