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

Operations not yet in the hand-written table appear as `sdk:<method.path>` with fields intact.

## Invariants (enforced by tests)
- The manifest schema is a strict allowlist; unknown keys are rejected.
- Nothing that looks like a secret or a source blob can be uploaded.
- A Tier-3 entry never carries field-level data.
- `fieldsComplete: false` whenever a result flows somewhere we stopped tracking.
- Any change to golden output is a reviewed diff (`UPDATE_GOLDEN=1 npm test` to accept).
