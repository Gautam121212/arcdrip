/**
 * Where provider specs come from. Public, machine-readable, fetched read-only.
 * Stripe publishes its OpenAPI document in a public repository; a git ref
 * gives us any historical version for replay. The repository can be overridden
 * (a fork you edit) to test the whole pipeline against a change you control.
 */
export interface SpecSource {
  provider: "stripe";
  repo: string; // owner/name
  url(ref: string): string;
  defaultRef: string;
}

export const DEFAULT_STRIPE_REPO = "stripe/openapi";

export function stripeSource(repo: string = DEFAULT_STRIPE_REPO): SpecSource {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.includes("..")) throw new Error(`spec repo must be owner/name, got ${JSON.stringify(repo)}`);
  return {
    provider: "stripe",
    repo,
    defaultRef: "master",
    url: (ref) => `https://raw.githubusercontent.com/${repo}/${ref}/openapi/spec3.json`,
  };
}

/** Default source. Kept for callers that don't override the repo. */
export const STRIPE_SOURCE: SpecSource = stripeSource();

export async function fetchSpec(source: SpecSource, ref = source.defaultRef, timeoutMs = 60_000): Promise<string> {
  const res = await fetch(source.url(ref), { signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "arcdrip-watcher" } });
  if (!res.ok) throw new Error(`${source.provider} spec fetch failed: HTTP ${res.status} for ${source.url(ref)}`);
  return await res.text();
}
