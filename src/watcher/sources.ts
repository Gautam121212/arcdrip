/**
 * Where provider specs come from. Public, machine-readable, fetched read-only.
 * Stripe publishes its OpenAPI document in a public repository; a git ref
 * gives us any historical version for replay. The repository can be overridden
 * (a fork you edit) to test the whole pipeline against a change you control.
 *
 * We never fetch a branch URL. raw.githubusercontent.com is served through a
 * CDN with minutes of caching, and a branch URL can flap between old and new
 * content after a push. A branch is first resolved to its commit SHA through
 * the API; the raw file is then fetched at that SHA, which is immutable.
 */
import { spawnSync } from "node:child_process";

export interface SpecSource {
  provider: "stripe";
  repo: string; // owner/name
  path: string;
  defaultRef: string;
  url(sha: string): string;
}

export const DEFAULT_STRIPE_REPO = "stripe/openapi";

export function stripeSource(repo: string = DEFAULT_STRIPE_REPO): SpecSource {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.includes("..")) throw new Error(`spec repo must be owner/name, got ${JSON.stringify(repo)}`);
  return {
    provider: "stripe",
    repo,
    path: "openapi/spec3.json",
    defaultRef: "master",
    url: (sha) => `https://raw.githubusercontent.com/${repo}/${sha}/openapi/spec3.json`,
  };
}

/** Default source. Kept for callers that don't override the repo. */
export const STRIPE_SOURCE: SpecSource = stripeSource();

export interface FetchedSpec {
  raw: string;
  /** the commit the content was fetched at — always a full SHA */
  sha: string;
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * Resolve a branch, tag, or short SHA to a full commit SHA.
 * `git ls-remote` first: no token, no rate limit, works wherever git does.
 * The REST API is the fallback (uses GITHUB_TOKEN when present).
 */
export async function resolveRef(source: SpecSource, ref: string, timeoutMs = 30_000): Promise<string> {
  if (SHA.test(ref)) return ref;
  const viaGit = lsRemote(source.repo, ref, timeoutMs);
  if (viaGit) return viaGit;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "arcdrip-watcher" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${source.repo}/commits/${encodeURIComponent(ref)}`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`could not resolve ${source.repo}@${ref}: HTTP ${res.status}`);
  const data = (await res.json()) as { sha?: string };
  if (!data.sha || !SHA.test(data.sha)) throw new Error(`could not resolve ${source.repo}@${ref}: no sha in response`);
  return data.sha;
}

function lsRemote(repo: string, ref: string, timeoutMs: number): string | null {
  try {
    const out = spawnSync("git", ["ls-remote", "--heads", "--tags", `https://github.com/${repo}.git`, ref, `${ref}^{}`], {
      encoding: "utf8",
      timeout: timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    if (out.status !== 0 || !out.stdout) return null;
    // Prefer the peeled tag object (`ref^{}`) if present, else the head/tag line.
    const lines = out.stdout.trim().split("\n").map((l) => l.split("\t"));
    const peeled = lines.find(([, name]) => name?.endsWith("^{}"));
    const sha = (peeled ?? lines[0])?.[0];
    return sha && SHA.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export async function fetchSpec(source: SpecSource, ref = source.defaultRef, timeoutMs = 60_000): Promise<FetchedSpec> {
  const sha = await resolveRef(source, ref);
  const res = await fetch(source.url(sha), { signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "arcdrip-watcher" } });
  if (!res.ok) throw new Error(`${source.provider} spec fetch failed: HTTP ${res.status} for ${source.url(sha)}`);
  return { raw: await res.text(), sha };
}
