import { defineConfig } from "vitest/config";

// Separate from vite.config.ts: the app's Vite root is client/, but unit
// tests live in tests/ at the repo root and exercise server code too.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    env: {
      // Without this, the first correlationId() call would create the repo's
      // real `.state/notification-audit-hmac.key`; the env key never touches disk.
      NOTIFICATION_AUDIT_HMAC_KEY: "vitest-audit-hmac-key",
    },
  },
});
