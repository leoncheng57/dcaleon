import type { ReminderPreset } from "../reminders/reminders.js";
import { withReminderTag } from "../reminders/reminders.js";
import type { WorkflowPreset } from "../workflows/workflows.js";
import { withWorkflowTag } from "../workflows/workflows.js";
import type { PromptTag } from "./store.js";

export interface ClaudePromptInput {
  text: string;
  imagePaths?: string[];
  reminder?: Pick<ReminderPreset, "id" | "body">;
  workflow?: Pick<WorkflowPreset, "id" | "injector">;
}

export interface ComposedClaudePrompt {
  /** What the binary receives: the prompt plus any trusted sentinel blocks. */
  text: string;
  /** The same blocks as transcript chips, so the row shows what rode along. */
  reminders: PromptTag[];
  workflows: PromptTag[];
}

/**
 * Compose the text sent to the `claude` binary.
 *
 * Mirrors server/opencode/sessions.ts `composePromptText` exactly: the
 * workflow injector rides closest to the prompt it belongs to and the
 * reminder is appended after it. The browser only ever names either by id;
 * the trusted bodies are resolved server-side by the route, so a tampered
 * client cannot author hidden prompt content on this lane either.
 *
 * Unlike the OpenCode lane the transcript here is not re-derived from a
 * persisted message, so the chips are returned alongside the text rather
 * than split back out of it.
 */
export function composeClaudePrompt(input: ClaudePromptInput): ComposedClaudePrompt {
  let text = input.text;
  if (input.imagePaths?.length) {
    const paths = input.imagePaths.map((imagePath) => `- ${JSON.stringify(imagePath)}`).join("\n");
    text += `\n\nThe user attached the following images. Inspect them as part of this request:\n${paths}`;
  }
  if (input.workflow) text = withWorkflowTag(text, input.workflow);
  if (input.reminder) text = withReminderTag(text, input.reminder);
  return {
    text,
    reminders: input.reminder ? [{ name: input.reminder.id, body: input.reminder.body.trim() }] : [],
    workflows: input.workflow ? [{ name: input.workflow.id, body: input.workflow.injector.trim() }] : [],
  };
}
