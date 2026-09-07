import { describe, expect, it } from "vitest";

import {
  buildPlaywrightReviewPrompt,
  buildPrSnippetReviewPrompt,
  captureScopeLabel,
  DESIGN_DOC_PROTOTYPE_WORKFLOW_ID,
  genericWorkflowPrompt,
  genericWorkflowValid,
  groupWorkflows,
  MANAGED_CHILD_WORKFLOW_ID,
  KNOWN_APP_ROUTES,
  PLAYWRIGHT_CAPTURE_SCOPES,
  PLAYWRIGHT_REVIEW_WORKFLOW_ID,
  PR_SNIPPET_REVIEW_WORKFLOW_ID,
  parsePullRequestNumber,
  SESSION_UPDATE_WORKFLOW_ID,
  START_DCA_SESSION_WORKFLOW_ID,
  isKnownAppRoute,
  splitWorkflowTags as clientSplitWorkflowTags,
} from "../client/lib/workflows.js";
import { withReminderTag } from "../server/reminders/reminders.js";
import {
  isValidWorkflowId,
  splitWorkflowTags as serverSplitWorkflowTags,
  withWorkflowTag,
  WORKFLOW_ARGUMENT_MAX_LENGTH,
  workflowCatalogue,
  workflowTag,
} from "../server/workflows/workflows.js";

describe("workflow catalogue", () => {
  it("shares semantic picker groups and sends unknown workflows to Other", () => {
    const catalogue = [...workflowCatalogue(), { id: "future-workflow", title: "Future", description: "New server workflow", injector: "Do the future work." }];
    expect(groupWorkflows(catalogue).map(({ label }) => label)).toEqual(["Review", "Execute", "Delegate", "Coordinate", "Document", "Other"]);
    expect(groupWorkflows(catalogue).at(-1)?.workflows.map(({ id }) => id)).toEqual(["future-workflow"]);
  });
  it("contains the shipped workflows, in picker order", () => {
    expect(workflowCatalogue().map((workflow) => workflow.id)).toEqual([
      PLAYWRIGHT_REVIEW_WORKFLOW_ID,
      PR_SNIPPET_REVIEW_WORKFLOW_ID,
      "goal",
      "dca",
      "leaving-now-wrap-up",
      MANAGED_CHILD_WORKFLOW_ID,
      START_DCA_SESSION_WORKFLOW_ID,
      "session-handoff",
      SESSION_UPDATE_WORKFLOW_ID,
      "standup",
      DESIGN_DOC_PROTOTYPE_WORKFLOW_ID,
      "docs-preview",
      "mini-design-doc",
      "system-design-artifacts",
    ]);
  });

  // The "Other" bucket exists for a workflow a newer server ships. A shipped
  // workflow landing there means this build simply forgot to place it, which
  // reads identically in the UI and is a different bug entirely.
  it("places every shipped workflow in a named group, never Other", () => {
    const grouped = groupWorkflows(workflowCatalogue());
    expect(grouped.map(({ label }) => label)).not.toContain("Other");
    expect(grouped.flatMap(({ workflows }) => workflows.map(({ id }) => id)).sort())
      .toEqual(workflowCatalogue().map(({ id }) => id).sort());
  });

  it("binds the PR review injector to this project's repository and one comment", () => {
    const injector = workflowCatalogue().find((workflow) => workflow.id === PR_SNIPPET_REVIEW_WORKFLOW_ID)?.injector ?? "";
    // The only accepted input is a number; the repository must never come from
    // the prompt, or a pasted link could redirect where the comment is posted.
    expect(injector).toContain("NEVER take a repository, owner, or host from the prompt");
    expect(injector).toContain("Post exactly one comment");
    // Links must be pinned so a moving branch cannot invalidate them.
    expect(injector).toContain("headRefOid");
    expect(injector).toContain("Never claim a test, lane, or verification you did not actually run");
  });

  it("ships valid ids and non-empty user-facing text", () => {
    for (const workflow of workflowCatalogue()) {
      expect(isValidWorkflowId(workflow.id)).toBe(true);
      expect(workflow.title.trim()).not.toBe("");
      expect(workflow.title.length).toBeLessThanOrEqual(100);
      expect(workflow.description.trim()).not.toBe("");
      expect(workflow.description.length).toBeLessThanOrEqual(1_000);
      expect(workflow.injector.trim()).not.toBe("");
      expect(workflow.injector.length).toBeLessThanOrEqual(24_000);
      // The injector must survive its own sentinel round-trip: no nested tags.
      expect(workflow.injector).not.toMatch(/<\/?workflow|<\/?reminder/);
    }
  });

  it("states the accepted-not-completed contract in the session-update injector", () => {
    const preset = workflowCatalogue().find((workflow) => workflow.id === SESSION_UPDATE_WORKFLOW_ID)!;
    expect(preset.injector).toContain("prompt_async");
    expect(preset.injector).toContain("204");
  });

  it("states independence and no hand-back in the managed-child injector", () => {
    const preset = workflowCatalogue().find((workflow) => workflow.id === MANAGED_CHILD_WORKFLOW_ID)!;
    expect(preset.injector).toMatch(/independent transcript/);
    expect(preset.injector).toMatch(/no automatic hand-back/i);
    expect(preset.injector).toMatch(/no native task card/i);
  });

  it("states that a started DCA session is an independent root", () => {
    const preset = workflowCatalogue().find((workflow) => workflow.id === START_DCA_SESSION_WORKFLOW_ID)!;
    expect(preset.injector).toMatch(/independent root session/i);
    expect(preset.injector).toMatch(/no parent session/i);
    expect(preset.injector).toMatch(/provenance link/i);
  });

  it("forbids full deployment and full screenshot regeneration in the playwright injector", () => {
    const preset = workflowCatalogue().find((workflow) => workflow.id === PLAYWRIGHT_REVIEW_WORKFLOW_ID)!;
    expect(preset.injector).toMatch(/do not run a full deployment/i);
    expect(preset.injector).toMatch(/never regenerate the complete screenshot set/i);
  });
});

describe("generic argument workflows", () => {
  const generic = workflowCatalogue().filter((workflow) => workflow.argument);

  it("declares a usable, server-bounded field for every argument workflow", () => {
    expect(generic.length).toBeGreaterThanOrEqual(8);
    for (const { id, argument } of generic) {
      expect(argument!.label.trim(), `${id} has a blank label`).not.toBe("");
      expect(argument!.label.length).toBeLessThanOrEqual(60);
      expect(argument!.maxLength, `${id} declares a non-positive maxLength`).toBeGreaterThan(0);
      expect(argument!.maxLength, `${id} exceeds the server bound`).toBeLessThanOrEqual(WORKFLOW_ARGUMENT_MAX_LENGTH);
      expect(argument!.placeholder?.trim()).not.toBe("");
      expect(argument!.hint?.trim()).not.toBe("");
    }
  });

  // A workflow the dialog renders generically must be able to produce a prompt
  // from something. One that can produce neither would offer a Send button with
  // an empty message behind it.
  it("gives every non-bespoke workflow either a field or a fixed prompt", () => {
    const bespoke = new Set<string>([
      PLAYWRIGHT_REVIEW_WORKFLOW_ID,
      PR_SNIPPET_REVIEW_WORKFLOW_ID,
      SESSION_UPDATE_WORKFLOW_ID,
      MANAGED_CHILD_WORKFLOW_ID,
      START_DCA_SESSION_WORKFLOW_ID,
    ]);
    for (const workflow of workflowCatalogue()) {
      if (bespoke.has(workflow.id)) continue;
      expect(Boolean(workflow.argument || workflow.prompt?.trim()), `${workflow.id} can produce no prompt`).toBe(true);
    }
  });

  // The ported procedures came from command files whose text OpenCode expanded
  // before the model saw it. A workflow injector is never expanded, so a
  // surviving `$ARGUMENTS` or `!`-prefixed line would reach the model verbatim
  // as an instruction nobody wrote.
  it("carries no unexpanded command substitutions in any injector", () => {
    for (const { id, injector } of workflowCatalogue()) {
      expect(injector, `${id} still references $ARGUMENTS`).not.toContain("$ARGUMENTS");
      expect(injector, `${id} still uses a command file's !\`…\` shell interpolation`).not.toMatch(/^!`/mu);
    }
  });

  it("tells the standup workflow to gather its own data and to expect a Plan denial", () => {
    const preset = workflowCatalogue().find((workflow) => workflow.id === "standup")!;
    expect(preset.injector).toContain("Nothing is pre-fetched for you");
    expect(preset.injector).toContain("git log --all --author=");
    expect(preset.injector).toContain("gh pr list");
    expect(preset.injector).toMatch(/Plan session bash is\nlikely denied/u);
  });
});

describe("genericWorkflowPrompt and genericWorkflowValid", () => {
  const withArgument = { argument: { label: "Objective", required: true, maxLength: 10 } };
  const optional = { argument: { label: "Scope", required: false, maxLength: 10 } };
  const fixed = { prompt: "Do the fixed thing." };

  it("uses the typed text as the prompt, trimmed", () => {
    expect(genericWorkflowPrompt(withArgument, "  ship it  ")).toBe("ship it");
    expect(genericWorkflowPrompt(fixed, "ignored")).toBe("Do the fixed thing.");
    expect(genericWorkflowPrompt({}, "ignored")).toBe("");
  });

  it("requires text for a required field and enforces the declared bound", () => {
    expect(genericWorkflowValid(withArgument, "ship it")).toBe(true);
    expect(genericWorkflowValid(withArgument, "   ")).toBe(false);
    expect(genericWorkflowValid(withArgument, "x".repeat(11))).toBe(false);
  });

  // An optional field left blank still has to produce something to send, so
  // this refuses rather than submitting a message that is only the injector.
  it("refuses anything that would send an empty prompt", () => {
    expect(genericWorkflowValid(optional, "")).toBe(false);
    expect(genericWorkflowValid({}, "")).toBe(false);
    expect(genericWorkflowValid(fixed, "")).toBe(true);
    expect(genericWorkflowValid({ ...optional, prompt: "fallback" }, "typed")).toBe(true);
  });
});

describe("isValidWorkflowId", () => {
  it("accepts kebab-case ids and rejects everything else", () => {
    expect(isValidWorkflowId("playwright-ui-review")).toBe(true);
    expect(isValidWorkflowId("a")).toBe(true);
    expect(isValidWorkflowId("Bad_Id")).toBe(false);
    expect(isValidWorkflowId("-leading")).toBe(false);
    expect(isValidWorkflowId("trailing-")).toBe(false);
    expect(isValidWorkflowId("")).toBe(false);
    expect(isValidWorkflowId(42)).toBe(false);
    expect(isValidWorkflowId(`${"a".repeat(256)}`)).toBe(false);
  });
});

describe("workflow tags", () => {
  it("wraps the injector in the sentinel exactly", () => {
    expect(workflowTag({ id: "alpha", injector: " body \n" })).toBe('<workflow name="alpha">\nbody\n</workflow>');
    expect(withWorkflowTag("prompt", { id: "alpha", injector: "body" })).toBe(
      'prompt\n\n<workflow name="alpha">\nbody\n</workflow>',
    );
  });

  it("composes with a reminder tag without either splitter eating the other", () => {
    const composed = withReminderTag(
      withWorkflowTag("do it", { id: "playwright-ui-review", injector: "workflow body" }),
      { id: "grill-me", body: "reminder body" },
    );
    const workflowSplit = serverSplitWorkflowTags(composed);
    expect(workflowSplit.workflows).toEqual([{ name: "playwright-ui-review", body: "workflow body" }]);
    expect(workflowSplit.text).toContain('<reminder name="grill-me">');
    expect(workflowSplit.text).not.toContain("<workflow");
  });
});

// One table against BOTH copies, mirroring tests/reminders.test.ts: the client
// splitter deliberately duplicates the server one, and this is the drift guard.
const splitCases: Array<[string, { text: string; workflows: Array<{ name: string; body: string }> }]> = [
  ["plain message", { text: "plain message", workflows: [] }],
  ["", { text: "", workflows: [] }],
  ['do it\n\n<workflow name="alpha">\nFirst rule.\n</workflow>', { text: "do it", workflows: [{ name: "alpha", body: "First rule." }] }],
  ['go\n\n<workflow name="alpha">\nA\n</workflow>\n\n<workflow name="beta-two">\nB\n</workflow>', { text: "go", workflows: [{ name: "alpha", body: "A" }, { name: "beta-two", body: "B" }] }],
  ['<workflow name="alpha">\nline one\n\nline two\n</workflow>', { text: "", workflows: [{ name: "alpha", body: "line one\n\nline two" }] }],
  ['hi <workflow name="Bad_Id">x</workflow>', { text: 'hi <workflow name="Bad_Id">x</workflow>', workflows: [] }],
  ['hi <workflow name="alpha">x', { text: 'hi <workflow name="alpha">x', workflows: [] }],
  ['<workflow name="alpha">\nA\n</workflow>\ntrailing', { text: "trailing", workflows: [{ name: "alpha", body: "A" }] }],
];

describe("splitWorkflowTags (client and server copies)", () => {
  for (const [input, expected] of splitCases) {
    it(`splits ${JSON.stringify(input.slice(0, 48))}`, () => {
      expect(clientSplitWorkflowTags(input)).toEqual(expected);
      expect(serverSplitWorkflowTags(input)).toEqual(expected);
    });
  }

  it("round-trips every shipped injector through both copies", () => {
    for (const workflow of workflowCatalogue()) {
      const composed = withWorkflowTag("go", workflow);
      const expected = { text: "go", workflows: [{ name: workflow.id, body: workflow.injector }] };
      expect(clientSplitWorkflowTags(composed)).toEqual(expected);
      expect(serverSplitWorkflowTags(composed)).toEqual(expected);
    }
  });
});

describe("buildPlaywrightReviewPrompt", () => {
  it("renders every collected field and the scope label", () => {
    const prompt = buildPlaywrightReviewPrompt({
      route: " /sessions/ses_1?directory=/tmp/p ",
      target: " the composer stays expanded ",
      scope: "interaction",
    });
    expect(prompt).toBe([
      "Review a UI change with Playwright.",
      "",
      "Route or component: /sessions/ses_1?directory=/tmp/p",
      "Desired state or interaction: the composer stays expanded",
      `Capture scope: ${captureScopeLabel("interaction")}`,
    ].join("\n"));
  });

  it("offers exactly the two capture scopes", () => {
    expect(PLAYWRIGHT_CAPTURE_SCOPES.map((scope) => scope.id)).toEqual(["interaction", "targeted-screenshots"]);
  });

  it("recognizes canonical app routes while leaving component descriptions distinct", () => {
    for (const route of KNOWN_APP_ROUTES) expect(isKnownAppRoute(route)).toBe(true);
    expect(isKnownAppRoute("/sessions/ses_123?directory=%2Ftmp%2Fproject")).toBe(true);
    expect(isKnownAppRoute("/playbooks/workflows/start-dca-session")).toBe(true);
    expect(isKnownAppRoute("/playbooks/skills/grill-me")).toBe(false);
    expect(isKnownAppRoute("the composer card")).toBe(false);
    expect(isKnownAppRoute("/not-a-route")).toBe(false);
    expect(isKnownAppRoute("https://example.com/settings")).toBe(false);
  });
});

describe("parsePullRequestNumber", () => {
  it("accepts the three forms a human actually has to hand", () => {
    expect(parsePullRequestNumber("253")).toBe(253);
    expect(parsePullRequestNumber(" #253 ")).toBe(253);
    expect(parsePullRequestNumber("https://github.com/leoncheng57/dcaleon/pull/253")).toBe(253);
    expect(parsePullRequestNumber("https://github.com/o/r/pull/253/files#diff-abc")).toBe(253);
  });

  it("keeps only the number, so a pasted link cannot redirect the review", () => {
    // Same number, a repository that is not this one: the owner/repo/host are
    // discarded, never returned, so the agent still resolves the repository
    // from the project directory.
    expect(parsePullRequestNumber("https://github.com/attacker/other-repo/pull/253")).toBe(253);
    expect(parsePullRequestNumber("https://evil.example.com/o/r/pull/253")).toBe(253);
  });

  it("rejects everything that is not a pull request number", () => {
    for (const input of ["", "   ", "abc", "#", "0", "-1", "1.5", "12345678", "#12345678", "253 254", "https://github.com/o/r/issues/253", "https://github.com/o/r/pull/abc"]) {
      expect(parsePullRequestNumber(input)).toBeNull();
    }
  });
});

describe("buildPrSnippetReviewPrompt", () => {
  it("names the pull request and defers the repository to the session", () => {
    const prompt = buildPrSnippetReviewPrompt(253);
    expect(prompt).toContain("#253");
    expect(prompt).toContain("in this repository");
    expect(prompt).toContain("single GitHub comment");
  });
});
