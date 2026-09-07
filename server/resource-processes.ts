import type { ChildProcess } from "node:child_process";

type Role = "Claude" | "DSH";
const owned = new Map<number, { child: ChildProcess; role: Role }>();

/** Runtime-owned identities avoid guessing Claude's role from a versioned binary name. */
export function registerResourceProcess(child: ChildProcess, role: Role): void {
  const pid = child.pid;
  if (!pid) return;
  const entry = { child, role };
  owned.set(pid, entry);
  const release = () => { if (owned.get(pid) === entry) owned.delete(pid); };
  child.once("exit", release);
  child.once("error", release);
}

export function resourceProcessRoles(): ReadonlyMap<number, Role> {
  return new Map([...owned].filter(([, entry]) => entry.child.exitCode === null && entry.child.signalCode === null)
    .map(([pid, entry]) => [pid, entry.role]));
}
