import { useEffect, useState } from "react";
import { ArrowRight, Sparkles, LockKeyhole } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

import { Alert } from "../ds/alert.js";
import { Badge } from "../ds/badge.js";
import { Button } from "../ds/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ds/card.js";
import { api, type ClaudeConfigResponse, type ClaudeIsolation, type ClaudeSessionSummary } from "../lib/api.js";

export function ClaudePage() {
  const navigate = useNavigate();
  const [config, setConfig] = useState<ClaudeConfigResponse | null>(null);
  const [sessions, setSessions] = useState<ClaudeSessionSummary[]>([]);
  const [presetId, setPresetId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [confirmedBuild, setConfirmedBuild] = useState(false);
  const [isolation, setIsolation] = useState<ClaudeIsolation>("worktree");

  useEffect(() => {
    void Promise.all([api.claudeConfig(), api.claudeSessions()]).then(([nextConfig, nextSessions]) => {
      setConfig(nextConfig);
      setPresetId(nextConfig.presets[0]?.id ?? "");
      setWorkspaceId(nextConfig.workspaces[0]?.id ?? "");
      setSessions(nextSessions.sessions);
    }).catch((cause: Error) => setError(cause.message));
  }, []);

  const selectedPreset = config?.presets.find((preset) => preset.id === presetId);
  const requiresBuildConfirmation = selectedPreset?.mode === "build";

  const create = async () => {
    if (!presetId || !workspaceId || creating || (requiresBuildConfirmation && !confirmedBuild)) return;
    setCreating(true);
    setError("");
    try {
      const { session } = await api.createClaudeSession({ presetId, workspaceId, isolation: requiresBuildConfirmation ? isolation : "direct" });
      navigate(`/claude/sessions/${encodeURIComponent(session.id)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setCreating(false);
    }
  };

  return (
    <main className="h-full overflow-y-auto bg-[var(--color-background-base)] p-4 sm:p-8" data-testid="claude-home">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <Sparkles aria-hidden="true" size={18} />
              <Badge variant="neutral">Local binary runtime</Badge>
              {selectedPreset && <Badge variant="neutral">{selectedPreset.mode === "build" ? "Build · may edit files" : "Read only"}</Badge>}
              {config && <Badge variant="neutral">CLI {config.cliVersion} · {config.sandbox}</Badge>}
            </div>
            <h1 className="text-3xl font-semibold tracking-tight">Claude Code lab</h1>
            <p className="mt-2 max-w-2xl text-sm text-[var(--color-text-muted)]">
              Drive the local Claude Code binary beside OpenCode. The runtime is non-interactive by design and exposes only allowlisted presets and workspaces. Sign-in stays in the binary; this app never handles the credential.
            </p>
          </div>
          <LockKeyhole aria-hidden="true" className="text-[var(--color-text-muted)]" size={30} />
        </header>

        {error && <Alert variant="danger">{error}</Alert>}
        {config && (
          <Card>
            <CardHeader>
              <CardTitle>Start a Claude conversation</CardTitle>
              <CardDescription>Preset and workspace choices are configured on the server; this browser cannot author paths, flags, or Claude credentials.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <label className="grid gap-1.5 text-sm">
                Model preset
                <select className="h-11 rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-surface)] px-3" value={presetId} onChange={(event) => { setPresetId(event.target.value); setConfirmedBuild(false); }} data-testid="claude-preset">
                  {config.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label} · {preset.mode} ({preset.model}{preset.effort ? `/${preset.effort}` : ""})</option>)}
                </select>
              </label>
              <label className="grid gap-1.5 text-sm">
                Workspace
                <select className="h-11 rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-surface)] px-3" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} data-testid="claude-workspace">
                  {config.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.label}{workspace.source === "discovered" ? " · project" : ""}</option>)}
                </select>
              </label>
              <Button disabled={creating || !presetId || !workspaceId || (requiresBuildConfirmation && !confirmedBuild)} onClick={() => void create()} data-testid="claude-create">
                {creating ? "Starting..." : "Start"} <ArrowRight aria-hidden="true" className="ml-2" size={14} />
              </Button>
            </CardContent>
            {requiresBuildConfirmation && (
              <CardContent className="grid gap-3 pt-0">
                <fieldset className="grid gap-2 text-sm" data-testid="claude-isolation">
                  <legend className="mb-1 font-medium">Where should edits land?</legend>
                  <label className="flex min-h-11 items-start gap-3 rounded-md border border-[var(--color-border-default)] p-3">
                    <input type="radio" name="claude-isolation" value="worktree" checked={isolation === "worktree"} onChange={() => setIsolation("worktree")} className="mt-0.5 h-5 w-5 shrink-0" data-testid="claude-isolation-worktree" />
                    <span><strong>Isolated worktree</strong> — a separate git worktree and branch off the project. Review the diff, then merge into the project or discard. The project itself is untouched until you merge.</span>
                  </label>
                  <label className="flex min-h-11 items-start gap-3 rounded-md border border-[var(--color-border-default)] p-3">
                    <input type="radio" name="claude-isolation" value="direct" checked={isolation === "direct"} onChange={() => setIsolation("direct")} className="mt-0.5 h-5 w-5 shrink-0" data-testid="claude-isolation-direct" />
                    <span><strong>Directly in the project</strong> — edits land in your working tree immediately. You review and revert with git yourself.</span>
                  </label>
                </fieldset>
                <label className="flex min-h-11 items-start gap-3 rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-surface-warning-muted)] p-3 text-sm" data-testid="claude-build-confirmation">
                  <input type="checkbox" checked={confirmedBuild} onChange={(event) => setConfirmedBuild(event.target.checked)} className="mt-0.5 h-5 w-5 shrink-0" data-testid="claude-build-confirm" />
                  <span>This session runs tools without pausing to ask (headless Claude has no approval prompt). {isolation === "worktree" ? "Writes are confined to the session's worktree and the project's git metadata." : "Writes are confined to the selected project."} Writes outside that workspace and Claude state remain blocked by macOS Seatbelt.</span>
                </label>
              </CardContent>
            )}
          </Card>
        )}

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">This process&apos;s sessions</h2>
          <div className="grid gap-3">
            {sessions.map((session) => (
              <Link key={session.id} to={`/claude/sessions/${encodeURIComponent(session.id)}`} className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-background-surface)] p-4 hover:bg-[var(--color-background-surface-neutral-muted)]" data-testid="claude-session-row">
                <div className="flex items-center justify-between gap-3"><strong>{session.title}</strong><div className="flex items-center gap-2"><Badge variant="neutral">{session.mode}</Badge>{session.isolation === "worktree" && <Badge variant="neutral">worktree</Badge>}{session.running && <Badge variant="neutral">Running</Badge>}</div></div>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">{session.presetId} · {session.workspaceLabel ?? session.workspaceId}{session.branch ? ` · ${session.branch}` : ""} · {new Date(session.updatedAt).toLocaleString()}</p>
              </Link>
            ))}
            {config && sessions.length === 0 && <p className="text-sm text-[var(--color-text-muted)]">No Claude conversations in this BFF process yet.</p>}
          </div>
        </section>
      </div>
    </main>
  );
}
