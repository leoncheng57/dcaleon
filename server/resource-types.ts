export interface ResourceProcess {
  pid: number;
  parentPid: number;
  label: string;
  cpuPercent: number | null;
  memoryBytes: number;
}

export interface ResourceSnapshot {
  sampledAt: string;
  available: boolean;
  reason?: string;
  host: { cpuPercent: number | null; cores: number; usedMemoryBytes: number; totalMemoryBytes: number };
  total: { cpuPercent: number | null; memoryBytes: number; processCount: number; warmingCount: number };
  processes: ResourceProcess[];
  truncated: boolean;
  opencode: "included" | "remote" | "unavailable";
}
