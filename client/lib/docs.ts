export type DocCategory = "start" | "architecture" | "operations" | "history";

export interface DocDefinition {
  slug: string;
  title: string;
  description: string;
  category: DocCategory;
  sourcePath: string;
  load: () => Promise<string>;
}

export const DOC_CATEGORY_LABELS: Record<DocCategory, string> = {
  start: "Start here",
  architecture: "Architecture and internals",
  operations: "Operations",
  history: "Research and evidence",
};

export const DOC_CATEGORY_ORDER: DocCategory[] = ["start", "architecture", "operations", "history"];

export const DOCS: DocDefinition[] = [
  {
    slug: "design-components-guide",
    title: "Design components guide",
    description: "Mobile-first component conventions, shared panels, states, motion, and the live gallery.",
    category: "architecture",
    sourcePath: "docs/design-components/README.md",
    load: () => import("../../docs/design-components/README.md?raw").then((module) => module.default),
  },
  {
    slug: "architecture",
    title: "Architecture",
    description: "Topology, request and event flows, state ownership, safety boundaries, and extension seams.",
    category: "architecture",
    sourcePath: "docs/architecture.md",
    load: () => import("../../docs/architecture.md?raw").then((module) => module.default),
  },
  {
    slug: "subagents",
    title: "Sub-agents and child sessions",
    description: "Delegation lanes, the retained-agent capability matrix, derived child state, and safe parallelism.",
    category: "architecture",
    sourcePath: "docs/subagents.md",
    load: () => import("../../docs/subagents.md?raw").then((module) => module.default),
  },
  {
    slug: "contributing",
    title: "Contributing",
    description: "Local setup, repository conventions, verification, pull requests, and security-sensitive changes.",
    category: "start",
    sourcePath: "CONTRIBUTING.md",
    load: () => import("../../CONTRIBUTING.md?raw").then((module) => module.default),
  },
  {
    slug: "pr-previews",
    title: "Pull request previews",
    description: "Per-commit simulator deployment, BFF stubs, artifact trust boundaries, diagrams, and cleanup.",
    category: "start",
    sourcePath: "docs/pr-previews.md",
    load: () => import("../../docs/pr-previews.md?raw").then((module) => module.default),
  },
  {
    slug: "project-readme",
    title: "Project orientation",
    description: "Purpose, features, requirements, deployment entry points, and the public safety model.",
    category: "start",
    sourcePath: "README.md",
    load: () => import("../../README.md?raw").then((module) => module.default),
  },
  {
    slug: "engineering-invariants",
    title: "Engineering invariants",
    description: "Verified API traps, durable decisions, and client conventions that protect the implementation.",
    category: "architecture",
    sourcePath: "AGENTS.md",
    load: () => import("../../AGENTS.md?raw").then((module) => module.default),
  },
  {
    slug: "opencode-api-audit",
    title: "OpenCode API audit",
    description: "Measured compatibility evidence for the pinned OpenCode server surface.",
    category: "history",
    sourcePath: "docs/opencode-1.18.21-api-audit.md",
    load: () => import("../../docs/opencode-1.18.21-api-audit.md?raw").then((module) => module.default),
  },
  {
    slug: "architecture-research",
    title: "Architecture research",
    description: "The investigation, alternatives, and load-bearing conclusions behind the OpenCode migration.",
    category: "history",
    sourcePath: "docs/research/README.md",
    load: () => import("../../docs/research/README.md?raw").then((module) => module.default),
  },
  {
    slug: "deployment",
    title: "Deployment operations",
    description: "LaunchAgent installation, logs, upgrades, Tailscale access, and process management.",
    category: "operations",
    sourcePath: "deploy/README.md",
    load: () => import("../../deploy/README.md?raw").then((module) => module.default),
  },
  {
    slug: "reminders",
    title: "Reminder catalogue",
    description: "Runtime reminder format, provenance, update policy, and validation guidance.",
    category: "operations",
    sourcePath: "reminders/README.md",
    load: () => import("../../reminders/README.md?raw").then((module) => module.default),
  },
];

const DOCS_BY_SLUG = new Map(DOCS.map((doc) => [doc.slug, doc]));
const DOCS_BY_PATH = new Map(DOCS.map((doc) => [doc.sourcePath, doc]));
const REPOSITORY_BLOB_URL = "https://github.com/leoncheng57/dcaleon/blob/main";

export function getDoc(slug: string | undefined): DocDefinition | undefined {
  return slug ? DOCS_BY_SLUG.get(slug) : undefined;
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function resolveRelativePath(sourcePath: string, href: string): string {
  const sourceDirectory = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
  return normalizePath(`${sourceDirectory}/${href}`);
}

export function rewriteDocLinks(markdown: string, sourcePath: string): string {
  return markdown.replace(/(?<!!)\[([^\]]+)\]\(([^)]+)\)/gu, (match, label: string, href: string) => {
    const trimmedHref = href.trim();
    if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/iu.test(trimmedHref)) return match;

    const hashIndex = trimmedHref.indexOf("#");
    const queryIndex = trimmedHref.indexOf("?");
    const suffixIndex = [hashIndex, queryIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? -1;
    const path = suffixIndex >= 0 ? trimmedHref.slice(0, suffixIndex) : trimmedHref;
    const suffix = suffixIndex >= 0 ? trimmedHref.slice(suffixIndex) : "";
    const resolvedPath = resolveRelativePath(sourcePath, path);
    const inAppDoc = DOCS_BY_PATH.get(resolvedPath);
    const target = inAppDoc ? `/docs/${inAppDoc.slug}${suffix}` : `${REPOSITORY_BLOB_URL}/${resolvedPath}${suffix}`;
    return `[${label}](${target})`;
  });
}
