// Failure-evidence profile shared by every Playwright lane (issues #393-#395).
//
// This module must stay side-effect free. playwright.preview.config.ts imports
// it instead of playwright.config.ts because the latter prepares E2E state files
// and repairs git fixtures at module scope, which the preview lane must not do.

type Env = Readonly<Record<string, string | undefined>>;

export type VideoMode = "off" | "on-first-retry" | "retain-on-failure";

// `retain-on-failure` encodes every test and deletes passing videos, so it is an
// opt-in for local debugging. CI uses `on-first-retry`, which records nothing on
// a green run and captures the retry where order-dependent failures reproduce.
export function videoMode(env: Env = process.env): VideoMode {
  if (env.E2E_VIDEO === "1") return "retain-on-failure";
  return env.CI ? "on-first-retry" : "off";
}

// Explicit size so a 390px mobile-viewport spec still yields a readable video.
export const VIDEO_SIZE = { width: 1280, height: 720 } as const;

export function evidenceUse(env: Env = process.env) {
  return {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: { mode: videoMode(env), size: VIDEO_SIZE },
  } as const;
}
