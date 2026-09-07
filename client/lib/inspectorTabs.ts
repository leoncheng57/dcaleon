export const INSPECTOR_TABS = ["todo", "runlog", "subagents", "reviews", "catalog", "trajectory", "memory"] as const;

export type InspectorTab = (typeof INSPECTOR_TABS)[number];

/** Unknown URL values are ignored rather than becoming invalid component state. */
export function parseInspectorTab(value: string | null): InspectorTab | undefined {
  return INSPECTOR_TABS.find((tab) => tab === value);
}
