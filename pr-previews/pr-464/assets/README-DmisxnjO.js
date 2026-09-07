const e=`# Reminder catalogue

Each \`reminders/<id>/SKILL.md\` is a trusted, repository-owned instruction block that the BFF can attach to one message by ID. Frontmatter is parsed as metadata and is not included in the injected reminder body.

## Origins

The imported presets are concise adaptations of skills from <https://github.com/leoncheng57/agent-skills>. Each imported file records \`source_repo\`, \`source_path\`, and the audited \`source_commit\`. Existing local presets without those fields are maintained directly in this repository.

## Updating imports

1. Fetch the source repository and record the full commit SHA being reviewed.
2. Diff each recorded \`source_path\` from its current \`source_commit\` to the new SHA.
3. Adapt useful behavioral changes manually; do not copy large skills wholesale or import source trigger metadata.
4. Keep reminder bodies concise, standalone, and safe for one-message attachment. Do not interpolate user content, include secrets, add destructive defaults, or require automatic merge/push behavior.
5. Update all three provenance fields and run the reminder tests plus the full repository verification suite.

Audit upstream changes for altered tool assumptions, permission behavior, shell commands, remoting/worktree safety, prompt-injection risks, and overlap with an existing preset. If an upstream skill now duplicates or weakens an existing reminder, retain the stronger existing reminder instead of adding another ID.
`;export{e as default};
