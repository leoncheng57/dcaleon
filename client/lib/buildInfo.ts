export function formatBuildLabel(version: string): string {
  return `v${version}`;
}

export function formatBuildTitle(version: string, commit: string): string {
  return `DCA ${formatBuildLabel(version)}${commit ? ` (${commit})` : ""}`;
}
