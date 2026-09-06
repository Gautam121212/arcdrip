import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "../src/scan.js";

describe("scanning a repo whose dependencies are not installed", () => {
  it("still finds SDK calls at tier 2 with real operations from the bundled table", () => {
    // Outside this repo tree on purpose: no node_modules/stripe anywhere above it.
    const dir = mkdtempSync(join(tmpdir(), "arcdrip-nomods-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", dependencies: { stripe: "^18.0.0" } }));
    writeFileSync(
      join(dir, "src", "billing.ts"),
      `import Stripe from "stripe";
       export const stripe = new Stripe(process.env.KEY!, { apiVersion: "2025-02-24.acacia" });
       export async function f(id: string) { const s = await stripe.subscriptions.retrieve(id); return s.current_period_end; }`,
    );
    // The common real-world shape: one module creates the client, others import it (through a path alias).
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }));
    writeFileSync(join(dir, "src", "webhook.ts"),
      `import { stripe } from "@/src/billing";
       export function h(body: string, sig: string) {
         const event = stripe.webhooks.constructEvent(body, sig, "whsec");
         switch (event.type) { case "customer.subscription.updated": return event.data.object.status; }
       }`);
    const m = scan({ rootDir: dir });
    const st = m.providers.stripe!;
    expect(st.pinned_version).toBe("2025-02-24.acacia");
    expect(st.sdk).toEqual({ package: "stripe", version: "^18.0.0" });
    expect(st.entries).toHaveLength(2);
    const call = st.entries.find((e) => e.kind === "call")!;
    const hook = st.entries.find((e) => e.kind === "webhook")!;
    expect(call.tier).toBe(2);
    expect(call.operation).toBe("GET /v1/subscriptions/{}");
    expect(call.fields).toEqual([{ path: "current_period_end", dir: "read" }]);
    expect(hook.tier).toBe(2);
    expect(hook.event).toBe("customer.subscription.updated");
    expect(hook.fields).toEqual([{ path: "data.object.status", dir: "read" }]);
  });
});
