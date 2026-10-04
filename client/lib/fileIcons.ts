export type FileIconKind =
  | "folder"
  | "folder-open"
  | "code"
  | "json"
  | "markdown"
  | "style"
  | "html"
  | "image"
  | "config"
  | "shell"
  | "lock"
  | "env"
  | "git"
  | "text"
  | "file";

export type FileIconTone = "info" | "success" | "warning" | "danger" | "muted";

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
  "poetry.lock",
]);

const GIT_NAMES = new Set([".gitignore", ".gitattributes", ".gitmodules", ".gitkeep"]);
const CONFIG_NAMES = new Set([
  "dockerfile",
  "makefile",
  ".editorconfig",
  ".npmrc",
  ".nvmrc",
  ".dockerignore",
  ".prettierrc",
  ".eslintrc",
]);

const EXTENSION_KIND: Record<string, FileIconKind> = {
  ts: "code",
  tsx: "code",
  mts: "code",
  cts: "code",
  js: "code",
  jsx: "code",
  mjs: "code",
  cjs: "code",
  py: "code",
  rb: "code",
  go: "code",
  rs: "code",
  java: "code",
  kt: "code",
  swift: "code",
  c: "code",
  h: "code",
  cpp: "code",
  hpp: "code",
  cs: "code",
  php: "code",
  vue: "code",
  svelte: "code",
  sql: "code",
  json: "json",
  jsonc: "json",
  json5: "json",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  css: "style",
  scss: "style",
  sass: "style",
  less: "style",
  html: "html",
  htm: "html",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  svg: "image",
  webp: "image",
  ico: "image",
  avif: "image",
  bmp: "image",
  yaml: "config",
  yml: "config",
  toml: "config",
  ini: "config",
  conf: "config",
  xml: "config",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "shell",
  txt: "text",
  log: "text",
  csv: "text",
};

export const FILE_ICON_TONE: Record<FileIconKind, FileIconTone> = {
  folder: "warning",
  "folder-open": "warning",
  code: "info",
  json: "warning",
  markdown: "info",
  style: "info",
  html: "danger",
  image: "success",
  config: "muted",
  shell: "success",
  lock: "muted",
  env: "warning",
  git: "danger",
  text: "muted",
  file: "muted",
};

export function fileIconKind(name: string, type: "file" | "directory", expanded?: boolean): FileIconKind {
  if (type === "directory") return expanded ? "folder-open" : "folder";

  const basename = name.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (LOCKFILE_NAMES.has(basename) || basename.endsWith(".lock")) return "lock";
  if (GIT_NAMES.has(basename)) return "git";
  if (basename === ".env" || basename.startsWith(".env.")) return "env";
  if (CONFIG_NAMES.has(basename)) return "config";

  const dot = basename.lastIndexOf(".");
  if (dot > 0) {
    const extension = basename.slice(dot + 1);
    const kind = EXTENSION_KIND[extension];
    if (kind) return kind;
  }

  if (basename.startsWith(".")) return "config";
  return "file";
}
