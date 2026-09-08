# Persistent side-agent design package

Status: **Proposed**

This index groups the design, validation, security, operations, and interaction artifacts for
reusable parent-scoped specialist conversations.

## Start here

| Artifact | Use it for |
|---|---|
| [Implementation RFC](persistent-side-agents-rfc.md) | Product boundary, target architecture, protocol, UI, recovery, rollout |
| [Interactive prototype](persistent-side-agents-prototype.html) | Desktop/mobile interaction, answer inbox, explicit attach/send, failure explorer |
| [Animated SVG](assets/persistent-side-agent-demo.svg) | Accessible self-running four-stage workflow |
| [Demo GIF](assets/persistent-side-agent-demo.gif) | Portable review/comment preview |

## Contracts and evidence

| Artifact | Use it for |
|---|---|
| [Proposed OpenAPI](persistent-side-agent-openapi.yaml) | Parent-scoped routes, schemas, revisions, idempotency, errors |
| [State-transition tables](persistent-side-agent-state-tables.md) | Normative legal/illegal transitions, evidence precedence, restart behavior |
| [Live probe guide](persistent-side-agent-live-probes.md) | Safety contract, endpoint sequence, expected evidence, manual restart probe |
| [`probe-persistent-side-agents.ts`](../scripts/probe-persistent-side-agents.ts) | Safe-by-default executable OpenCode contract probe |

## Architecture and security

| Artifact | Use it for |
|---|---|
| [Threat model](persistent-side-agent-threat-model.md) | Assets, trust boundaries, STRIDE risks, mitigations, security tests |
| [ADR-010: FIFO bridge](adr/010-persistent-side-agent-bridge.md) | Why correlation and scheduling are application-owned |
| [ADR-011: Delivery semantics](adr/011-side-agent-delivery-semantics.md) | Why answers use inbox, attach, and explicit human send |
| [ADR-012: Persistence](adr/012-side-agent-persistence.md) | Why JSON is acceptable for V1 and what triggers SQLite |

## Delivery and operations

| Artifact | Use it for |
|---|---|
| [Implementation plan](persistent-side-agent-implementation-plan.md) | Dependency graph, files, milestones, estimates, flags, rollout and rollback |
| [Observability and runbook](persistent-side-agent-observability.md) | Events, redaction, metrics, SLOs, alerts and incident response |
| [Failure-injection catalogue](../tests/fixtures/persistent-side-agent-failure-scenarios.json) | Machine-readable crash, race, restart, corruption and fairness scenarios |

## Recommended review order

1. Agree on the RFC's scope and non-goals.
2. Review state tables and OpenAPI together; they form one contract.
3. Run the probe help/dry-run, then approve a disposable live probe environment.
4. Threat-model the exact deployment and permission policy.
5. Walk the interactive prototype on desktop and mobile.
6. Approve implementation milestones and operational gates.
7. Implement only after required live probes resolve the permission and correlation evidence gaps.

## Verification without a live OpenCode server

```bash
npx tsx scripts/probe-persistent-side-agents.ts --help

OPENCODE_URL=http://127.0.0.1:1 \
npx tsx scripts/probe-persistent-side-agents.ts \
  --dry-run \
  --directory /tmp/nonexistent-persistent-side-agent-probe \
  --model test/example

npm run typecheck
npm test
npm run build
```
