// Deno / edge-runtime style: the SDK is imported by URL-ish specifier, so the
// type checker cannot resolve it. We trust the import text -> Tier 2.
import Stripe from "npm:stripe";

export async function ensureEndpoint(key: string, url: string) {
  const stripe = new Stripe(key);
  const existing = await stripe.webhookEndpoints.list({ limit: 100 });
  for (const old of existing.data.filter((e) => e.url === url)) {
    await stripe.webhookEndpoints.del(old.id);
  }
  const endpoint = await stripe.webhookEndpoints.create({ url, enabled_events: ["*"], metadata: { managed_by: "us" } });
  const account = await stripe.accounts.retrieve();
  return { secret: endpoint.secret, account: account.id, count: existing.data.length };
}
