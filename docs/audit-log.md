# Audit log

Numbers per run. "Missed" = Stripe call sites present in the source that the manifest did not contain.

## 2026-09-06 — vercel/nextjs-subscription-payments
Before fix/real-repo-patterns: 7 entries, 0 wrong, 14 missed, 0 crashes.
- Missed: all 10 webhook events (event bound by `let event; event = constructEvent(...)`), request fields on
  `checkout.sessions.create(params)` and `customers.create(customerData)` (params passed as a variable),
  `billingPortal.sessions.create` (not in table); `customers.update(...)` wrongly PARTIAL as a bare statement.
After: 17 entries, 0 wrong, 0 missed, 0 crashes. Fixture: route-handler-patterns.

## 2026-09-06 — supabase/stripe-sync-engine
Before fix/tiers-2-3-crash: crash (TypeScript checker throws on a plain .js file when allowJs is off),
partial=true, 0 entries. Every recoverable T1 hit was in a test file.
After: t1=0 t2=4 t3=1 (7 locations), partial=false, tests excluded by default. 0 wrong, 0 missed at T1/T2.
Known gap by design: the core engine uses raw HTTP with dynamic paths -> T3 provider presence only.
Fixture: deno-and-raw-http.

## Open items surfaced by these runs
1. `sdk:<method>` entries (webhookEndpoints.*, accounts.retrieve, products.update, events.list) need real
   HTTP operations: derive the table from the installed SDK instead of the hand-written map.
2. Raw HTTP with literal paths (`fetch("https://api.stripe.com/v1/customers")`) -> Tier 2 path matching.
3. Clients held on a class (`this.stripe = new Stripe(...)`) -> root is `this`, not an identifier.
4. Results consumed via `.then()`.
