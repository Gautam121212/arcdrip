import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scan } from "../src/scan.js";
import { assertManifest, assertSafeToUpload, redactLocations, Manifest } from "../src/manifest/schema.js";

const FIXTURES = join(__dirname, "fixtures");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

/** Strip the fields that legitimately change between runs. */
function normalise(m: Manifest) {
  return { ...m, scanned_at: "<time>", repo_id: "<repo>" };
}

describe.each(["stripe-basic", "route-handler-patterns"])("golden: %s", (name) => {
  const dir = join(FIXTURES, name);
  const expectedPath = join(dir, "expected.manifest.json");

  it("produces exactly the expected manifest", () => {
    const actual = normalise(scan({ rootDir: dir }));
    if (UPDATE || !existsSync(expectedPath)) {
      writeFileSync(expectedPath, JSON.stringify(actual, null, 2) + "\n");
    }
    const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
    // Any diff here is a behaviour change and must be reviewed by a human.
    expect(actual).toEqual(expected);
  });

  it("validates against the strict schema and is safe to upload after redaction", () => {
    const m = scan({ rootDir: dir });
    expect(() => assertManifest(m)).not.toThrow();
    const redacted = redactLocations(m);
    expect(() => assertSafeToUpload(redacted)).not.toThrow();
    for (const p of Object.values(redacted.providers)) for (const e of p.entries) expect(e.locs).toBeNull();
  });

  it("never emits a T3 entry with field-level data (invariant)", () => {
    const m = scan({ rootDir: dir });
    for (const p of Object.values(m.providers)) {
      for (const e of p.entries) if (e.tier === 3) expect(e.fields).toHaveLength(0);
    }
  });
});

describe("schema is an allowlist", () => {
  it("rejects unknown keys anywhere in the manifest", () => {
    const m = scan({ rootDir: join(FIXTURES, "stripe-basic") });
    const poisoned = JSON.parse(JSON.stringify(m));
    poisoned.providers.stripe.entries[0].sourceSnippet = "const x = 1";
    expect(() => assertManifest(poisoned)).toThrow();
  });

  it("refuses to upload anything that looks like a secret", () => {
    const m = scan({ rootDir: join(FIXTURES, "stripe-basic") });
    const leaky = JSON.parse(JSON.stringify(m)) as Manifest;
    leaky.providers.stripe.entries[0].fields.push({ path: "sk_live_" + "a".repeat(24), dir: "read" });
    expect(() => assertSafeToUpload(leaky)).toThrow(/secret/);
  });
});
