import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { splitReminderTags as clientSplitReminderTags } from "../client/lib/reminders.js";
import { REMINDER_GROUPS, groupReminders } from "../client/lib/reminderCatalogue.js";
import { isKnownAppRoute } from "../client/lib/workflows.js";
import { reminderCatalogue } from "../server/reminders/loader.js";
import { workflowCatalogue } from "../server/workflows/workflows.js";
import {
  REMINDER_BODY_MAX,
  REMINDER_DESCRIPTION_MAX,
  REMINDER_TITLE_MAX,
  isValidReminderId,
  parseReminderMarkdown,
  reminderTag,
  splitReminderTags,
  withReminderTag,
  type ReminderPreset,
} from "../server/reminders/reminders.js";

const preset = (id: string, body: string): ReminderPreset => ({
  id,
  title: `${id} title`,
  description: `${id} description`,
  body,
  triggers: [],
});

describe("parseReminderMarkdown", () => {
  it("parses the stock SKILL.md shape", () => {
    expect(parseReminderMarkdown("cite-file-lines", [
      "---", "name: cite-file-lines", "description: Cite code as file:line.", "---", "", "Body one.", "", "Body two.",
    ].join("\n"))).toEqual({
      id: "cite-file-lines",
      title: "Cite File Lines",
      description: "Cite code as file:line.",
      body: "Body one.\n\nBody two.",
      triggers: [],
      tags: [],
      source: undefined,
    });
  });

  it("parses a comma-separated tag list, deduplicated and lowercased", () => {
    const parsed = parseReminderMarkdown("tagged", [
      "---", "name: tagged", "description: A tagged reminder.", "tags: Research, subagents , research", "---", "", "Body.",
    ].join("\n"));
    expect(parsed?.tags).toEqual(["research", "subagents"]);
  });

  it("rejects a preset whose tags are malformed or overlong", () => {
    const withTags = (tags: string) => parseReminderMarkdown("tagged", [
      "---", "name: tagged", "description: A tagged reminder.", `tags: ${tags}`, "---", "", "Body.",
    ].join("\n"));
    // Rejecting beats silently shipping an unfilterable reminder.
    expect(withTags("Not A Tag")).toBeNull();
    expect(withTags("trailing-")).toBeNull();
    expect(withTags("one, two, three, four")).toBeNull();
  });

  it("parses provenance without adding it to the reminder body", () => {
    const parsed = parseReminderMarkdown("imported", [
      "---",
      "name: imported",
      "title: Imported reminder",
      "description: A reminder imported from a source skill.",
      "source_repo: https://github.com/example/skills",
      "source_path: skills/imported/SKILL.md",
      "source_commit: 0123456789abcdef0123456789abcdef01234567",
      "---",
      "",
      "Apply the useful instruction.",
    ].join("\n"));
    expect(parsed?.source).toEqual({
      repo: "https://github.com/example/skills",
      path: "skills/imported/SKILL.md",
      commit: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(parsed?.body).toBe("Apply the useful instruction.");
  });

  it("accepts provenance from an application-owned Playbook", () => {
    const parsed = parseReminderMarkdown("local", [
      "---",
      "name: local",
      "description: A reminder documented by this application.",
      "source_repo: https://github.com/leoncheng57/dcaleon",
      "source_path: agent-skills/commands/local.md",
      "source_commit: 0123456789abcdef0123456789abcdef01234567",
      "---",
      "",
      "Apply the documented instruction.",
    ].join("\n"));
    expect(parsed?.source).toEqual({
      repo: "https://github.com/leoncheng57/dcaleon",
      path: "agent-skills/commands/local.md",
      commit: "0123456789abcdef0123456789abcdef01234567",
    });
  });

  it("keeps triggers even though per-message injection ignores them", () => {
    const parsed = parseReminderMarkdown("duck-test", [
      "---", "name: duck-test", "description: Emit a duck.", "triggers:", "- duck", "- duck-test", "---", "", "Quack.",
    ].join("\n"));
    expect(parsed?.triggers).toEqual(["duck", "duck-test"]);
  });

  it("tolerates quoted scalars, CRLF and a BOM", () => {
    expect(parseReminderMarkdown(
      "quoted",
      "\uFEFF---\r\nname: \"quoted\"\r\ndescription: 'A quoted one.'\r\n---\r\n\r\nBody.\r\n",
    )).toMatchObject({ description: "A quoted one.", body: "Body." });
  });

  it("rejects malformed files and mismatched names", () => {
    expect(parseReminderMarkdown("good", "just a body")).toBeNull();
    expect(parseReminderMarkdown("good", ["---", "name: good", "description: d", "---", "", ""].join("\n"))).toBeNull();
    expect(parseReminderMarkdown("good", ["---", "name: other", "description: d", "---", "", "body"].join("\n"))).toBeNull();
    expect(parseReminderMarkdown("good", ["---", "description: d", "source_repo: https://example.test", "---", "body"].join("\n"))).toBeNull();
    expect(parseReminderMarkdown("good", [
      "---", "description: d", "source_repo: https://example.test", "source_path: ../SKILL.md", "source_commit: latest", "---", "body",
    ].join("\n"))).toBeNull();
    expect(parseReminderMarkdown("Bad_Id", ["---", "description: d", "---", "", "body"].join("\n"))).toBeNull();
  });
});

describe("isValidReminderId", () => {
  it("matches the OpenCode skill-name contract", () => {
    for (const valid of ["pdf", "cite-file-lines", "a1-b2"]) expect(isValidReminderId(valid)).toBe(true);
    for (const invalid of ["Cite", "a_b", "a--b", "-a", "a-", "", "../etc", 5]) expect(isValidReminderId(invalid)).toBe(false);
  });
});

describe("shipped catalogue", () => {
  const sourceCommit = "8b036a41f578dc6c6307ae0a8dd2857121afcabb";
  const importedIds = new Set([
    "ascii-diagrams",
    "background-subagent",
    "build-waves",
    "deep-research-subagents",
    "docs-and-diagram-tooling",
    "duck-mode",
    "grill-me",
    "human-verification-steps",
    "parallel-research-handoff",
    "session-handoff",
  ]);
  const dir = path.join(import.meta.dirname, "..", "reminders");
  const ids = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

  it("loads a non-empty runtime catalogue", () => {
    expect(reminderCatalogue().length).toBeGreaterThan(0);
  });

  it("has unique directory and parsed IDs", () => {
    expect(new Set(ids).size).toBe(ids.length);
    const parsedIds = reminderCatalogue().map(({ id }) => id);
    expect(new Set(parsedIds).size).toBe(parsedIds.length);
    expect(parsedIds).toHaveLength(ids.length);
  });

  // The retired command catalogue used to give every reminder a documentation
  // target, so the old invariant could demand total coverage. Workflows do not:
  // six of those commands were deleted rather than converted because the
  // reminder already said what they said. What must still hold is that every
  // link the picker renders resolves — a dead link is the failure this guards.
  // Parity replaces the old reminder-to-workflow join outright. That map linked
  // a reminder to a workflow that merely shared its subject, so most reminders
  // had no link at all; every reminder now has a page of its own.
  it("groups every shipped reminder, with nothing falling into Other", () => {
    const shipped = reminderCatalogue().map(({ id }) => id).sort();
    const named = REMINDER_GROUPS.flatMap(({ ids }) => ids).sort();
    expect(named).toEqual(shipped);
    expect(new Set(named).size, "a reminder is named by two groups").toBe(named.length);
  });

  it("routes every shipped reminder to its own known detail page", () => {
    for (const { id } of reminderCatalogue()) {
      expect(isKnownAppRoute(`/playbooks/reminders/${id}`), `${id} has no routable detail page`).toBe(true);
    }
  });

  it("keeps a reminder a newer server ships visible rather than dropping it", () => {
    const summary = (id: string) => ({ id, title: id, description: "", triggers: [], tags: [], body: "b" });
    const grouped = groupReminders([summary("grill-me"), summary("brand-new-reminder")]);
    expect(grouped.at(-1)).toEqual({ label: "Other", reminders: [summary("brand-new-reminder")] });
  });

  it("keeps reminder tags application-owned and non-empty", () => {
    for (const { id, tags } of reminderCatalogue()) {
      expect(tags.length, `reminders/${id} declares no tags`).toBeGreaterThan(0);
    }
  });

  it.each(ids)("%s parses and has bounded, safe content", (id) => {
    const parsed = parseReminderMarkdown(id, readFileSync(path.join(dir, id, "SKILL.md"), "utf8"));
    expect(parsed, `reminders/${id}/SKILL.md failed to parse`).not.toBeNull();
    expect(parsed!.title.length).toBeGreaterThan(3);
    expect(parsed!.title.length).toBeLessThanOrEqual(REMINDER_TITLE_MAX);
    expect(parsed!.description.length).toBeGreaterThan(10);
    expect(parsed!.description.length).toBeLessThanOrEqual(REMINDER_DESCRIPTION_MAX);
    expect(parsed!.body.length).toBeGreaterThan(20);
    expect(parsed!.body.length).toBeLessThanOrEqual(REMINDER_BODY_MAX);
    expect(parsed!.triggers).toEqual([]);
    expect(parsed!.body).not.toMatch(/\$\{|\{\{|<%|auto-(?:merge|push)|git\s+reset\s+--hard|git\s+push\s+(?:\S+\s+)?(?:main|master)\b|rm\s+-rf\s+\//i);
  });

  it("records complete, pinned provenance for every imported preset", () => {
    const catalogue = reminderCatalogue();
    expect(catalogue.filter(({ source }) => source)).toHaveLength(importedIds.size);
    for (const reminder of catalogue) {
      if (importedIds.has(reminder.id)) {
        expect(reminder.source).toEqual({
          repo: "https://github.com/leoncheng57/agent-skills",
          path: `skills/${reminder.id}/SKILL.md`,
          commit: sourceCommit,
        });
        expect(reminder.body).not.toContain(sourceCommit);
        expect(reminder.body).not.toContain(reminder.source!.repo);
        continue;
      }
      // cite-file-lines and native-worktree-subagents used to cite the
      // repository command they were written beside. Those files are gone, so
      // the citation is dropped rather than left pointing at a path that no
      // longer exists on the default branch; they are now ordinary local
      // presets, which is what reminders/README.md already calls them.
      expect(reminder.source, `${reminder.id} declares unexpected provenance`).toBeUndefined();
    }
  });

  it("ships the native worktree workflow with fail-closed repository guards", () => {
    const reminder = reminderCatalogue().find(({ id }) => id === "native-worktree-subagents");
    expect(reminder).toBeDefined();
    expect(reminder!.body).toContain("fresh Build-only session");
    expect(reminder!.body).toContain("every Bash call sets `workdir`");
    expect(reminder!.body).toContain("every read, edit, and patch uses an absolute path");
    expect(reminder!.body).toContain("git rev-parse --show-toplevel");
    expect(reminder!.body).toContain("stop without mutation");
    expect(reminder!.body).toContain("instead of substituting an independent root session");
  });
});

describe("reminderTag / withReminderTag", () => {
  const reminder = preset("sample", "Do not force-push.");

  it("wraps and appends the server-resolved body", () => {
    expect(reminderTag(reminder)).toBe('<reminder name="sample">\nDo not force-push.\n</reminder>');
    expect(withReminderTag("now push it", reminder)).toBe(
      'now push it\n\n<reminder name="sample">\nDo not force-push.\n</reminder>',
    );
  });
});

const splitCases: Array<[string, { text: string; reminders: Array<{ name: string; body: string }> }]> = [
  ["plain message", { text: "plain message", reminders: [] }],
  ["", { text: "", reminders: [] }],
  ['do it\n\n<reminder name="alpha">\nFirst rule.\n</reminder>', { text: "do it", reminders: [{ name: "alpha", body: "First rule." }] }],
  ['go\n\n<reminder name="alpha">\nA\n</reminder>\n\n<reminder name="beta-two">\nB\n</reminder>', { text: "go", reminders: [{ name: "alpha", body: "A" }, { name: "beta-two", body: "B" }] }],
  ['<reminder name="alpha">\nline one\n\nline two\n</reminder>', { text: "", reminders: [{ name: "alpha", body: "line one\n\nline two" }] }],
  ['hi <reminder name="Bad_Id">x</reminder>', { text: 'hi <reminder name="Bad_Id">x</reminder>', reminders: [] }],
  ['hi <reminder name="alpha">x', { text: 'hi <reminder name="alpha">x', reminders: [] }],
  ['<reminder name="alpha">\nA\n</reminder>\ntrailing', { text: "trailing", reminders: [{ name: "alpha", body: "A" }] }],
];

describe("splitReminderTags", () => {
  it("keeps server and client implementations in lockstep", () => {
    for (const [input, expected] of splitCases) {
      expect(splitReminderTags(input), `server input: ${JSON.stringify(input)}`).toEqual(expected);
      expect(clientSplitReminderTags(input), `client input: ${JSON.stringify(input)}`).toEqual(expected);
    }
  });

  it("round-trips every shipped preset through both implementations", () => {
    for (const reminder of reminderCatalogue()) {
      const wrapped = withReminderTag("go", reminder);
      const expected = { text: "go", reminders: [{ name: reminder.id, body: reminder.body }] };
      expect(splitReminderTags(wrapped)).toEqual(expected);
      expect(clientSplitReminderTags(wrapped)).toEqual(expected);
    }
  });
});
