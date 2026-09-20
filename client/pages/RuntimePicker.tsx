import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Badge } from "../ds/badge.js";
import { ISLANDS } from "../components/island-selector.js";
import { api } from "../lib/api.js";
import { islandAvailability, type IslandStatus } from "../lib/islands.js";

export function RuntimePickerPage() {
  const navigate = useNavigate();
  const [config, setConfig] = useState<{
    dshEnabled: boolean;
    dshConfigured: boolean;
    claudeEnabled: boolean;
    claudeConfigured: boolean;
    islands?: IslandStatus[];
  } | null>(null);

  useEffect(() => {
    api.appConfig()
      .then((c) => setConfig({
        dshEnabled: c.dshEnabled,
        dshConfigured: c.dshConfigured,
        claudeEnabled: c.claudeEnabled,
        claudeConfigured: c.claudeConfigured,
        islands: c.islands,
      }))
      .catch(() => setConfig({ dshEnabled: false, dshConfigured: false, claudeEnabled: false, claudeConfigured: false }));
  }, []);

  const status = (id: string) => (config ? islandAvailability(id, config) : null);

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-8" data-testid="runtime-picker">
      <header className="mb-8 text-center">
        <h1 className="text-3xl font-bold tracking-tight">DCA</h1>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          Pick a runtime to get started.{" "}
          <a
            href="https://github.com/leoncheng57/dcaleon"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-text-action-ghost)] underline"
          >
            leoncheng57/dcaleon
          </a>
        </p>
      </header>

      <section className="space-y-3" aria-label="Runtime Islands">
        {ISLANDS.map((island) => {
          const Icon = island.icon;
          const islandStatus = status(island.id);
          const disabled = islandStatus?.available === false;
          return (
            <button
              key={island.id}
              type="button"
              className={[
                "w-full rounded-xl border p-4 text-left transition-colors sm:p-5",
                disabled
                  ? "border-[var(--color-border-default)] opacity-50 cursor-default"
                  : "border-[var(--color-border-default)] hover:border-[var(--color-text-info)] hover:bg-[var(--color-background-surface-info-muted)] cursor-pointer",
              ].join(" ")}
              onClick={() => !disabled && navigate(island.path)}
              aria-disabled={disabled}
              data-testid={`runtime-card-${island.id}`}
            >
              <div className="flex items-center gap-3">
                <Icon aria-hidden="true" size={22} className="text-[var(--color-text-muted)]" />
                <span className="text-base font-semibold">{island.label}</span>
                {islandStatus === null ? (
                  <Badge variant="neutral">checking…</Badge>
                ) : (
                  <Badge variant={islandStatus.available ? "success" : "neutral"}>{islandStatus.label.toLowerCase()}</Badge>
                )}
              </div>
              <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                {island.description}
              </p>
              {islandStatus?.reason ? (
                <p className="mt-1 text-xs text-[var(--color-text-muted)]" data-testid={`runtime-card-reason-${island.id}`}>
                  {islandStatus.reason}
                </p>
              ) : null}
              <div className="mt-3 space-y-0.5 text-xs text-[var(--color-text-muted)]">
                {island.traits.map((trait) => {
                  const colon = trait.indexOf(":");
                  return (
                    <p key={trait}>
                      <span className="font-medium text-[var(--color-text-default)]">
                        {trait.slice(0, colon + 1)}
                      </span>
                      {trait.slice(colon + 1)}
                    </p>
                  );
                })}
              </div>
            </button>
          );
        })}
      </section>
    </main>
  );
}
