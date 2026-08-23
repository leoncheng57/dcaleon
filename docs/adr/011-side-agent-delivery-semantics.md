# ADR-011: Explicit answer inbox and parent attachment

Status: **Proposed**
Date: 2026-08-22

## Context

A specialist answer is model-authored, may contain secrets or injected instructions, and does not
automatically belong in the parent conversation. Injecting it as a user message fabricates
authorship; resuming the parent could execute tools without human review.

The existing interrupted-run design already prefills rather than auto-sends because replay can
duplicate destructive work.

## Decision

- Completed answers enter a durable parent-owned inbox.
- No completion path prompts or resumes the parent.
- **Attach to next message** adds bounded, provenance-labelled context to the composer.
- Attach remains removable and does not call `prompt_async`.
- The next explicit human send includes accepted context and starts the parent turn.
- Answer prose and XML-like markers have no authorization or lifecycle effect.
- Interrupted work exposes inspect, cancel, and explicit retry with a duplicate-risk warning.
- Mutations carry expected revisions and idempotency keys for multi-device races.

## Alternatives

| Alternative | Reason rejected |
|---|---|
| Automatically post every answer | Spoofs user authorship and changes context without consent |
| Automatically resume the parent | Unreviewed model output could trigger tools |
| Notification without durable inbox | Delivery is not proof that the user received it |
| Trust textual result markers | Model/user prose can spoof them |

## Consequences

- Delivery requires an additional user action.
- Answers remain inspectable across device disconnects.
- Users can omit unsafe content before sending.
- Explicit review reduces but cannot eliminate LLM prompt-injection risk.

## Acceptance criteria

- No answer-completion path calls the parent prompt endpoint.
- Wrong-parent/project attach is rejected.
- Fake IDs or markers in result text have no control effect.
- Two-device races produce one commit and one revision conflict.
- Attached context is visibly identified as untrusted specialist output.
