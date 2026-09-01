import { lazy, StrictMode, Suspense, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "next-themes";

import { HubPage } from "./pages/Hub.js";
import { ConversationPage } from "./pages/Conversation.js";
import { SettingsPage } from "./pages/Settings.js";
import { NotificationsPage } from "./pages/Notifications.js";
import { ToolsPage } from "./pages/Tools.js";
import { DocsPage } from "./pages/Docs.js";
import { DocPage } from "./pages/DocPage.js";
import { ObservabilityPage } from "./pages/Observability.js";
import { PlanningPage } from "./pages/Planning.js";
import { DshPage } from "./pages/Dsh.js";
import { DshConversationPage } from "./pages/DshConversation.js";
import { ClaudePage } from "./pages/Claude.js";
import { ClaudeConversationPage } from "./pages/ClaudeConversation.js";
import { AppShell } from "./components/app-shell.js";
import { ThemeEffects } from "./components/theme-effects.js";
import { NotificationCenterProvider } from "./lib/useNotificationCenter.js";
import { ServiceWorkerUpdate } from "./components/service-worker-update.js";
import { PUBLIC_SIMULATOR } from "./lib/runtime.js";
import "./styles.css";

const PlaybooksPage = lazy(() => import("./pages/Playbooks.js").then((module) => ({ default: module.PlaybooksPage })));
const WorkflowPlaybookPage = lazy(() => import("./pages/PlaybookDetail.js").then((module) => ({ default: module.WorkflowPlaybookPage })));
const ReminderPlaybookPage = lazy(() => import("./pages/PlaybookDetail.js").then((module) => ({ default: module.ReminderPlaybookPage })));

function playbookPage(page: ReactNode): ReactNode {
  return <Suspense fallback={<main className="p-8 text-sm text-[var(--color-text-muted)]">Loading playbooks…</main>}>{page}</Suspense>;
}

async function start(): Promise<void> {
  if (PUBLIC_SIMULATOR) {
    const { installPublicSimulator } = await import("./simulator/publicSimulator.js");
    installPublicSimulator();
  }

  const Router = PUBLIC_SIMULATOR ? HashRouter : BrowserRouter;
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem enableColorScheme>
        <ThemeEffects />
        {!PUBLIC_SIMULATOR && <ServiceWorkerUpdate />}
        <Router>
          <NotificationCenterProvider>
            <Routes>
              <Route element={<AppShell />}>
                <Route path="/" element={<HubPage />} />
                <Route path="/sessions/:id" element={<ConversationPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/settings/notifications" element={<NotificationsPage />} />
                <Route path="/tools" element={<ToolsPage />} />
                <Route path="/docs" element={<DocsPage />} />
                <Route path="/docs/:slug" element={<DocPage />} />
                <Route path="/planning" element={<PlanningPage />} />
        <Route path="/observability" element={<ObservabilityPage />} />
                <Route path="/dsh" element={<DshPage />} />
                <Route path="/dsh/sessions/:id" element={<DshConversationPage />} />
                <Route path="/claude" element={<ClaudePage />} />
                <Route path="/claude/sessions/:id" element={<ClaudeConversationPage />} />
                <Route path="/playbooks" element={playbookPage(<PlaybooksPage />)} />
                <Route path="/playbooks/workflows" element={playbookPage(<PlaybooksPage />)} />
                <Route path="/playbooks/workflows/:id" element={playbookPage(<WorkflowPlaybookPage />)} />
                <Route path="/playbooks/reminders" element={playbookPage(<PlaybooksPage />)} />
                <Route path="/playbooks/reminders/:id" element={playbookPage(<ReminderPlaybookPage />)} />
              </Route>
            </Routes>
          </NotificationCenterProvider>
        </Router>
      </ThemeProvider>
    </StrictMode>,
  );
}

void start();
