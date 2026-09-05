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
       const stripe = new Stripe(process.env.KEY!, { apiVersion: "2025-02-24.acacia" });
       export async function f(id: string) { const s = await stripe.subscriptions.retrieve(id); return s.current_period_end; }`,
    );
    const m = scan({ rootDir: dir });
    const st = m.providers.stripe!;
    expect(st.pinned_version).toBe("2025-02-24.acacia");
    expect(st.sdk).toEqual({ package: "stripe", version: "^18.0.0" });
    expect(st.entries).toHaveLength(1);
    expect(st.entries[0].tier).toBe(2);
    expect(st.entries[0].operation).toBe("GET /v1/subscriptions/{}");
    expect(st.entries[0].fields).toEqual([{ path: "current_period_end", dir: "read" }]);
  });
});
