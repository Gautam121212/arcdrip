# arcdrip

**Finds out when Stripe changes something your code depends on — before your customers do.**

Your code reads specific fields from Stripe responses and webhooks. Stripe changes its API a few times a year, and some of those changes remove or reshape fields. When that happens, nothing errors. Values go missing, numbers become strings, enum cases stop arriving, and you find out from a customer.

arcdrip is a GitHub Action that:

1. reads your repository and works out exactly which Stripe operations, fields, and webhook events your code uses;
2. watches Stripe's published API specification for changes;
3. opens an issue — with the exact file and line — only when a change touches something your code actually uses.

It is read-only. It never changes your code, never opens pull requests, and nothing leaves your CI.

## Install

Add `.github/workflows/arcdrip.yml`:

```yaml
name: arcdrip
on:
  schedule: [{ cron: "0 */6 * * *" }]   # check every 6 hours
  push: { branches: [main] }
  workflow_dispatch:
permissions:
  contents: read
  checks: write
  issues: write
jobs:
  arcdrip:
    runs-on: ubuntu-latest
    continue-on-error: true               # arcdrip never blocks your pipeline
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
      - uses: Gautam121212/arcdrip@v0.1.3   # or pin the commit SHA from the releases page
```

Commit and push. The first run records a baseline. From then on, every run compares the latest Stripe specification with the previous one and opens an issue for each change that affects your code.

If you install your dependencies before the arcdrip step (`npm ci`), arcdrip resolves calls through the TypeScript type checker and is more precise. It works without that too.

## What you get

**A check run** named `arcdrip` on each run, with annotations on the affected lines. It shows "action required" when a change is breaking.

**One issue per alert**, labelled `arcdrip`, like this:

> **[arcdrip] FIELD_REMOVED: GET /v1/subscriptions/{} → current_period_end**
>
> | | |
> |---|---|
> | Change | `FIELD_REMOVED` — current_period_end removed (schema `subscription`) |
> | Where in the API | `GET /v1/subscriptions/{}` — this code reads `current_period_end` |
> | Between versions | `2025-02-24.acacia` → `2025-05-28.basil` |
>
> **Affected code**
> - `utils/supabase/admin.ts:228`

Issues maintain themselves:

- when your code stops depending on the changed field, the issue closes with a comment;
- if the code moves, the issue's line numbers follow it;
- close an issue yourself to acknowledge it — it won't be recreated.

## What it needs, and what never leaves your CI

| Permission | Used for |
|---|---|
| `contents: read` | reading your code |
| `checks: write` | the check run and its annotations |
| `issues: write` | creating, updating, and closing its own issues |

Everything runs inside your GitHub Actions job. The list of fields your code uses is written to the runner's temporary directory, never to your repository. The Stripe specification is fetched from Stripe's public repository. arcdrip has no server, no account, and no telemetry. There is nothing to sign up for and nothing that can be breached on our side.

## See it work in two minutes

You don't have to wait for Stripe to change something. Replay a real change from history — Stripe's 2025 "basil" release removed `current_period_end` from subscriptions:

```yaml
      - uses: Gautam121212/arcdrip@v0.1.3   # or pin the commit SHA from the releases page
        with:
          seed_ref: 5a411d0d1e527229cdb4d6633197ab8009899ce6   # spec from Feb 2025, used as the baseline
```

If your code reads any field that changed since then, the first two runs will open the issues. Remove `seed_ref` afterwards.

Or break a field yourself: fork `stripe/openapi`, delete a field your code reads from `openapi/spec3.json`, and point arcdrip at your fork with `spec_repo: <you>/openapi`. Delete the field → issue opens. Stop reading the field in your code → issue closes.

## Options

| Input | Default | What it does |
|---|---|---|
| `seed_ref` | none | Use a historical spec commit as the first baseline (replay a known change) |
| `spec_repo` | `stripe/openapi` | Fetch the spec from another repository, e.g. your fork, to test a change you control |
| `include_tests` | `false` | Also scan test files |
| `budget_seconds` | `300` | Time limit for the scan |

## What it does not do (yet)

Be aware of these before relying on it:

- **Stripe only.** Other providers are planned; the first ones will be chosen by what early users ask for.
- **TypeScript and JavaScript only.**
- **Alerts start from install.** The first run is a baseline; changes before it are not reported unless you replay them with `seed_ref`.
- **Some code shapes are not followed:** results consumed through `.then()` chains, and Stripe clients stored on a class (`this.stripe`). Raw HTTP calls to `api.stripe.com` are recognised but not field-level.
- **Webhook event retirement is not detected.** Stripe's specification does not list event names; changes to an event's payload *are* detected.
- **An added enum value that breaks an exhaustive `switch` is not detected.**
- **If the Actions cache is evicted**, the next run quietly re-baselines. Scheduled runs every 6 hours keep it warm.
- **Every repository fetches the spec itself** (about 8 MB per run). A shared watcher is planned.

When arcdrip is unsure whether your code reads a field, it says so (`fieldsComplete: false` in its own records) rather than guessing, and it never alerts on that basis.

## Feedback

Open an issue in this repository with the alert you got and what you expected. A wrong alert, a missed one, or an unclear issue body are all bugs and all wanted.

## License

MIT. See `LICENSE`.
