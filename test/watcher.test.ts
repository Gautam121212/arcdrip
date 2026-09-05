import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModel, eventToSchema, resolvePath } from "../src/watcher/openapi.js";
import { diffModels } from "../src/watcher/diff.js";
import { joinAlerts, applicability } from "../src/watcher/join.js";
import { SnapshotStore } from "../src/watcher/store.js";
import type { Manifest } from "../src/manifest/schema.js";

/** Minimal Stripe-shaped spec. Mutations of this drive the taxonomy tests. */
function spec(mutate: (s: any) => void = () => {}) {
  const s: any = {
    openapi: "3.0.0",
    info: { version: "2025-01-01.test" },
    paths: {
      "/v1/customers/{customer}": {
        get: { responses: { "200": { content: { "application/json": { schema: { anyOf: [{ $ref: "#/components/schemas/customer" }, { $ref: "#/components/schemas/deleted_customer" }] } } } } } },
        post: {
          requestBody: { content: { "application/x-www-form-urlencoded": { schema: { type: "object", properties: { name: { type: "string" }, address: { type: "object", properties: { city: { type: "string" } } } } } } } },
          responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/customer" } } } } },
        },
      },
      "/v1/subscriptions": {
        post: {
          requestBody: { content: { "application/x-www-form-urlencoded": { schema: { type: "object", required: ["customer"], properties: { customer: { type: "string" }, items: { type: "array", items: { type: "object", properties: { price: { type: "string" } } } }, metadata: { type: "object", additionalProperties: { type: "string" } } } } } } },
          responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/subscription" } } } } },
        },
        get: { responses: { "200": { content: { "application/json": { schema: { type: "object", required: ["data"], properties: { data: { type: "array", items: { $ref: "#/components/schemas/subscription" } }, has_more: { type: "boolean" } } } } } } } },
      },
      "/v1/coupons": { get: { responses: { "200": { content: { "application/json": { schema: { type: "object", properties: {} } } } } } } },
    },
    components: {
      schemas: {
        customer: { type: "object", required: ["id", "invoice_settings"], properties: { id: { type: "string" }, email: { type: "string", nullable: true }, invoice_settings: { type: "object", required: ["default_payment_method"], properties: { default_payment_method: { anyOf: [{ type: "string" }, { $ref: "#/components/schemas/payment_method" }], nullable: true } } } } },
        deleted_customer: { type: "object", required: ["id", "deleted"], properties: { id: { type: "string" }, deleted: { type: "boolean" } } },
        payment_method: { type: "object", required: ["id", "type"], properties: { id: { type: "string" }, type: { type: "string", enum: ["card", "us_bank_account"] } } },
        subscription: { type: "object", required: ["id", "status", "current_period_end", "items"], properties: { id: { type: "string" }, status: { type: "string", enum: ["active", "canceled", "past_due"] }, current_period_end: { type: "integer" }, items: { type: "object", required: ["data"], properties: { data: { type: "array", items: { $ref: "#/components/schemas/subscription_item" } } } } } },
        subscription_item: { type: "object", required: ["id", "price"], properties: { id: { type: "string" }, price: { $ref: "#/components/schemas/price" } } },
        price: { type: "object", required: ["id", "unit_amount"], properties: { id: { type: "string" }, unit_amount: { type: "integer", nullable: true } } },
      },
    },
  };
  mutate(s);
  return s;
}

function manifest(entries: any[], pinned: string | null = null): Manifest {
  return {
    schema: 1, repo_id: "0123456789abcdef", scanner_version: "0.1.0", scanned_at: "2026-01-01T00:00:00.000Z", partial: false,
    providers: { stripe: { pinned_version: pinned, sdk: null, entries } },
    coverage: { t1: entries.length, t2: 0, t3: 0 },
  };
}
const entry = (kind: "call" | "webhook", key: string, fields: Array<[string, "read" | "write"]>, tier: 1 | 2 | 3 = 1) => ({
  id: key.replace(/[^a-z0-9]/gi, "").padEnd(16, "0").slice(0, 16), kind, ...(kind === "call" ? { operation: key } : { event: key }),
  fields: fields.map(([path, dir]) => ({ path, dir })), tier, fieldsComplete: true, locs: [{ file: "src/a.ts", line: 1 }],
});

describe("openapi model", () => {
  it("records nested resources as mounts and walks them", () => {
    const m = buildModel(spec());
    expect(m.schemas.get("subscription")!.get("items.data[]")!.refs).toEqual(["subscription_item"]);
    const deps = resolvePath(m, { schema: "subscription" }, "items.data[].price.unit_amount");
    expect(deps).toEqual([
      { schema: "subscription", path: "items" },
      { schema: "subscription", path: "items.data" },
      { schema: "subscription", path: "items.data[]" },
      { schema: "subscription_item", path: "price" },
      { schema: "price", path: "unit_amount" },
    ]);
  });
  it("maps webhook events to their payload schema", () => {
    const m = buildModel(spec());
    expect(eventToSchema("customer.subscription.deleted", m)).toBe("subscription");
    expect(eventToSchema("customer.updated", m)).toBe("customer");
    expect(eventToSchema("nothing.here", m)).toBeNull();
  });
  it("marks free-form maps and does not descend into them", () => {
    const m = buildModel(spec());
    const req = m.operations.get("POST /v1/subscriptions")!.request;
    expect(req.get("metadata")!.freeform).toBe(true);
    expect(req.get("items[].price")).toBeDefined();
  });
});

describe("diff taxonomy (mutation tests)", () => {
  const base = buildModel(spec());
  const codes = (mut: (s: any) => void) => diffModels(base, buildModel(spec(mut))).filter((c) => c.breaking).map((c) => `${c.code}:${c.schema ?? c.operation}:${c.path ?? ""}`);

  it("additive changes are never breaking", () => {
    const changes = diffModels(base, buildModel(spec((s) => { s.components.schemas.customer.properties.phone = { type: "string" }; s.paths["/v1/refunds"] = { post: { responses: {} } }; })));
    expect(changes.some((c) => c.breaking)).toBe(false);
    expect(changes.map((c) => c.code)).toEqual(expect.arrayContaining(["ADDITIVE", "OPERATION_ADDED"]));
  });
  it("detects a removed response field", () => {
    expect(codes((s) => { delete s.components.schemas.subscription.properties.current_period_end; })).toContain("FIELD_REMOVED:subscription:current_period_end");
  });
  it("detects a removed operation", () => {
    expect(codes((s) => { delete s.paths["/v1/coupons"]; })).toContain("OPERATION_REMOVED:GET /v1/coupons:");
  });
  it("detects a type change but not a widening", () => {
    expect(codes((s) => { s.components.schemas.price.properties.unit_amount.type = "string"; })).toContain("FIELD_TYPE_CHANGED:price:unit_amount");
    expect(codes((s) => { s.components.schemas.customer.properties.email = { anyOf: [{ type: "string" }, { type: "object" }], nullable: true }; })).not.toContain("FIELD_TYPE_CHANGED:customer:email");
  });
  it("detects a field becoming nullable or optional", () => {
    expect(codes((s) => { s.components.schemas.subscription.properties.current_period_end.nullable = true; })).toContain("FIELD_NULLABLE_CHANGED:subscription:current_period_end");
    expect(codes((s) => { s.components.schemas.subscription.required = ["id", "status", "items"]; })).toContain("FIELD_NULLABLE_CHANGED:subscription:current_period_end");
  });
  it("detects a newly required request param and a removed request field", () => {
    expect(codes((s) => { s.paths["/v1/subscriptions"].post.requestBody.content["application/x-www-form-urlencoded"].schema.required.push("items"); })).toContain("REQUIRED_PARAM_ADDED:POST /v1/subscriptions:items");
    expect(codes((s) => { delete s.paths["/v1/customers/{customer}"].post.requestBody.content["application/x-www-form-urlencoded"].schema.properties.address; })).toContain("REQUEST_FIELD_REMOVED:POST /v1/customers/{}:address");
  });
  it("detects removed enum values; added ones are not breaking", () => {
    expect(codes((s) => { s.components.schemas.subscription.properties.status.enum = ["active", "canceled"]; })).toContain("ENUM_VALUE_REMOVED:subscription:status");
    expect(codes((s) => { s.components.schemas.subscription.properties.status.enum.push("paused"); })).toEqual([]);
  });
});

describe("join", () => {
  const from = buildModel(spec());
  const to = buildModel(spec((s) => {
    delete s.components.schemas.subscription.properties.current_period_end;
    delete s.components.schemas.price.properties.unit_amount;
    delete s.paths["/v1/coupons"];
    delete s.paths["/v1/customers/{customer}"].post.requestBody.content["application/x-www-form-urlencoded"].schema.properties.address;
  }));
  const changes = diffModels(from, to);

  it("alerts only on what the code reads", () => {
    const m = manifest([
      entry("call", "POST /v1/subscriptions", [["customer", "write"], ["id", "read"], ["status", "read"]]),
      entry("call", "GET /v1/customers/{}", [["id", "read"]]),
    ]);
    expect(joinAlerts(changes, m, from, to)).toEqual([]);
  });
  it("alerts on a removed field read through a list and two mounts", () => {
    const m = manifest([entry("call", "GET /v1/subscriptions", [["data[].items.data[].price.unit_amount", "read"]])]);
    const a = joinAlerts(changes, m, from, to);
    expect(a).toHaveLength(1);
    expect(a[0].code).toBe("FIELD_REMOVED");
    expect(a[0].affected_path).toBe("data[].items.data[].price.unit_amount");
    expect(a[0].evidence.change.schema).toBe("price");
  });
  it("alerts on a removed field read from a webhook payload", () => {
    const m = manifest([entry("webhook", "customer.subscription.updated", [["data.object.current_period_end", "read"], ["data.object.id", "read"]])]);
    const a = joinAlerts(changes, m, from, to);
    expect(a.map((x) => x.affected_path)).toEqual(["data.object.current_period_end"]);
  });
  it("alerts on a removed operation and a removed request field that is written", () => {
    const m = manifest([
      entry("call", "GET /v1/coupons", []),
      entry("call", "POST /v1/customers/{}", [["address.city", "write"], ["name", "write"]]),
    ]);
    expect(joinAlerts(changes, m, from, to).map((x) => `${x.code}:${x.affected_path ?? ""}`).sort()).toEqual(["OPERATION_REMOVED:", "REQUEST_FIELD_REMOVED:address.city"]);
  });
  it("never alerts on tier-3 entries", () => {
    const m = manifest([entry("call", "host:api.stripe.com", [], 3)]);
    expect(joinAlerts(changes, m, from, to)).toEqual([]);
  });
  it("downgrades to advisory when the code is pinned to an older version", () => {
    const m = manifest([entry("webhook", "customer.subscription.updated", [["data.object.current_period_end", "read"]])], "2024-06-20");
    const a = joinAlerts(changes, m, from, to);
    expect(a[0].severity).toBe("advisory");
    expect(a[0].severity_note).toMatch(/pinned to 2024-06-20/);
    expect(applicability(null, "2025-01-01.x").severity).toBe("breaking");
    expect(applicability("2025-06-01", "2025-01-01.x").severity).toBe("breaking");
  });
});

describe("snapshot store", () => {
  const raw = (ops: number, version = "2025-01-01.test") => {
    const paths: any = {};
    for (let i = 0; i < ops; i++) paths[`/v1/thing${i}`] = { get: {} };
    return JSON.stringify({ openapi: "3.0.0", info: { version }, paths, components: { schemas: {} } });
  };
  it("accepts a latest fetch only when seen twice; explicit refs are trusted", () => {
    const store = new SnapshotStore(mkdtempSync(join(tmpdir(), "arcdrip-")), "stripe");
    expect(store.ingest(raw(10)).status).toBe("pending");
    expect(store.ingest(raw(10)).status).toBe("accepted");
    expect(store.ingest(raw(10)).status).toBe("unchanged");
    expect(store.ingest(raw(11), { ref: "abc" }).status).toBe("accepted");
    expect(store.accepted()).toHaveLength(2);
  });
  it("quarantines snapshots outside the operation-count band and unparseable ones", () => {
    const store = new SnapshotStore(mkdtempSync(join(tmpdir(), "arcdrip-")), "stripe");
    store.ingest(raw(100), { ref: "a" });
    expect(store.ingest(raw(50), { ref: "b" }).status).toBe("quarantined");
    expect(store.ingest("{not json", { ref: "c" }).status).toBe("quarantined");
    expect(store.ingest(raw(0), { ref: "d" }).status).toBe("quarantined");
    expect(store.ingest(raw(115), { ref: "e" }).status).toBe("accepted");
    expect(store.state().quarantined).toHaveLength(2);
  });
  it("a different pending snapshot replaces the previous pending one", () => {
    const store = new SnapshotStore(mkdtempSync(join(tmpdir(), "arcdrip-")), "stripe");
    expect(store.ingest(raw(10, "v1")).status).toBe("pending");
    expect(store.ingest(raw(10, "v2")).status).toBe("pending");
    expect(store.ingest(raw(10, "v1")).status).toBe("pending");
    expect(store.ingest(raw(10, "v1")).status).toBe("accepted");
  });
});
