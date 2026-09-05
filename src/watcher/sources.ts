/**
 * Where provider specs come from. Public, machine-readable, fetched read-only.
 * Stripe publishes its OpenAPI document in a public repository; a git ref
 * gives us any historical version for replay.
 */
export interface SpecSource {
  provider: "stripe";
  url(ref: string): string;
  defaultRef: string;
}

export const STRIPE_SOURCE: SpecSource = {
  provider: "stripe",
  defaultRef: "master",
  url: (ref) => `https://raw.githubusercontent.com/stripe/openapi/${ref}/openapi/spec3.json`,
};

export async function fetchSpec(source: SpecSource, ref = source.defaultRef, timeoutMs = 60_000): Promise<string> {
  const res = await fetch(source.url(ref), { signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "arcdrip-watcher" } });
  if (!res.ok) throw new Error(`${source.provider} spec fetch failed: HTTP ${res.status} for ${source.url(ref)}`);
  return await res.text();
}
