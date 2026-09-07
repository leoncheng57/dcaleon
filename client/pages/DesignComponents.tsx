import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Globe2, MessageSquareText, TerminalSquare } from "lucide-react";
import { Button, buttonClasses } from "../ds/button.js";
import { Badge } from "../ds/badge.js";
import { Alert } from "../ds/alert.js";
import { PanelSelector } from "../ds/panel-selector.js";
import { PanelState, type PanelStateKind } from "../ds/panel-state.js";
import { ResponsivePanel } from "../ds/responsive-panel.js";

const destinations = [
  { id: "browser", label: "Browser", icon: <Globe2 size={16} aria-hidden="true" /> },
  { id: "minichats", label: "Minichats", icon: <MessageSquareText size={16} aria-hidden="true" />, wip: true },
  { id: "terminal", label: "Terminal", icon: <TerminalSquare size={16} aria-hidden="true" />, wip: true },
] as const;
type Destination = typeof destinations[number]["id"];
const states: Array<{ kind: PanelStateKind; title: string; description: string }> = [
  { kind: "empty", title: "Ready for your next idea", description: "An empty view explains what belongs here and how to get started." },
  { kind: "loading", title: "Opening your workspace…", description: "A quiet progress indicator keeps the surrounding layout stable." },
  { kind: "wip", title: "Minichats", description: "A small conversation alongside your work. Coming soon." },
  { kind: "disconnected", title: "Connection interrupted", description: "Your work is preserved. Reconnect when you’re ready." },
];

function Example({ title, detail, children }: { title: string; detail: string; children: ReactNode }) {
  return <section className="min-w-0 space-y-4">
    <div><h2 className="text-xl font-semibold tracking-tight">{title}</h2><p className="mt-1 text-sm text-[var(--color-text-muted)]">{detail}</p></div>
    {children}
  </section>;
}

/** Repository-owned examples only. No browser, terminal, or chat API calls. */
export function DesignComponentsPage() {
  const [destination, setDestination] = useState<Destination>("browser");
  const [panelOpen, setPanelOpen] = useState(false);
  const [reconnected, setReconnected] = useState(false);
  const [feedback, setFeedback] = useState("Try an action to see its feedback.");
  const active = destinations.find((option) => option.id === destination)!;
  return <main className="h-full overflow-y-auto" data-testid="opencode-design-components">
    <div className="mx-auto max-w-6xl space-y-10 px-4 py-7 sm:px-8 sm:py-12">
      <header className="max-w-3xl space-y-4">
        <Badge variant="info">Design components · v0.1</Badge>
        <h1 className="text-3xl font-bold tracking-tight sm:text-5xl">Small screens. Shared details.</h1>
        <p className="text-base leading-relaxed text-[var(--color-text-muted)]">The building blocks of dcaleon, in one place. Start with a phone, keep every action reachable, and expand the layout as space allows.</p>
        <Link to="/docs/design-components-guide" className={buttonClasses({ variant: "secondary" })} data-testid="design-guide-link">Read the component guide</Link>
        <p className="text-xs text-[var(--color-text-muted)]">Use the app’s appearance control to compare light and dark. These examples use the same components as the conversation panel.</p>
      </header>

      <Example title="01 · Foundations" detail="Semantic colors, comfortable touch targets, and motion that respects your preferences.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Surface", token: "--color-background-surface" },
            { label: "Quiet surface", token: "--color-background-surface-neutral-muted" },
            { label: "Primary action", token: "--color-background-action-primary" },
            { label: "Focus", token: "--color-border-focus" },
          ].map(({ label, token }) => <div key={token} className="overflow-hidden rounded-xl border border-[var(--color-border-default)]">
            <div className="h-16" style={{ background: `var(${token})` }} />
            <div className="p-3"><h3 className="text-sm font-semibold">{label}</h3><code className="mt-1 block break-all text-[10px] text-[var(--color-text-muted)]">{token}</code></div>
          </div>)}
        </div>
        <div className="flex flex-wrap gap-2"><Badge>44px touch targets</Badge><Badge>150ms transitions</Badge><Badge>Reduced motion</Badge><Badge>Phone-first layout</Badge></div>
      </Example>

      <Example title="02 · Actions and feedback" detail="Reuse the existing primitives for consistent labels, focus, and status.">
        <div className="space-y-4 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-background-surface)] p-4 sm:p-6">
          <div className="flex flex-wrap gap-3">
            <Button data-testid="design-primary" onClick={() => setFeedback("Primary action selected.")}>Primary action</Button>
            <Button variant="secondary" data-testid="design-secondary" onClick={() => setFeedback("Secondary action selected.")}>Secondary</Button>
            <Button variant="ghost" data-testid="design-ghost" onClick={() => setFeedback("Quiet action selected.")}>Quiet action</Button>
            <Button disabled data-testid="design-disabled">Unavailable</Button>
          </div>
          <p role="status" className="text-sm text-[var(--color-text-muted)]">{feedback}</p>
          <div className="flex flex-wrap gap-2"><Badge variant="success">Saved</Badge><Badge variant="warning">Needs attention</Badge><Badge variant="danger">Failed</Badge></div>
          <Alert variant="info">Use a short explanation and a clear next action when something needs attention.</Alert>
        </div>
      </Example>

      <Example title="03 · Responsive tools panel" detail="One slot, three destinations. Full-screen below 1024px; a 42rem or 28rem slot on larger screens.">
        <div className="flex h-[32rem] min-w-0 overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-background-surface-neutral-muted)]" data-testid="design-panel-preview">
          <div className="min-w-0 flex-1 space-y-4 overflow-y-auto p-5 sm:p-7">
            <Badge>Interactive example</Badge>
            <h3 className="text-lg font-semibold">A place beside your work</h3>
            <p className="max-w-md text-sm leading-6 text-[var(--color-text-muted)]">Open the panel, switch destinations, and close it. On a phone, use Tab and Shift+Tab to explore its focus boundary. Closing returns you to the opener.</p>
            <Button onClick={() => { if (!panelOpen) { setDestination("browser"); setPanelOpen(true); } }} aria-expanded={panelOpen} data-testid="design-panel-open">Open panel</Button>
          </div>
          {panelOpen && <ResponsivePanel label={`${active.label} component preview`} width={destination === "browser" ? "wide" : "standard"}
            testId="design-panel" onClose={() => setPanelOpen(false)} subtitle="Component preview"
            header={<PanelSelector options={destinations} value={destination} onChange={setDestination} testId="design-panel-selector" />}>
            <PanelState kind={destination === "browser" ? "empty" : "wip"} title={active.label}
              description={destination === "browser" ? "The Browser surface plugs into this shared shell. This gallery previews layout and interaction." : `${active.label} is a work-in-progress destination.`} />
          </ResponsivePanel>}
        </div>
      </Example>

      <Example title="04 · Panel states" detail="Each state gives context without shifting the panel’s structure. Feature code supplies the copy and actions.">
        <div className="grid gap-4 sm:grid-cols-2">
          {states.map((state) => <div key={state.kind} className="flex min-h-72 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-background-surface)]">
            <PanelState {...state} testId={`design-state-${state.kind}`}
              title={state.kind === "disconnected" && reconnected ? "Connection restored" : state.title}
              description={state.kind === "disconnected" && reconnected ? "This local example is ready again." : state.description}
              kind={state.kind === "disconnected" && reconnected ? "empty" : state.kind}
              action={state.kind === "disconnected" ? <Button variant="secondary" data-testid="design-reconnect" onClick={() => setReconnected(!reconnected)}>{reconnected ? "Reset example" : "Reconnect"}</Button> : undefined} />
          </div>)}
        </div>
      </Example>
    </div>
  </main>;
}
