# Engineering Design Documents

The Notion pages below are the sole storage location for the point-in-time design snapshots
created for issue #151. This repository intentionally does not retain Markdown copies, exports,
or mirrored diagrams: editing a repository copy would create a competing source.

## Index

| Document | Snapshot date | Scope | Notion |
|---|---|---|---|
| [Request and Event Architecture — 2026-08-26](https://app.notion.com/p/Request-and-Event-Architecture-2026-08-26-3c8a232837d9810b80abd5d9c0c0e03d) | 2026-08-26 | Browser to React SPA to Express BFF to OpenCode: the request path, async prompt path, and global event fan-out. | Private until manually published |
| [Notification Persistence and Delivery — 2026-08-26](https://app.notion.com/p/Notification-Persistence-and-Delivery-2026-08-26-3c8a232837d98168bd0ec3c67e0d0b26) | 2026-08-26 | Notification ingest, durable records, retention, manual resolution, and desktop, ntfy, Web Push, and app-badge delivery. | Private until manually published |
| [Live Session Browser — 2026-08-27](https://app.notion.com/p/Live-Session-Browser-2026-08-27-3c9a232837d98154bb51f23fe99394a5) | 2026-08-27 | Live per-session interactive web browser: headless Chromium, screencast transport, capacity and memory model, and the SSRF boundary. Proposed, not implemented. | Private until manually published |
| [Live Browser and Right Tools Panel — 2026-09-07](https://app.notion.com/p/Live-Browser-and-Right-Tools-Panel-2026-09-07-3d4a232837d98161a204cadf5b6b948a) | 2026-09-07 | Shipped browser architecture and the accepted Codex-quality right-panel UX: Browser, Minichats/Terminal WIP destinations, responsive input, lifecycle, and security boundaries. Supersedes the 2026-08-27 proposal. | Private until manually published |
| [Hub Homepage Redesign — 2026-08-28](https://app.notion.com/p/Hub-Homepage-Redesign-2026-08-28-3caa232837d981a188b8f59dc880437a) | 2026-08-28 | Merges composer-first and activity-first Hub layouts: a cross-project "needs attention" band, a scrollable 25-item Recents cap, and collapsed-by-default project/worktree pickers. Proposed, not implemented. | Private until manually published |
| [Logging and Audit Persistence — 2026-08-29](https://app.notion.com/p/Logging-and-Audit-Persistence-2026-08-29-3cba232837d9813b8dc9c0e592678e01) | 2026-08-29 | Five alternatives for bounding the unrotated launchd log, and the chosen one: move notification audit lines into a BFF-owned, size- and age-bounded `audit.jsonl`. Implemented as an unmerged draft PR. | Private until manually published |
| [Claude Code Local-Binary Runtime — 2026-09-06](https://app.notion.com/p/Claude-Code-Local-Binary-Runtime-2026-09-06-3d4a232837d981c5823dfc2789c8d0a3) | 2026-09-06 | Third runtime driving the unmodified `claude` binary on a subscription seat: Seatbelt sandbox, per-prompt spawn, worktree isolation, credential boundary, transcript contract, parity features (playbooks, notifications, usage, island selector). PR #341. | Private until manually published |

All indexed pages are children of [Public Engineering Design Docs](https://app.notion.com/p/Public-Engineering-Design-Docs-3c8a232837d980d2b294db846b968a57) under `Custom Projects` in `Leon (Professional)`.

## Snapshot contract

Each Notion page records the design as understood on its snapshot date. It is deliberately not
kept synchronized with the implementation. The maintained repository documentation remains the
current implementation contract: [`docs/architecture.md`](../architecture.md),
[`docs/notifications.md`](../notifications.md), and [`AGENTS.md`](../../AGENTS.md). Where a
snapshot and maintained documentation disagree, the maintained documentation wins.

A superseding design is a new dated Notion page. The existing page is not rewritten to describe
later code, because doing so would destroy the historical record.

## Publication

Notion publication is manual. Open `Public Engineering Design Docs`, use **Share → Publish to
web**, then verify the resulting page in a signed-out or private browser window. The Notion API
does not expose a share-to-web operation, so the `public_url` cannot be set by this project.

After publication, replace the private links above with the verified public URLs. The follow-up
`/docs` Time Snapshot section is blocked on those public URLs.
