/**
 * The manifest is the ONLY thing that ever leaves a customer's CI.
 *
 * Every object is a strictObject: unknown keys are rejected, not stripped.
 * If a future detector wants to add a field, it must be added here first,
 * reviewed, and documented on the security page. That is deliberate friction.
 *
 * Nothing in this file may ever hold: source text, string values from the
 * customer's code, environment variables, or secrets. Identifiers only.
 */
import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;

export const FieldRef = z.strictObject({
  /** Dotted path relative to the request body or response object, e.g. "invoice_settings.default_payment_method". Arrays are "items[].price". */
  path: z.string().max(200),
  /** "write" = sent in a request; "read" = accessed on a response or webhook payload */
  dir: z.enum(["read", "write"]),
});
export type FieldRef = z.infer<typeof FieldRef>;

export const Location = z.strictObject({
  file: z.string().max(500),
  line: z.number().int().positive(),
});
export type Location = z.infer<typeof Location>;

export const Tier = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type Tier = z.infer<typeof Tier>;

export const Entry = z.strictObject({
  /** Stable hash of (provider, kind, operation|event, sorted fields). Path-independent so it survives redaction. */
  id: z.string().length(16),
  kind: z.enum(["call", "webhook"]),
  /** For kind=call: "GET /v1/customers/{customer}" */
  operation: z.string().max(200).optional(),
  /** For kind=webhook: "invoice.payment_failed" */
  event: z.string().max(200).optional(),
  fields: z.array(FieldRef).max(500),
  tier: Tier,
  /**
   * false when the result flowed somewhere we stopped tracking (passed to a
   * function, returned, spread). The operation is still certain; the field
   * list is a lower bound. Field-level alerts must respect this.
   */
  fieldsComplete: z.boolean(),
  /** null when redact_paths is on (the default for uploads). */
  locs: z.array(Location).max(200).nullable(),
});
export type Entry = z.infer<typeof Entry>;

export const ProviderSection = z.strictObject({
  /** Provider API version the code is pinned to, or null if unpinned/unknown */
  pinned_version: z.string().max(50).nullable(),
  sdk: z
    .strictObject({
      package: z.string().max(100),
      version: z.string().max(50),
    })
    .nullable(),
  entries: z.array(Entry).max(5000),
});
export type ProviderSection = z.infer<typeof ProviderSection>;

export const Manifest = z.strictObject({
  schema: z.literal(SCHEMA_VERSION),
  /** Opaque hash of the repo identity; never the repo name or URL */
  repo_id: z.string().length(16),
  scanner_version: z.string().max(30),
  scanned_at: z.string().datetime(),
  /** true if any detector hit its time budget or crashed; field-level alerting must be suppressed for partial manifests */
  partial: z.boolean(),
  providers: z.record(z.string().max(50), ProviderSection),
  coverage: z.strictObject({
    t1: z.number().int().nonnegative(),
    t2: z.number().int().nonnegative(),
    t3: z.number().int().nonnegative(),
  }),
});
export type Manifest = z.infer<typeof Manifest>;

/** Validate and return a manifest, or throw. Called on every manifest before it is written or uploaded. */
export function assertManifest(candidate: unknown): Manifest {
  return Manifest.parse(candidate);
}

/**
 * Belt-and-braces outbound check: even after schema validation, refuse to
 * ship anything that looks like a secret or a blob of source. The schema
 * should make this impossible; this exists for the day the schema is wrong.
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk_(live|test)_[0-9a-zA-Z]{10,}/, // Stripe
  /AKIA[0-9A-Z]{16}/, // AWS
  /ghp_[0-9a-zA-Z]{30,}/, // GitHub
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/, // JWT
];
const MAX_STRING = 200;

export function assertSafeToUpload(manifest: Manifest): void {
  const json = JSON.stringify(manifest);
  for (const re of SECRET_PATTERNS) {
    if (re.test(json)) throw new Error(`refusing to upload: manifest matches secret pattern ${re}`);
  }
  const walk = (v: unknown): void => {
    if (typeof v === "string" && v.length > MAX_STRING) {
      throw new Error(`refusing to upload: string longer than ${MAX_STRING} chars`);
    }
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(manifest);
}

/** Strip locations. Applied before upload when redact_paths is on. */
export function redactLocations(manifest: Manifest): Manifest {
  return {
    ...manifest,
    providers: Object.fromEntries(
      Object.entries(manifest.providers).map(([name, p]) => [
        name,
        { ...p, entries: p.entries.map((e) => ({ ...e, locs: null })) },
      ]),
    ),
  };
}
