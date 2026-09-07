import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Cpu, X } from "lucide-react";
import type { ResourceSnapshot } from "../../server/resource-types.js";
import { Button } from "../ds/button.js";
import { PUBLIC_SIMULATOR } from "../lib/runtime.js";

const POLL_MS = 5_000;
const percent = (value: number | null) => value === null ? "—" : `${value.toFixed(1)}%`;
const memory = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;

/** Own state keeps resource ticks outside the transcript's render path. */
export function ResourceIndicator() {
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const refresh = async () => {
      clearTimeout(timer);
      controller?.abort();
      if (document.visibilityState === "hidden" || stopped) return;
      const request = new AbortController();
      controller = request;
      try {
        const response = await fetch("/api/observability/resources", { signal: AbortSignal.any([request.signal, AbortSignal.timeout(4_000)]) });
        if (!response.ok) throw new Error("Resource monitor unavailable");
        const data = await response.json() as ResourceSnapshot;
        if (!stopped && !request.signal.aborted) { setSnapshot(data); setFailed(false); }
      } catch {
        if (!stopped && !request.signal.aborted) setFailed(true);
      } finally {
        if (!stopped && !request.signal.aborted) timer = setTimeout(() => void refresh(), POLL_MS);
      }
    };
    const visibility = () => { void refresh(); };
    void refresh();
    document.addEventListener("visibilitychange", visibility);
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); document.removeEventListener("visibilitychange", visibility); };
  }, []);

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  const available = snapshot?.available && !failed;
  return <>
    <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open} aria-controls={id}
      title="Resources — DCA host processes, not this browser tab"
      className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs tabular-nums text-[var(--color-text-muted)] hover:bg-[var(--color-background-surface-neutral-muted)] hover:text-[var(--color-text-default)] sm:min-h-8"
      data-testid="resource-trigger">
      <Cpu size={14} aria-hidden="true" />
      {available ? <span>CPU {percent(snapshot.total.cpuPercent)} · {memory(snapshot.total.memoryBytes)}</span>
        : <span>Resources{failed || snapshot ? " unavailable" : " …"}</span>}
    </button>
    {createPortal(<dialog ref={dialog} id={id} aria-labelledby={`${id}-title`} onCancel={() => setOpen(false)}
      onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
      className="m-auto max-h-[85dvh] w-[38rem] max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-xl border border-[var(--color-border-default)] bg-[var(--color-background-surface)] p-0 text-[var(--color-text-default)] shadow-xl backdrop:bg-[var(--color-background-overlay)]"
      data-testid="resource-dialog">
      <div className="flex items-center gap-2 border-b border-[var(--color-border-default)] px-4 py-2">
        <Cpu size={16} aria-hidden="true" /><h2 id={`${id}-title`} className="text-sm font-semibold">Resources</h2>
        <Button type="button" variant="ghost" size="sm" className="ml-auto min-h-11 min-w-11" aria-label="Close resources" onClick={() => setOpen(false)} data-testid="resource-close"><X size={16} aria-hidden="true" /></Button>
      </div>
      <div className="space-y-4 p-4 text-xs">
        <p className="text-[var(--color-text-muted)]">{PUBLIC_SIMULATOR ? "Preview data — these resource readings are simulated." : "DCA server host · all projects and sessions. Browser tabs on this device are not included."}</p>
        {!available ? <p role="status" data-testid="resource-unavailable">{failed ? "Resource updates are unavailable. Retrying automatically." : snapshot?.reason ?? "Sampling resources…"}</p> : <>
          <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
            <div className="rounded-lg border border-[var(--color-border-default)] p-3" data-testid="resource-total">
              <h3 className="font-medium">DCA processes</h3>
              <p className="mt-2 text-lg tabular-nums">{percent(snapshot.total.cpuPercent)} CPU</p>
              <p className="tabular-nums">{memory(snapshot.total.memoryBytes)} resident memory</p>
              <p className="mt-1 text-[var(--color-text-muted)]">{snapshot.total.processCount} processes{snapshot.total.warmingCount > 0 ? ` · ${snapshot.total.warmingCount} awaiting CPU sample` : ""}</p>
            </div>
            <div className="rounded-lg border border-[var(--color-border-default)] p-3" data-testid="resource-host">
              <h3 className="font-medium">Whole host</h3>
              <p className="mt-2 text-lg tabular-nums">{percent(snapshot.host.cpuPercent)} CPU</p>
              <p className="tabular-nums">{memory(snapshot.host.usedMemoryBytes)} / {memory(snapshot.host.totalMemoryBytes)} memory</p>
              <p className="mt-1 text-[var(--color-text-muted)]">{snapshot.host.cores} logical cores · includes other apps</p>
            </div>
          </div>
          <div className="max-h-64 overflow-auto rounded-lg border border-[var(--color-border-default)]">
            <table className="w-full text-left tabular-nums" data-testid="resource-processes">
              <caption className="sr-only">DCA processes sorted by resident memory</caption>
              <thead className="sticky top-0 bg-[var(--color-background-surface)] text-[var(--color-text-muted)]"><tr>
                <th className="p-2 font-medium">Process / PID</th><th className="p-2 text-right font-medium">CPU</th><th className="p-2 text-right font-medium">Memory</th>
              </tr></thead>
              <tbody>{snapshot.processes.map((row) => <tr key={row.pid} className="border-t border-[var(--color-border-default)]">
                <td className="p-2">{row.label}<span className="ml-1 text-[var(--color-text-muted)]">{row.pid}</span></td>
                <td className="whitespace-nowrap p-2 text-right">{percent(row.cpuPercent)}</td><td className="whitespace-nowrap p-2 text-right">{memory(row.memoryBytes)}</td>
              </tr>)}</tbody>
            </table>
          </div>
          {snapshot.truncated && <p>Showing the 128 largest processes; totals include all tracked processes.</p>}
          <div className="space-y-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
            <p>Includes DCA and its child processes (agents, tools and hosted browsers). {snapshot.opencode === "included" ? "Local OpenCode is included." : snapshot.opencode === "remote" ? "Remote OpenCode usage cannot be measured here." : "Local OpenCode could not be identified; its usage may be missing."}</p>
            <p>Process CPU: 100% = one logical core; totals can exceed 100%. Whole-host CPU: 100% = all cores. A dash means another sample is needed. New and exited processes can make CPU totals partial.</p>
            <p>Resident memory can double-count shared pages. Host memory is total minus free, including caches; it is not a memory-pressure reading.</p>
            <p>Updates about every 5 seconds while this tab is visible. Last sample: {new Date(snapshot.sampledAt).toLocaleTimeString()}.</p>
          </div>
        </>}
      </div>
    </dialog>, document.body)}
  </>;
}
