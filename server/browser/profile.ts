// The persistent Chromium profile is a credential store: cookies and site
// storage grant the same authority as the logged-in user. Refuse a profile
// whose directory tree is readable or writable by another local account.

import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";

export class BrowserProfilePermissionError extends Error {}

export function assertPrivateBrowserProfile(root: string): void {
  const visit = (target: string): void => {
    const stat = lstatSync(target);
    const publicBits = stat.mode & 0o077;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new BrowserProfilePermissionError(`browser profile is not owned by the current user at ${target}`);
    }
    // Chromium owns these process-lock links; never follow them. Its own
    // launch lock prevents concurrent access to a still-running profile.
    if (stat.isSymbolicLink() && path.dirname(target) === root &&
      ["SingletonLock", "SingletonCookie", "SingletonSocket"].includes(path.basename(target))) return;
    if (stat.isSymbolicLink()) {
      throw new BrowserProfilePermissionError(`browser profile contains a symbolic link: ${target}`);
    }
    // Chromium creates ordinary 0644/0755 descendants. A private root
    // prevents other accounts traversing to them; rejecting them breaks restart.
    if (target === root && publicBits !== 0) {
      throw new BrowserProfilePermissionError(
        `browser profile permissions are too open at ${target}; directories must be private and files must not grant group/other access`,
      );
    }
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(target)) visit(path.join(target, entry));
  };

  visit(root);
}
