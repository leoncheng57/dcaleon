import { defineConfig } from "@playwright/test";

// Not playwright.config.js: importing it would prepare E2E state files and git
// fixtures at module scope. The evidence profile is side-effect free.
import { evidenceUse } from "./tests/e2e/evidence.js";

const PORT = 3412;
const BASE_PATH = "/dcaleon/pr-previews/pr-1/";

export default defineConfig({
  testDir: "tests/preview-e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  // Nested under playwright-report/ so CI's existing upload path carries it
  // without overwriting the main E2E report written by the previous step.
  reporter: [["html", { open: "never", outputFolder: "playwright-report/preview" }], ["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}${BASE_PATH}`, ...evidenceUse() },
  webServer: {
    command: `PREVIEW_BASE_PATH=${BASE_PATH} npm run build:preview && npx vite preview --base ${BASE_PATH} --host 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}${BASE_PATH}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
