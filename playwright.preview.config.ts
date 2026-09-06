import { defineConfig } from "@playwright/test";

const PORT = 3412;
const BASE_PATH = "/dcaleon/pr-previews/pr-1/";

export default defineConfig({
  testDir: "tests/preview-e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}${BASE_PATH}`, trace: "retain-on-failure" },
  webServer: {
    command: `PREVIEW_BASE_PATH=${BASE_PATH} npm run build:preview && npx vite preview --base ${BASE_PATH} --host 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}${BASE_PATH}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
