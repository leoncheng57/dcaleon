import { useEffect, useState } from "react";
import { ArrowRight, FlaskConical, LockKeyhole } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

import { Alert } from "../ds/alert.js";
import { Badge } from "../ds/badge.js";
import { Button } from "../ds/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ds/card.js";
import { api, type DshConfigResponse, type DshSessionSummary } from "../lib/api.js";

export function DshPage() {
  const navigate = useNavigate();
  const [config, setConfig] = useState<DshConfigResponse | null>(null);
  const [sessions, setSessions] = useState<DshSessionSummary[]>([]);
  const [presetId, setPresetId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [confirmedBuild, setConfirmedBuild] = useState(false);

  useEffect(() => {
    void Promise.all([api.dshConfig(), api.dshSessions()]).then(([nextConfig, nextSessions]) => {
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
      const { session } = await api.createDshSession({ presetId, workspaceId });
      navigate(`/dsh/sessions/${encodeURIComponent(session.id)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setCreating(false);
    }
  };

  return (
    <main className="h-full overflow-y-auto bg-[var(--color-background-base)] p-4 sm:p-8" data-testid="dsh-home">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <FlaskConical aria-hidden="true" size={18} />
              <Badge variant="neutral">Experimental runtime</Badge>
              {selectedPreset && <Badge variant="neutral">{selectedPreset.mode === "build" ? "Build · may edit files" : "Read only"}</Badge>}
              {config && <Badge variant="neutral">SDK {config.sdkVersion} · {config.sandbox}</Badge>}
            </div>
            <h1 className="text-3xl font-semibold tracking-tight">DeepSeek Harness lab</h1>
            <p className="mt-2 max-w-2xl text-sm text-[var(--color-text-muted)]">
              Run DSH beside OpenCode without moving sessions or changing OpenCode policy. The local bridge exposes only allowlisted presets and workspaces.
            </p>
          </div>
          <LockKeyhole aria-hidden="true" className="text-[var(--color-text-muted)]" size={30} />
        </header>

        {error && <Alert variant="danger">{error}</Alert>}
        {config && (
          <Card>
            <CardHeader>
              <CardTitle>Start a DSH conversation</CardTitle>
              <CardDescription>Preset and workspace choices are configured on the server; this browser cannot author model credentials or DSH policy.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <label className="grid gap-1.5 text-sm">
                Model preset
                <select className="h-11 rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-surface)] px-3" value={presetId} onChange={(event) => { setPresetId(event.target.value); setConfirmedBuild(false); }} data-testid="dsh-preset">
                  {config.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
                </select>
              </label>
              <label className="grid gap-1.5 text-sm">
                Workspace
                <select className="h-11 rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-surface)] px-3" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} data-testid="dsh-workspace">
                  {config.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.label}</option>)}
                </select>
              </label>
              <Button disabled={creating || !presetId || !workspaceId || (requiresBuildConfirmation && !confirmedBuild)} onClick={() => void create()} data-testid="dsh-create">
                {creating ? "Starting..." : "Start"} <ArrowRight aria-hidden="true" className="ml-2" size={14} />
              </Button>
            </CardContent>
            {requiresBuildConfirmation && (
              <CardContent className="pt-0">
                <label className="flex min-h-11 items-start gap-3 rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-surface-warning-muted)] p-3 text-sm" data-testid="dsh-build-confirmation">
                  <input type="checkbox" checked={confirmedBuild} onChange={(event) => setConfirmedBuild(event.target.checked)} className="mt-0.5 h-5 w-5 shrink-0" data-testid="dsh-build-confirm" />
                  <span>This session may edit files inside the selected workspace. Writes outside that workspace and DSH state remain blocked by macOS Seatbelt.</span>
                </label>
              </CardContent>
            )}
          </Card>
        )}

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">This process&apos;s sessions</h2>
          <div className="grid gap-3">
            {sessions.map((session) => (
              <Link key={session.id} to={`/dsh/sessions/${encodeURIComponent(session.id)}`} className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-background-surface)] p-4 hover:bg-[var(--color-background-surface-neutral-muted)]" data-testid="dsh-session-row">
                <div className="flex items-center justify-between gap-3"><strong>{session.title}</strong><div className="flex items-center gap-2"><Badge variant="neutral">{session.mode}</Badge>{session.running && <Badge variant="neutral">Running</Badge>}</div></div>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">{session.presetId} · {session.workspaceId} · {new Date(session.updatedAt).toLocaleString()}</p>
              </Link>
            ))}
            {config && sessions.length === 0 && <p className="text-sm text-[var(--color-text-muted)]">No DSH conversations in this BFF process yet.</p>}
          </div>
        </section>
      </div>
    </main>
  );
}
