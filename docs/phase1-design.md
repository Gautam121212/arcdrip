# arcdrip — Phase 1: Integration Drift Detector

**Status:** Design, pre-build. All open decisions resolved (§9).
**Scope:** Read-only detection. No code changes, no PRs, no fixes.
**Design principle:** *Fail-safe, not foolproof.* Every failure mode must land on our side (missed alert, degraded run) and never on the customer's side (broken CI, leaked code, wrong change to their repo).

---

## 1. What Phase 1 does — and does not do

**Does**

1. Builds a **dependency manifest** for a repo: which third-party APIs it calls, which operations, which request/response fields it actually reads or writes, which API version it is pinned to, and which webhook events it handles.
2. Watches those providers for changes (spec diffs, changelogs, deprecation notices).
3. When a provider change **intersects the manifest**, surfaces an alert *inside GitHub* at the exact lines affected, with evidence.

**Does not**

- Modify any file in the customer's repo. Ever.
- Open pull requests.
- Store, transmit, or log customer source code.
- Hold any GitHub credential on our side. (See §3 — the service has zero access to the customer's GitHub.)
- Alert on additive, non-breaking changes (digest only).
- Probe live traffic or use customer API keys (Phase 2).

Everything in the "does not" list is a hard rule, not a default. If a customer asks for auto-merge, the answer is no.

---

## 2. Architecture

Three components. The trust boundary is the most important line in this document.

```
┌──────────────── Customer's GitHub / CI ────────────────┐
│                                                        │
│  [Scanner]  runs as a GitHub Action inside their CI    │
│     ├── reads repo (contents: read)                    │
│     ├── emits manifest.json  (identifiers only)        │
│     ├── POSTs manifest  ───────────────┐               │
│     ├── GETs pending alerts ◄──────────┼───────┐       │
│     └── writes Check annotations + Issues (their token)│
│                                        │       │       │
└────────────────────────────────────────┼───────┼───────┘
                    trust boundary ──────┼───────┼───────
┌───────────────── Our service ──────────┼───────┼───────┐
│                                        ▼       │       │
│  [Watcher]  polls provider specs/changelogs    │       │
│     ├── snapshots, diffs, classifies changes   │       │
│     └── joins changes × manifests  ──► [Alert store]   │
│                                                        │
│  Stores: manifests (identifiers), snapshots, alerts    │
│  Never stores: source, file contents, paths (opt-in)   │
└────────────────────────────────────────────────────────┘
```

> **Implementation note (2026-09-06).** Phase 1 shipped in *standalone mode*: the Action runs the
> scanner **and** the watcher inside the customer's CI, keeps snapshots and alert state in the
> Actions cache, and reports via the workflow's own token. There is no hosted service and no
> upload at all — strictly more private than the design below, at the cost of each repo fetching
> the spec itself. The hosted watcher (one fetch serving every customer, the cross-customer
> pattern library) is Phase 2, once there are enough installs to amortise it. The manifest
> schema, redaction, and outbound checks are unchanged so that move is additive.

### 2.1 Why pull, not push

The service never contacts GitHub. The Action **pulls** pending alerts on each run (scheduled every 6h, plus on push, plus manual). Consequences:

- No GitHub App, no OAuth, no installation token, no `repository_dispatch` (which would require `contents: write`).
- The customer reads one workflow file and sees every permission we use.
- If our service is down, nothing happens to them. The Action logs and exits 0.
- Alert latency ≤ 6h. Acceptable for Phase 1; provider changes have days-to-months of notice in most cases.

### 2.2 Workflow the customer installs

```yaml
name: integration-drift
on:
  schedule: [{ cron: "0 */6 * * *" }]
  push: { branches: [main] }
  workflow_dispatch:

permissions:
  contents: read      # scan the repo
  checks: write       # annotate affected lines
  issues: write       # one issue per provider change

jobs:
  scan:
    runs-on: ubuntu-latest
    continue-on-error: true          # NEVER fail their pipeline
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@<pinned-sha>
      - uses: arcdrip/scan@<pinned-sha>
        with:
          api_key: ${{ secrets.ARCDRIP_API_KEY }}
          providers: auto            # or explicit list
          redact_paths: true         # default: paths never leave CI
```

`continue-on-error: true` and `timeout-minutes` are non-negotiable defaults in the docs and the template. A monitoring tool that breaks CI is worse than no tool.

---

## 3. The Scanner

**Language scope (Phase 1): TypeScript and JavaScript only.** Reasons: largest share of SaaS integration code on GitHub, type information makes Tier-1 detection deterministic, and it's the stack you know best. Python is Phase 2.

**Engine:** TypeScript compiler API via `ts-morph`. Deterministic. **No LLM anywhere in the scanner.** Where the cost of being wrong is high, the analysis must be reproducible and explainable.

### 3.1 Detection tiers

Each manifest entry carries a confidence tier. **Tiers gate what we are allowed to alert on.** This is the single biggest false-positive control in the design.

| Tier | How detected | Operation known? | Fields known? | Alert scope |
|---|---|---|---|---|
| **T1** | Official SDK call resolved through SDK type declarations (`stripe.customers.retrieve(...)`, `client.messages.create(...)`) | Yes, exact | Yes — object-literal keys sent, property accesses on typed response | Field-level and operation-level |
| **T2** | Raw HTTP with literal host + path (`fetch("https://api.stripe.com/v1/customers/...")`, axios `baseURL` + literal path) | Matched to spec path template | Request body literal keys; response fields via local variable flow only | Operation-level always; field-level only when flow is fully local to one function |
| **T3** | Provider host known, path dynamic / concatenated / passed through untyped layers | No | No | Provider-wide events only: version retirement, auth change, host change, mass endpoint removal |

**Rule: a T3 entry never produces a field-level alert.** If we can't prove the code touches the field, we don't claim it does.

### 3.2 What is extracted

Per repo:

1. **Outbound calls** — provider, operation (method + path template or SDK method), direction per field (`read` from response / `write` in request), code location, tier.
2. **Webhook handlers** — signature verification calls (`stripe.webhooks.constructEvent`, Shopify HMAC check), `switch (event.type)` / `if (event.type === ...)` cases, and property reads from the event payload. Webhook payload changes are a top cause of silent breakage and are almost never covered by monitoring tools.
3. **Version pins** — `apiVersion` in SDK constructors, version segments in URLs (`/admin/api/2025-07/`), `Stripe-Version` / `Shopify-API-Version` headers, SDK package version from the lockfile.
4. **Exhaustive enum handling** — `switch` statements over provider enums without a `default`. Lets us alert on *added* enum values only where they'd actually break something. (This is the one case where an additive change can be breaking.)
5. **Coverage stats** — count of T1/T2/T3 entries. Reported to the customer so they know what we can and cannot see.

### 3.3 Manifest schema (what leaves CI)

```json
{
  "schema": 1,
  "repo_id": "opaque-hash",
  "scanner_version": "0.3.1",
  "scanned_at": "2026-09-03T10:00:00Z",
  "partial": false,
  "providers": {
    "stripe": {
      "pinned_version": "2024-06-20",
      "sdk": { "package": "stripe", "version": "16.2.0" },
      "entries": [
        {
          "id": "e_7f3a...",
          "kind": "call",
          "operation": "GET /v1/customers/{customer}",
          "fields": [
            { "path": "default_source", "dir": "read" },
            { "path": "invoice_settings.default_payment_method", "dir": "read" }
          ],
          "tier": 1,
          "loc": null
        },
        {
          "id": "e_91cc...",
          "kind": "webhook",
          "event": "invoice.payment_failed",
          "fields": [{ "path": "data.object.last_payment_error.code", "dir": "read" }],
          "tier": 1,
          "loc": null
        }
      ]
    }
  },
  "coverage": { "t1": 41, "t2": 6, "t3": 3 }
}
```

**`loc` is null by default (`redact_paths: true`).** The service matches alerts to entry IDs; the Action re-derives locations locally on its next run and annotates the lines itself. File paths and line numbers never leave CI unless the customer opts in.

**Outbound allowlist:** the Action serialises the manifest through a strict schema validator with an allowlist of fields. Anything not in the schema is dropped. As a second layer, the outgoing JSON is scanned for secret patterns and any string > 200 chars; a hit aborts the upload and logs why. The manifest contains identifiers, never values.

---

## 4. The Watcher

### 4.1 Provider set for Phase 1

Six providers, chosen for (a) machine-readable specs, (b) usage frequency, (c) known change velocity.

| Provider | Primary source | Secondary source | Notes |
|---|---|---|---|
| Stripe | `stripe/openapi` GitHub repo (versioned) | API changelog page | Versions are immutable; diff pinned-vs-pinned + changelog for all-version changes |
| Twilio | `twilio/twilio-oai` | Changelog | |
| GitHub | `github/rest-api-description` | Changelog | Deprecation headers in responses (Phase 2) |
| Shopify | GraphQL Admin schema per version | Release notes | Quarterly versions, 12-month support. Scheduled retirements = the highest-precision alert type we can emit |
| OpenAI | `openai/openai-openapi` | Changelog, deprecations page | Highest incident frequency in the category |
| HubSpot | Public OpenAPI specs (confirm exact endpoint) | Changelog | |

Anthropic: changelog-based until a machine-readable spec source is confirmed.

### 4.2 Snapshot discipline

Providers publish partial or reverted specs. Rules:

1. A new snapshot is **accepted only if** it parses, and its size and operation count are within ±20% of the previous accepted snapshot. Outside that band → quarantine, retry next cycle, alert *ourselves*, not customers.
2. A change must be observed in **two consecutive fetches** before it is eligible to alert (debounce). This costs one polling interval and removes publish-then-revert noise.
3. Every snapshot is content-hashed and retained. Diffs are reproducible from history.

### 4.3 Diff and classification

- OpenAPI: `oasdiff` for structural diffs and breaking-change classification, wrapped with our own taxonomy.
- GraphQL: `graphql-inspector`.
- Changelogs / deprecation pages: fetched, then an LLM (Claude) extracts structured facts: `{provider, operation, field, change_type, effective_date, affected_versions, quote, url}`.

**LLM guardrail:** every extracted fact must include a verbatim `quote` that string-matches the fetched page. No match → fact discarded. Changelog-derived changes are tagged `announced`; spec-derived changes are tagged `observed`. `announced` alerts carry lower severity until confirmed by a spec diff or their effective date.

### 4.4 Change taxonomy

| Code | Breaking? | Alerts when customer… |
|---|---|---|
| `OPERATION_REMOVED` | Yes | calls it (T1/T2) |
| `FIELD_REMOVED` (response) | Yes | reads it (T1, or T2-local) |
| `FIELD_TYPE_CHANGED` | Yes | reads/writes it |
| `FIELD_NULLABLE_CHANGED` | Yes | reads it — the "goes null, not gone" case |
| `REQUIRED_PARAM_ADDED` | Yes | calls the operation |
| `ENUM_VALUE_REMOVED` | Yes | reads the field |
| `ENUM_VALUE_ADDED` | Conditional | has exhaustive switch on it (§3.2.4) |
| `WEBHOOK_EVENT_REMOVED` | Yes | handles it |
| `WEBHOOK_PAYLOAD_CHANGED` | Yes | reads the changed path |
| `VERSION_RETIRED` / `SUNSET_ANNOUNCED` | Yes | is pinned to that version (with date) |
| `AUTH_CHANGED` | Yes | any entry for provider (incl. T3) |
| `RATE_LIMIT_CHANGED` | Advisory | any entry |
| `ADDITIVE` | No | never alerts; weekly digest only |

### 4.5 Version applicability

The customer's pinned version decides which diffs apply. This is the second-biggest false-positive control.

- **Pinned to an immutable version (Stripe, Shopify):** alert only on (a) changes the provider states apply to all versions, (b) retirement/sunset of *their* version, (c) a lockfile or config change that moves their effective version — in which case the diff is computed between old and new pin.
- **Unpinned / latest:** all breaking diffs apply.
- **Unknown pin:** treat as latest, but tag the alert `pin_unknown` so the customer sees why.

### 4.6 Join and alert generation

```
for each accepted change c of provider p:
  for each manifest m with entries under p:
    applicable = version_applies(c, m.pinned_version)
    matches    = entries in m that c touches, filtered by tier rules
    if applicable and matches: emit alert(c, m, matches)
```

Alert record:

```
provider, change_code, severity, source (observed|announced),
evidence: { spec_diff_snippet | changelog_quote, url, snapshot_hashes },
first_seen, effective_date, affected_entry_ids[],
status: open | acknowledged | dismissed(reason) | resolved(provider reverted)
```

- Dedup key: `(repo_id, provider, change_id)`. Re-observation updates, never duplicates.
- **Provider reverts** → alert auto-resolves with a note. We don't leave stale alarms.
- **Dismiss with reason** is a first-class action (`not_affected`, `already_handled`, `wrong`). Reasons feed the precision metrics in §6.

### 4.7 How it appears to the customer

On its next run the Action:

1. Creates a **Check Run** with annotations on the affected lines: change, evidence link, effective date, severity.
2. Opens or updates **one GitHub Issue per (provider, change)** with the full evidence and the list of affected locations. Updates in place; closes on resolve.
3. Optional Slack webhook (customer-supplied URL, customer-controlled).

Every alert answers, in this order: *what changed, where in your code, what proves it, when it takes effect.*

---

## 5. Failure modes and the rule for each

| Failure | Who could be hurt | Rule |
|---|---|---|
| Scanner crashes or exceeds time budget | Customer CI | `continue-on-error`, `timeout-minutes`, exit 0. Partial manifest marked `partial: true`; field-level alerts suppressed for the partial provider set |
| Scanner mis-attributes a field | Customer trust | Tier gating; T3 never field-level; evidence on every alert; dismiss-with-reason loop |
| Our API is down | Nobody | Action logs, exits 0, retries next run |
| Provider spec fetch fails or is malformed | Customer trust (false alarms) | Snapshot acceptance band + two-fetch debounce; quarantined snapshots never diff |
| LLM invents a changelog entry | Customer trust | Verbatim quote requirement; `announced` tag with lower severity |
| Provider publishes then reverts | Customer trust | Debounce catches most; auto-resolve catches the rest |
| Customer code or paths leak | Customer security | Manifest allowlist schema; `redact_paths` default; secret-pattern scan on outbound JSON; no source ever serialised |
| Our Action is compromised (supply chain) | Customer security | Pinned dependency SHAs, signed releases, SBOM published, minimal permissions, public source. Customers pin our SHA, not a tag |
| Alert storm on a major provider change | Customer attention | One issue per change set, not per entry; severity ordering; digest for advisory |
| Abuse / cost | Us | Per-key rate limits; manifest size cap (e.g. 2 MB); provider poll frequency fixed by us, not by customers |
| Data retention question in a security review | Sales | Manifests overwritten each scan; snapshots retained (public data); alerts retained; nothing else exists to retain |

---

## 6. Precision harness — how Phase 1 earns Phase 2

We do not need customers to measure precision. Providers with public spec history let us **replay the past**.

**Method**

1. Pull the full history of `stripe/openapi` (and equivalents). Reconstruct the spec at any date.
2. Find open-source repos on GitHub using the Stripe SDK. Check out each at a commit *before* a known breaking change.
3. Run the scanner, run the watcher diff for that change, generate alerts.
4. Ground truth: did the repo later change the affected code? (A commit touching those lines after the change date = true positive. No change and no runtime evidence = likely false positive or genuinely unaffected — label manually.)

**Metrics tracked from day one**

- Alert precision (true / total), per provider and per change code
- Scanner coverage: share of provider calls at T1 / T2 / T3
- Dismiss rate and reasons
- Time from provider change → alert (should be ≤ poll interval + 6h)

**Exit criteria for Phase 1** (gate to Phase 2 live-shape sampling, and later to fix PRs):

- ≥ 90% alert precision over 8 weeks of live running across ≥ 5 real repos (yours plus early installs)
- ≥ 80% of provider calls in those repos at T1/T2
- Zero incidents of customer CI failure attributable to the Action
- Zero manifest uploads containing anything outside the schema

**Kill criteria** (be honest early): after a public beta with ≥ 100 installs, fewer than 5 teams enable it on a private repo, or precision cannot be held above 80% on the top three providers.

---

## 7. Build plan

Assumes ~10–12 focused hours per week. Slower is fine; faster is not the goal. Each week ends with something runnable.

| Week | Build | Done when |
|---|---|---|
| 1–2 | Scanner core: ts-morph, Stripe SDK T1 detection, manifest schema + validator, local CLI output | Runs on your own repos; manifest matches a hand-audit of the code |
| 3 | T2 raw-HTTP detection, webhook handler detection, version-pin extraction, coverage stats | Hand-audit on 3 open-source Stripe repos |
| 4 | Watcher for Stripe: snapshot store, acceptance band, debounce, `oasdiff` wrapper, taxonomy mapping | Replays 5 historical Stripe changes correctly |
| 5 | Join logic, alert store, Action ↔ service protocol (upload, pull), Check annotations, Issue create/update | End-to-end on your repo with a replayed change |
| 6 | Add Twilio, GitHub, Shopify GraphQL, OpenAI, HubSpot; changelog extractor with quote guardrail for two of them | All six produce accepted snapshots and diffs |
| 7 | Hardening: every row in §5 has a test; supply-chain setup (pinned SHAs, signing, SBOM); secret-pattern outbound check | Failure-mode test suite green |
| 8 | Precision harness (§6) on ≥ 20 open-source repos; fix the top false-positive causes | Precision numbers you'd put in a README |
| 9–10 | Docs, security page (what leaves CI, what we store), Marketplace listing as free beta, dogfood on every repo you own | Public beta live |

Ten weeks part-time is realistic. If it's done in five, something in §5 was skipped.

### 7.1 Test strategy

- **Golden files:** fixture repos → expected manifest. Any change in scanner output is a reviewed diff.
- **Replay tests:** historical spec pairs → expected change set.
- **Mutation tests:** inject synthetic changes into a spec, assert alert/no-alert per taxonomy row.
- **Invariants:** additive changes never alert; T3 never field-level; manifest never contains a string outside the allowlist; Action never exits non-zero.

---

## 8. What stays deliberately out of Phase 1

- Python, Go, Java scanners
- Live response-shape sampling (needs customer traffic or keys)
- Fix PRs and generated tests
- Cross-customer pattern library (needs customers)
- Any GitHub App or hosted access to repos
- Pricing beyond "free beta"

Each is Phase 2+ and each is gated on the §6 exit criteria.

---

## 9. Decisions (resolved)

1. **Name: arcdrip.** Domain owned. A domain is not a trademark — run a basic trademark search (USPTO TESS, EUIPO) before the Marketplace listing, not before writing code.

2. **Hosting region: EU, Germany (Frankfurt / Falkenstein).**
   Reasoning: the customer base is US and EU engineering teams. EU hosting passes both sides' security reviews without a data-residency conversation; US-only hosting invites EU questions; India hosting invites questions from everyone. Latency is irrelevant — the only client is GitHub-hosted runners, and a manifest upload is one request every six hours. Cost is lowest in Germany (Hetzner) and every managed provider has a Frankfurt region if you'd rather not run a box.
   Concretely: Hetzner Cloud (Falkenstein) for the API + watcher, managed Postgres in an EU region (Neon or Supabase, eu-central), object storage in the same region for spec snapshots. Your location in India is irrelevant to this decision; the data's location is what gets asked.
   Related but deferred: payments. An Indian entity selling internationally should use a merchant-of-record (Paddle or Lemon Squeezy) rather than a direct Stripe account. Not needed until pricing exists (Phase 2+).

3. **Provider set: the six in §4.1, built in this order — Stripe, Shopify, OpenAI, GitHub, Twilio, HubSpot.**
   Stripe first because the precision harness (§6) depends on its public spec history. Shopify second because scheduled version retirements are the highest-precision alert type we can emit. OpenAI third because it has the highest change frequency and the most attention right now.

4. **`redact_paths`: `true` by default.** Paths never leave CI unless the customer opts in. Costs one poll interval of alert latency; buys a security page that says "we do not know your file names."

5. **Poll interval: 6 hours** for both the Action and the watcher. Revisit only if a customer asks and pays for it.
