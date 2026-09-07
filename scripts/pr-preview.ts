import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FILES = 500;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export interface PreviewFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface PreviewManifest {
  version: 1;
  prNumber: number;
  sha: string;
  basePath: string;
  files: PreviewFile[];
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function safeRelativePath(value: string): string {
  if (!value || value.length > 240 || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Invalid preview path: ${JSON.stringify(value)}`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.startsWith("../") || normalized.startsWith("/") || normalized === ".git" || normalized.startsWith(".git/")) {
    throw new Error(`Unsafe preview path: ${value}`);
  }
  return value;
}

function walk(root: string, directory = root): PreviewFile[] {
  const files: PreviewFile[] = [];
  for (const name of readdirSync(directory).sort()) {
    const absolute = path.join(directory, name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Preview contains a symbolic link: ${path.relative(root, absolute)}`);
    if (stat.isDirectory()) {
      files.push(...walk(root, absolute));
      continue;
    }
    if (!stat.isFile()) throw new Error(`Preview contains a non-file entry: ${path.relative(root, absolute)}`);
    const relative = safeRelativePath(path.relative(root, absolute).split(path.sep).join("/"));
    if (stat.size > MAX_FILE_BYTES) throw new Error(`Preview file exceeds 8 MiB: ${relative}`);
    files.push({ path: relative, bytes: stat.size, sha256: sha256(absolute) });
  }
  return files;
}

function validateFileSet(files: PreviewFile[]): void {
  if (files.length === 0 || files.length > MAX_FILES) throw new Error(`Preview file count must be between 1 and ${MAX_FILES}`);
  if (!files.some((file) => file.path === "index.html")) throw new Error("Preview is missing index.html");
  if (!files.some((file) => /^assets\/.*\.js$/u.test(file.path))) throw new Error("Preview is missing a compiled JavaScript asset");
  const names = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    safeRelativePath(file.path);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE_BYTES) throw new Error(`Invalid size for ${file.path}`);
    if (!/^[0-9a-f]{64}$/u.test(file.sha256)) throw new Error(`Invalid digest for ${file.path}`);
    if (names.has(file.path)) throw new Error(`Duplicate preview path: ${file.path}`);
    names.add(file.path);
    bytes += file.bytes;
  }
  if (bytes > MAX_TOTAL_BYTES) throw new Error("Preview exceeds 50 MiB");
}

function validateIdentity(prNumber: number, sha: string, basePath: string): void {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error("PR number must be a positive integer");
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error("SHA must be a full lowercase commit SHA");
  // The leading segment is the repository name, which the workflow derives from
  // the event so a rename cannot desynchronise the built base path from the
  // path Pages actually serves. Only the PR number is pinned here.
  if (!new RegExp(`^/[A-Za-z0-9._-]+/pr-previews/pr-${prNumber}/$`, "u").test(basePath)) throw new Error("Preview base path does not match its PR number");
}

export function packagePreview(buildDirectory: string, outputDirectory: string, prNumber: number, sha: string, basePath: string): PreviewManifest {
  const buildRoot = path.resolve(buildDirectory);
  const outputRoot = path.resolve(outputDirectory);
  if (!existsSync(buildRoot)) throw new Error(`Preview build does not exist: ${buildRoot}`);
  if (outputRoot === buildRoot || outputRoot.startsWith(`${buildRoot}${path.sep}`) || buildRoot.startsWith(`${outputRoot}${path.sep}`)) {
    throw new Error("Build and output directories must not overlap");
  }
  validateIdentity(prNumber, sha, basePath);
  const files = walk(buildRoot);
  validateFileSet(files);
  const manifest: PreviewManifest = { version: 1, prNumber, sha, basePath, files };
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  cpSync(buildRoot, path.join(outputRoot, "site"), { recursive: true });
  writeFileSync(path.join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function validatePreviewBundle(bundleDirectory: string, prNumber: number, sha: string): PreviewManifest {
  const bundleRoot = path.resolve(bundleDirectory);
  const manifestPath = path.join(bundleRoot, "manifest.json");
  const siteRoot = path.join(bundleRoot, "site");
  if (!existsSync(manifestPath) || !existsSync(siteRoot)) throw new Error("Preview bundle must contain manifest.json and site/");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PreviewManifest;
  if (manifest.version !== 1 || manifest.prNumber !== prNumber || manifest.sha !== sha) throw new Error("Preview manifest identity does not match the workflow run");
  validateIdentity(manifest.prNumber, manifest.sha, manifest.basePath);
  validateFileSet(manifest.files);
  const actual = walk(siteRoot);
  validateFileSet(actual);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error("Preview files do not match the signed manifest inventory");
  return manifest;
}

function required(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function main(): void {
  const command = process.argv[2];
  const bundle = path.resolve(required("--bundle"));
  const prNumber = Number(required("--pr-number"));
  const sha = required("--sha");
  if (command === "package") {
    const manifest = packagePreview(required("--build"), bundle, prNumber, sha, required("--base-path"));
    console.log(JSON.stringify({ files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) }));
    return;
  }
  if (command === "validate") {
    const manifest = validatePreviewBundle(bundle, prNumber, sha);
    console.log(JSON.stringify({ files: manifest.files.length, basePath: manifest.basePath }));
    return;
  }
  throw new Error('Expected command "package" or "validate"');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
