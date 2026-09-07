import { useState } from "react";
import { RefreshCw, X } from "lucide-react";

import { Button } from "../ds/button.js";
import { PUBLIC_SIMULATOR } from "../lib/runtime.js";

export function PreviewDrawer({ onClose }: { onClose: () => void }) {
  const [port, setPort] = useState("5173");
  const [key, setKey] = useState(0);
  return (
    <section className="fixed inset-x-0 bottom-0 top-11 z-50 flex flex-col border-l border-[var(--color-border-default)] bg-[var(--color-background-surface)] shadow-xl sm:left-auto sm:w-[42rem]" data-testid="dsh-preview">
      <header className="flex items-center gap-2 border-b border-[var(--color-border-default)] p-2">
        <strong className="text-sm">Bounded local preview</strong>
        <Button className="ml-auto" size="sm" variant="ghost" onClick={onClose} data-testid="dsh-preview-close"><X aria-hidden="true" size={15} /> Close</Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col p-3">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">Port <input value={port} onChange={(event) => setPort(event.target.value.replace(/\D/g, ""))} className="w-24 rounded-md border border-[var(--color-border-default)] bg-transparent p-2" data-testid="dsh-preview-port" /></label>
          <Button variant="secondary" onClick={() => setKey((value) => value + 1)} data-testid="dsh-preview-reload"><RefreshCw aria-hidden="true" size={14} className="mr-1" /> Load / Reload</Button>
        </div>
        <iframe
          key={key}
          src={PUBLIC_SIMULATOR ? undefined : `/api/preview/${port}/`}
          srcDoc={PUBLIC_SIMULATOR ? "<!doctype html><html><body><main><h1>Simulated DSH preview</h1><p>This public fixture never contacts localhost, DSH, or a model provider.</p><button type='button'>Fixture action</button></main></body></html>" : undefined}
          title="Application preview"
          sandbox="allow-forms allow-modals allow-popups allow-scripts"
          className="min-h-0 flex-1 rounded border border-[var(--color-border-default)] bg-white"
          data-testid="dsh-preview-frame"
        />
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">{PUBLIC_SIMULATOR ? "Fixture frame only. Public previews never contact localhost or a DSH runtime." : "Read-only GET/HEAD proxy. The DSH runtime cannot select or widen allowed ports."}</p>
      </div>
    </section>
  );
}
