import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { deriveOperations, canonicalPath, BUNDLED_OPERATIONS, BUNDLED_FROM } from "../src/detectors/stripe-sdk-table.js";

describe("stripe operation table", () => {
  it("derives hundreds of operations from the installed SDK", () => {
    const t = deriveOperations(join(__dirname, "..", "node_modules", "stripe"));
    expect(t).not.toBeNull();
    expect(t!.size).toBeGreaterThan(400);
    expect(t!.get("customers.retrieve")).toBe("GET /v1/customers/{}");
    expect(t!.get("checkout.sessions.create")).toBe("POST /v1/checkout/sessions");
    expect(t!.get("billingPortal.sessions.create")).toBe("POST /v1/billing_portal/sessions");
    expect(t!.get("subscriptions.cancel")).toBe("DELETE /v1/subscriptions/{}");
  });

  it("lists every alternative for a branching method", () => {
    const t = deriveOperations(join(__dirname, "..", "node_modules", "stripe"))!;
    expect(t.get("accounts.retrieve")).toBe("GET /v1/accounts/{} | GET /v1/account");
  });

  it("ships a bundled table that matches the installed SDK it was generated from", () => {
    expect(BUNDLED_FROM).toMatch(/^stripe@\d+\./);
    expect(BUNDLED_OPERATIONS.size).toBeGreaterThan(400);
    expect(BUNDLED_OPERATIONS.get("webhookEndpoints.del")).toBe("DELETE /v1/webhook_endpoints/{}");
  });

  it("canonicalises path placeholders regardless of SDK naming", () => {
    expect(canonicalPath("/v1/customers/${encodeURIComponent(id)}/sources/${encodeURIComponent(sourceId)}")).toBe("/v1/customers/{}/sources/{}");
    expect(canonicalPath("/v1/customers/{customer}")).toBe("/v1/customers/{}");
    expect(canonicalPath("/v1/customers")).toBe("/v1/customers");
  });

  it("returns null for a directory that is not an SDK", () => {
    expect(deriveOperations("/tmp")).toBeNull();
  });
});
