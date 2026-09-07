import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { digest, galleryComment, GALLERY_MARKER, validateGallery, type GalleryManifest } from "./review-gallery.js";

export type GithubApi = (endpoint: string, method?: string, payload?: unknown) => Promise<any>;
export const githubApi: GithubApi = async (endpoint, method = "GET", payload) => {
  const value = execFileSync("gh", ["api", endpoint, "--method", method, ...(payload === undefined ? [] : ["--input", "-"])], {
    input: payload === undefined ? undefined : JSON.stringify(payload), encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60_000,
  });
  return value.trim() ? JSON.parse(value) : null;
};

export function assertAssetPushSafe(workflow: string): void {
  const on = parse(workflow)?.on;
  if (!on) throw new Error("workflow has no recognizable trigger");
  if (on === "push" || Array.isArray(on) && on.includes("push")) throw new Error("asset branch would trigger an unrestricted push workflow");
  if (typeof on !== "object" || Array.isArray(on) || !("push" in on)) return;
  const branches = on.push?.branches;
  // Fail closed on broad globs or unsupported trigger forms; file path filters
  // are not proof because PNGs may match them. main-only workflows are fine.
  if (!Array.isArray(branches) || !branches.length || branches.some((b: unknown) => typeof b !== "string" || !/^[A-Za-z0-9_/-]+$/.test(b) || b.startsWith("artifacts/"))) {
    throw new Error("cannot prove asset branch is excluded from push workflows");
  }
}

export async function assertPublishTarget(api: GithubApi, repository: string, prNumber: number, sha: string): Promise<any> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error("invalid repository or PR");
  const repo = await api(`repos/${repository}`);
  const pr = await api(`repos/${repository}/pulls/${prNumber}`);
  if (repo.private) throw new Error("inline raw image publication requires a public repository");
  if (pr.state !== "open" || pr.head.sha !== sha) throw new Error("PR closed or source SHA is stale; recapture the current head");
  if (pr.head.repo?.full_name !== repository) throw new Error("fork publication refused; use read-only Actions artifacts and trusted maintainer review");
  return pr;
}

async function allComments(api: GithubApi, repository: string, pr: number): Promise<any[]> {
  const comments: any[] = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await api(`repos/${repository}/issues/${pr}/comments?per_page=100&page=${page}`);
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
  throw new Error("comment search truncated; refusing to create a duplicate gallery");
}

export async function updateGalleryComment(api: GithubApi, repository: string, pr: number, sha: string, body: string): Promise<void> {
  await assertPublishTarget(api, repository, pr, sha);
  const actor = await api("user");
  const comments = await allComments(api, repository, pr);
  const own = comments.filter(c => c.user?.id === actor.id && c.body?.startsWith(GALLERY_MARKER));
  if (own.length > 1) throw new Error("multiple actor-owned galleries; resolve duplicates before publishing");
  if (own[0]) await api(`repos/${repository}/issues/comments/${own[0].id}`, "PATCH", { body });
  else await api(`repos/${repository}/issues/${pr}/comments`, "POST", { body });
}

export async function publishGallery(input: {
  directory: string; repository: string; pr: number; sha: string;
  api?: GithubApi; verifyUrl?: (url: string, expectedHash: string) => Promise<void>;
}): Promise<{ manifest: GalleryManifest; branch: string; urls: Record<string, string> }> {
  const api = input.api ?? githubApi;
  // Validate every file before making any external write.
  const manifest = validateGallery(input.directory, input.sha);
  await assertPublishTarget(api, input.repository, input.pr, input.sha);
  const prefix = `repos/${input.repository}`;
  const repo = await api(prefix);
  const workflows = await api(`${prefix}/contents/.github/workflows?ref=${encodeURIComponent(repo.default_branch)}`);
  if (!Array.isArray(workflows) || workflows.length > 100) throw new Error("invalid workflow inventory");
  for (const entry of workflows) {
    if (entry.type !== "file" || !/\.ya?ml$/.test(entry.name)) continue;
    const file = await api(`${prefix}/contents/.github/workflows/${encodeURIComponent(entry.name)}?ref=${encodeURIComponent(repo.default_branch)}`);
    if (file.encoding !== "base64" || file.size > 256_000) throw new Error("invalid workflow file");
    assertAssetPushSafe(Buffer.from(file.content, "base64").toString("utf8"));
  }
  const branch = `artifacts/pr-${input.pr}-review`;
  let exists = true;
  try { await api(`${prefix}/git/ref/heads/${branch}`); }
  catch (error) {
    // gh exits nonzero for other failures too: confirm absence via exact matching refs.
    const refs = await api(`${prefix}/git/matching-refs/heads/${branch}`);
    if (refs.some((r: any) => r.ref === `refs/heads/${branch}`)) throw error;
    exists = false;
  }
  if (!exists) await api(`${prefix}/git/refs`, "POST", { ref: `refs/heads/${branch}`, sha: input.sha });
  const urls: Record<string, string> = {};
  const verify = input.verifyUrl ?? (async (url, expectedHash) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "error" });
      if (response.ok && digest(Buffer.from(await response.arrayBuffer())) === expectedHash) return;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
    throw new Error(`image URL did not return the captured bytes: ${url}`);
  });
  for (const image of manifest.images) {
    const target = `pr-review/${input.pr}/${input.sha}/${image.filename}`;
    let existing: any;
    try { existing = await api(`${prefix}/contents/${target}?ref=${encodeURIComponent(branch)}`); }
    catch {
      // If the branch became unavailable, don't mistake that for a missing file.
      await api(`${prefix}/git/ref/heads/${branch}`);
    }
    const bytes = readFileSync(path.join(input.directory, image.filename));
    if (digest(bytes) !== image.sha256) throw new Error("capture changed after validation");
    const result = await api(`${prefix}/contents/${target}`, "PUT", {
      branch, message: `Review evidence for PR #${input.pr} at ${input.sha.slice(0, 7)}`,
      content: bytes.toString("base64"), ...(existing?.sha ? { sha: existing.sha } : {}),
    });
    if (!/^[0-9a-f]{40}$/.test(result.commit?.sha)) throw new Error("Contents API returned no commit SHA");
    const url = `https://raw.githubusercontent.com/${input.repository}/${result.commit.sha}/${target}`;
    await verify(url, image.sha256);
    urls[image.filename] = url;
  }
  // A concurrent PR push invalidates this gallery before the comment can be replaced.
  await updateGalleryComment(api, input.repository, input.pr, input.sha, galleryComment(manifest, urls, branch));
  return { manifest, branch, urls };
}
