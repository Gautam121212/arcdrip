# arcdrip — scanner

Maps a repository's third-party API dependencies (which provider, which operation,
which request/response fields, which pinned version, which webhook events) into a
strict, identifier-only manifest. Read-only. No LLM in the scanner.

```
npm install
npm test                                        # golden + invariant tests
npm run scan -- test/fixtures/stripe-basic
npm run scan -- ../some-repo -o manifest.local.json
npm run scan -- ../some-repo --redact-paths     # what the upload path sends
npm run scan -- ../some-repo --include-tests    # test files are excluded by default
ARCDRIP_DEBUG=1 npm run scan -- ../some-repo    # stack traces for skipped files
```

Design: see `docs/phase1-design.md`.

## Detection tiers (Stripe)
- **T1** — method declared by the `stripe` package, per the type checker. Operation and fields are certain.
- **T2** — client built from an explicit SDK import the checker can't resolve (`npm:stripe`, esm.sh). Operation from the method name; fields extracted the same way.
- **T3** — the API host appears in a string (raw HTTP with dynamic paths, a base-URL constant). Provider presence only; never fields.

## Operation table
SDK method → HTTP operation is **derived from the installed stripe-node package** (its generated
resource files name every verb and path), so it is correct for whatever version the customer has.
Path placeholders are canonicalised to `{}`. When no SDK is on disk (Deno `npm:stripe`), a bundled
table generated from a known version is used (`npm run gen:stripe-table` after bumping `stripe`).
Anything still unresolved appears as `sdk:<method.path>` with fields intact.

## Invariants (enforced by tests)
- The manifest schema is a strict allowlist; unknown keys are rejected.
- Nothing that looks like a secret or a source blob can be uploaded.
- A Tier-3 entry never carries field-level data.
- `fieldsComplete: false` whenever a result flows somewhere we stopped tracking.
- Any change to golden output is a reviewed diff (`UPDATE_GOLDEN=1 npm test` to accept).

## Watcher (Stripe)
Snapshots Stripe's public OpenAPI document, diffs snapshots into the change taxonomy, and joins the
breaking changes against a manifest. Only changes that intersect something the code reads, writes,
calls, or handles become alerts; additive changes never do.

```
npm run scan -- ../some-repo -o manifest.json
npx tsx src/cli.ts watch fetch                # latest spec: "pending" first time, "accepted" second time (debounce)
npx tsx src/cli.ts watch fetch --ref <sha>    # a historical spec by git ref (trusted, no debounce)
npx tsx src/cli.ts watch status
npx tsx src/cli.ts watch diff                 # summary of changes between the last two accepted snapshots
npx tsx src/cli.ts watch alerts --manifest manifest.json
npx tsx src/cli.ts watch replay --from-ref <sha> --to-ref <sha> --manifest manifest.json
```

Acceptance discipline: a snapshot must parse, keep its operation count within ±20% of the last
accepted one, and (for "latest" fetches) be seen in two consecutive fetches. Everything else is
quarantined and listed by `watch status`. Snapshots live under `.arcdrip/` (git-ignored).

Version applicability: code pinned to an older Stripe API version gets `advisory` alerts with a
note; unpinned code gets `breaking`.

Replay of the 2025 basil change against vercel/nextjs-subscription-payments:
```
npx tsx src/cli.ts watch replay \
  --from-ref 5a411d0d1e527229cdb4d6633197ab8009899ce6 \
  --to-ref   a2daacd414ad5c3cf88d79a4214e35595b239490 \
  --manifest nsp.manifest.json
```
276 spec changes, 152 breaking, 2 alerts: `current_period_start` and `current_period_end` removed
from `subscription`, read at `utils/supabase/admin.ts:228`.

## GitHub Action (standalone mode)
Runs the scanner and the watcher inside your CI. Nothing leaves it: the manifest is written to the
runner's temp directory (never the workspace), the Stripe spec is fetched from Stripe's public
repository, and alerts are reported with the workflow's own token as a **check run** (annotations on
the affected lines) and **one issue per alert** (label `arcdrip`). Issues close themselves when the
code stops depending on the changed field; close one manually to acknowledge it.

Add `.github/workflows/arcdrip.yml`:

```yaml
name: arcdrip
on:
  schedule: [{ cron: "0 */6 * * *" }]
  push: { branches: [main] }
  workflow_dispatch:
permissions:
  contents: read
  checks: write
  issues: write
jobs:
  arcdrip:
    runs-on: ubuntu-latest
    continue-on-error: true      # arcdrip never blocks your pipeline
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: Gautam121212/arcdrip@main     # pin to a SHA once released
```

Optional inputs: `include_tests: "true"`, `budget_seconds: "300"`, and `seed_ref: <sha>` to use a
historical Stripe spec as the first baseline (replay a known change on the first two runs).

How alerts flow: the first run records a baseline snapshot; each later run fetches the latest spec
(accepted when seen twice, ±20% operation band); when a newly accepted snapshot differs from the
previous one and the difference touches this code, an alert opens. State persists in the Actions
cache; if the cache is evicted, the next run re-baselines.

Local dry run of the whole Action against any repo (no GitHub calls):
```
npx tsx src/cli.ts action ../some-repo --seed-ref 5a411d0d1e527229cdb4d6633197ab8009899ce6
npx tsx src/cli.ts action ../some-repo        # second run: accepts the latest spec and reports
```
