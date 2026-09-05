# arcdrip — scanner

Maps a repository's third-party API dependencies (which provider, which operation,
which request/response fields, which pinned version, which webhook events) into a
strict, identifier-only manifest. Read-only. No LLM in the scanner.

```
npm install
npm test                         # golden + invariant tests
npm run scan -- test/fixtures/stripe-basic
npm run scan -- ../some-repo -o manifest.local.json
npm run scan -- ../some-repo --redact-paths   # what the upload path sends
```

Design: see `docs/phase1-design.md`. Status: Week 1 — Stripe SDK Tier-1 detection.

## Invariants (enforced by tests)
- The manifest schema is a strict allowlist; unknown keys are rejected.
- Nothing that looks like a secret or a source blob can be uploaded.
- A Tier-3 entry never carries field-level data.
- `fieldsComplete: false` whenever a result flows somewhere we stopped tracking.
- Any change to golden output is a reviewed diff (`UPDATE_GOLDEN=1 npm test` to accept).
