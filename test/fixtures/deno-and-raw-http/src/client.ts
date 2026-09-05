// Raw HTTP with a dynamic path: provider is known, operation is not -> Tier 3.
const BASE = "https://api.stripe.com";

export async function get(resource: string, id: string, key: string) {
  const res = await fetch(`${BASE}/v1/${resource}/${id}`, { headers: { Authorization: `Bearer ${key}` } });
  return res.json();
}
export async function listAll(resource: string, key: string) {
  const res = await fetch(`https://api.stripe.com/v1/${resource}?limit=100`, { headers: { Authorization: `Bearer ${key}` } });
  return res.json();
}
