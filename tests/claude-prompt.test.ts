import { describe, expect, it } from "vitest";

import { composeClaudePrompt } from "../server/claude/prompt.js";
import { reminderTag } from "../server/reminders/reminders.js";
import { workflowTag } from "../server/workflows/workflows.js";

describe("composeClaudePrompt", () => {
  const reminder = { id: "cite-file-lines", body: "  Cite path:line.  " };
  const workflow = { id: "goal", injector: "Restate the goal first." };

  it("sends the bare prompt when nothing is attached", () => {
    expect(composeClaudePrompt({ text: "hi" })).toEqual({ text: "hi", reminders: [], workflows: [] });
  });

  it("adds generated image paths to the binary prompt without exposing them as chips", () => {
    const composed = composeClaudePrompt({ text: "describe this", imagePaths: ["/private/state/image-1.png"] });
    expect(composed.text).toContain("describe this\n\nThe user attached the following images");
    expect(composed.text).toContain('"/private/state/image-1.png"');
    expect(composed.reminders).toEqual([]);
    expect(composed.workflows).toEqual([]);
  });

  it("appends the workflow injector closest to the prompt and the reminder after it, like the OpenCode lane", () => {
    const composed = composeClaudePrompt({ text: "hi", reminder, workflow });
    expect(composed.text).toBe(`hi\n\n${workflowTag(workflow)}\n\n${reminderTag(reminder)}`);
    expect(composed.text.indexOf('<workflow name="goal">')).toBeLessThan(composed.text.indexOf('<reminder name="cite-file-lines">'));
  });

  it("returns the attached blocks as transcript chips with trimmed bodies", () => {
    const composed = composeClaudePrompt({ text: "hi", reminder, workflow });
    expect(composed.reminders).toEqual([{ name: "cite-file-lines", body: "Cite path:line." }]);
    expect(composed.workflows).toEqual([{ name: "goal", body: "Restate the goal first." }]);
  });
});
