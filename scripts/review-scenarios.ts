/** Data only: this catalogue can be read by the trusted publisher without running a test. */
export interface ReviewStep {
  testId: string;
  action: "click" | "fill" | "visible" | "text";
  value?: string;
}
export interface ReviewScenario {
  id: string;
  title: string;
  route: string;
  steps: ReviewStep[];
  /** A visible element, not the surrounding viewport. Omit for full-page capture. */
  target?: string;
}

export const REVIEW_SCENARIOS: readonly ReviewScenario[] = [
  {
    id: "claude-bounded-history", title: "Claude — bounded transcript and history navigation", route: "/claude",
    steps: [
      { testId: "claude-create", action: "click" },
      { testId: "claude-prompt", action: "fill", value: "Show the performance gallery" },
      { testId: "claude-send", action: "click" },
      { testId: "claude-transcript", action: "text", value: "Performance fixture complete" },
      { testId: "claude-search-history", action: "click" },
      { testId: "claude-history-close", action: "click" },
      { testId: "claude-history-controls", action: "text", value: "50 of 234 events loaded" },
    ],
  },
  {
    id: "claude-history-search", title: "Claude — search finds a file reference outside loaded history", route: "/claude",
    steps: [
      { testId: "claude-create", action: "click" },
      { testId: "claude-prompt", action: "fill", value: "Show the performance gallery" },
      { testId: "claude-send", action: "click" },
      { testId: "claude-transcript", action: "text", value: "Performance fixture complete" },
      { testId: "claude-search-history", action: "click" },
      { testId: "claude-history-query", action: "fill", value: "Historical reference" },
      { testId: "claude-history-search", action: "click" },
      { testId: "claude-history-results", action: "text", value: "Historical reference" },
    ],
    target: "claude-history",
  },
  {
    id: "design-gallery", title: "Design library — mobile-first foundations", route: "/design-components",
    steps: [{ testId: "opencode-design-components", action: "text", value: "Small screens. Shared details." }],
  },
  {
    id: "design-panel", title: "Design library — shared Minichats placeholder", route: "/design-components",
    steps: [
      { testId: "design-panel-open", action: "click" },
      { testId: "design-panel-selector", action: "click" },
      { testId: "design-panel-selector-minichats", action: "click" },
      { testId: "design-panel", action: "text", value: "Minichats is a work-in-progress destination." },
    ],
    target: "design-panel",
  },
  {
    id: "hub-projects", title: "Hub — expanded project picker", route: "/opencode?directory=/tmp/mock-project",
    steps: [{ testId: "opencode-project-picker-toggle", action: "click" }, { testId: "opencode-project-list", action: "text", value: "mock-project" }],
    target: "opencode-project-picker",
  },
  {
    id: "session-todo", title: "Session — populated Todo panel", route: "/sessions/ses_mock_done?directory=/tmp/mock-project&panel=todo",
    steps: [{ testId: "opencode-todo-list", action: "text", value: "done" }], target: "opencode-todo-list",
  },
  {
    id: "planning-create", title: "Planning — new issue dialog", route: "/planning?create=1",
    steps: [{ testId: "opencode-planning-label-list", action: "text", value: "frontend" }], target: "opencode-planning-create-dialog",
  },
  {
    id: "planning-page", title: "Planning — priority queue", route: "/planning",
    steps: [{ testId: "opencode-planning-list", action: "text", value: "priority" }],
  },
  {
    id: "settings-page", title: "Settings — effective configuration", route: "/settings?directory=/tmp/mock-project",
    steps: [{ testId: "opencode-setting-subagent-depth", action: "visible" }],
  },
];

export function reviewScenario(id: string): ReviewScenario {
  const scenario = REVIEW_SCENARIOS.find(item => item.id === id);
  if (!scenario) throw new Error(`unknown review scenario: ${id}`);
  return scenario;
}

/** Unknown runtime changes get a baseline plus an explicit local-review requirement. */
export function selectReviewScenarios(files: string[]): { ids: string[]; reason: string; needsLocalReview: boolean } {
  if (files.length > 5000) throw new Error("changed-file list exceeds 5000 paths");
  const visual = files.filter(file => /^(client\/|server\/|scripts\/(?:review-|pr-screenshots|run-pr-screenshots)|tests\/e2e\/mock-|package(?:-lock)?\.json|vite\.config)/.test(file));
  if (!visual.length) return { ids: [], reason: "No application or visual tooling changes detected; screenshots skipped.", needsLocalReview: false };
  const ids = new Set<string>();
  let unknown = false;
  for (const file of visual) {
    if (/DesignComponents|design-components|client\/ds\/(?:responsive-panel|panel-selector|panel-state)|client\/theme\/motion/i.test(file)) { ids.add("design-gallery"); ids.add("design-panel"); }
    else if (/Planning|planning/i.test(file)) { ids.add("planning-page"); ids.add("planning-create"); }
    else if (/Settings|settings/i.test(file)) ids.add("settings-page");
    else if (/Hub|projects/i.test(file)) ids.add("hub-projects");
    else if (/session-inspector|inspectorTabs|todos/i.test(file)) ids.add("session-todo");
    else { unknown = true; ids.add("hub-projects"); ids.add("session-todo"); }
  }
  return {
    ids: [...ids], needsLocalReview: unknown,
    reason: unknown ? "Baseline coverage includes shared or unmapped changes. A local agent must review the diff and add relevant states; CI has no AI keys." : "Selected curated scenarios for the changed surfaces.",
  };
}
