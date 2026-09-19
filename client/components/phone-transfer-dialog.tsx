import { useEffect, useRef, useState } from "react";
import qrcode from "qrcode-generator";

import { Button } from "../ds/button.js";

function QrCode({ value }: { value: string }) {
  const qr = qrcode(0, "M");
  qr.addData(value, "Byte");
  qr.make();

  const quietZone = 4;
  const moduleCount = qr.getModuleCount();
  const size = moduleCount + quietZone * 2;
  const modules: string[] = [];
  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      if (qr.isDark(row, column)) modules.push(`M${column + quietZone} ${row + quietZone}h1v1h-1z`);
    }
  }

  return (
    <svg
      aria-label={`QR code for ${value}`}
      className="aspect-square h-auto w-full max-w-64 bg-[var(--color-background-qr)] text-[var(--color-foreground-qr)]"
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${size} ${size}`}
    >
      <path d={modules.join("")} fill="currentColor" />
    </svg>
  );
}

export function PhoneTransferDialog({ targetUrl, onClose }: { targetUrl: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [copyStatus, setCopyStatus] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const close = () => dialogRef.current?.close();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(targetUrl);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Copy failed");
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-describedby="phone-transfer-description"
      aria-labelledby="phone-transfer-title"
      className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-xl border border-[var(--color-border-default)] bg-[var(--color-background-surface-raised)] p-0 text-[var(--color-text-default)] shadow-xl backdrop:bg-[var(--color-background-overlay)]"
      data-testid="opencode-phone-transfer-dialog"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="space-y-4 p-5 sm:p-6">
        <div>
          <h2 id="phone-transfer-title" className="text-lg font-semibold">Open on your phone</h2>
          <p id="phone-transfer-description" className="mt-1 text-sm text-[var(--color-text-muted)]">
            Scan this code with a phone that can reach this address.
          </p>
        </div>
        <div className="mx-auto w-full max-w-64 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-background-qr)] p-2">
          <QrCode value={targetUrl} />
        </div>
        <p className="break-all rounded-md bg-[var(--color-background-surface-neutral-muted)] p-3 font-mono text-xs" data-testid="opencode-phone-transfer-url">
          {targetUrl}
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span aria-live="polite" className="mr-auto text-xs text-[var(--color-text-muted)]" data-testid="opencode-phone-transfer-copy-status">
            {copyStatus}
          </span>
          <Button variant="secondary" onClick={() => void copy()} data-testid="opencode-phone-transfer-copy">
            Copy Link
          </Button>
          <Button onClick={close} data-testid="opencode-phone-transfer-close">
            Close
          </Button>
        </div>
      </div>
    </dialog>
  );
}
