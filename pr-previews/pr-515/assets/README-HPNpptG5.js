const e=`# Design components

This is the starting point for dcaleon’s small, mobile-first design library.
Visit **More → Design components** (\`/design-components\`) for live examples.
The gallery works in the installed app and the public simulator, including hash routing.
It renders production components with local fixture state and makes no Browser, Minichats,
or Terminal API calls.

## Mobile first

Start at 320–390px, with one column, readable text, and reachable actions. Increase
space and add columns only when the viewport supports them. Verify at phone width
before desktop. Coarse-pointer controls have at least 44px touch targets. Labels,
keyboard access, and visible focus must work independently of hover.

## Catalogue

| Component | Source | Responsibility |
| --- | --- | --- |
| ResponsivePanel | \`client/ds/responsive-panel.tsx\` | Full-screen modal below 1024px; in-flow desktop slot, header, close action, safe areas, focus restoration and containment |
| PanelSelector | \`client/ds/panel-selector.tsx\` | Controlled destination selection, WIP labels, disclosure, Tab navigation, Escape and selection focus restoration |
| PanelState | \`client/ds/panel-state.tsx\` | Empty, loading, WIP and disconnected presentation; feature-owned copy, icon and action |
| Button / Badge / Alert / Card | \`client/ds/\` | Existing action, status and surface primitives |
| Color and spacing tokens | \`client/theme/tokens.css\` | Shared semantic palette, typography-related aliases, and radii |
| Motion tokens | \`client/theme/motion.css\` | 150ms interaction timing and standard easing; reduced-motion support |

The live right tools panel is the first consumer. Browser streaming, touch forwarding,
session lifecycle and requests remain in feature code. Shared components do not import
the browser manager, API client, session context, or production fixture data.

## Compose a panel

\`\`\`tsx
<ResponsivePanel
  label="Tools"
  width="standard"
  header={<PanelSelector options={options} value={value} onChange={setValue} testId="tools-selector" />}
  onClose={() => setOpen(false)}
  testId="tools-panel"
>
  <PanelState kind="empty" title="Ready" description="Choose a destination to begin." />
</ResponsivePanel>
\`\`\`

Mount the panel only while open, inside a flex row on desktop. \`wide\` is 42rem and
\`standard\` is 28rem; both fill the viewport below 1024px. Keep the opener mounted so
focus can return to it. Escape is handled inside the panel, allowing nested controls
to consume it first. The selector is a button disclosure with ordinary Tab order,
not an ARIA menu requiring arrow-key navigation. Stable test IDs belong to the caller.

## Extending the library

1. Start with a real repeated pattern; keep feature business logic outside \`client/ds/\`.
2. Reuse semantic CSS tokens and existing primitives. Introduce no copied hex palette.
3. Add a small live example to \`client/pages/DesignComponents.tsx\` and update this catalogue.
4. Review phone then desktop, light and dark, long labels, keyboard focus, and reduced motion.
5. Run focused interaction tests when changing focus, modal behavior or navigation.

This initial gallery is intentionally small. It is not a second implementation of the
product or a promise of visual parity with any other app. The component-library roadmap is #150.

## Visual evidence and durable mockups

The dedicated HTML mockup CLI is proposed in the still-open #360 / #361; do not
claim it is installed on this branch or introduce a competing tool. Reuse the pinned
Playwright dependency for HTML captures. Link \`client/theme/tokens.css\` from HTML rather
than copying its palette; keep durable prototypes in dated \`design/\` subdirectories.
For production UI, follow \`.agents/skills/pr-screenshots/SKILL.md\` and
\`docs/engineering-design/playwright-review.md\`: capture a clean commit, inspect every
light/dark phone/desktop image, then publish the reviewed gallery. New routes need
local-gallery publication until the default branch knows their screenshot route.
`;export{e as default};
