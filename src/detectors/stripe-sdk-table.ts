/**
 * stripe-node generates one file per resource from Stripe's OpenAPI spec, and
 * every method in it names its HTTP verb and path. That file is the truth for
 * whatever SDK version the customer has installed, so we read it instead of
 * maintaining a table by hand.
 *
 * Two generator formats are supported:
 *   v20+   retrieve(id, params, options) { return this._makeRequest('GET', `/v1/customers/${encodeURIComponent(id)}`, ...
 *   v8–19  retrieve: stripeMethod({ method: 'GET', fullPath: '/v1/customers/{customer}' }),
 *
 * Path placeholders are canonicalised to `{}` so the same operation has the
 * same key regardless of SDK version or argument naming.
 *
 * The client property path mirrors the file path: resources/Checkout/Sessions.js
 * is `stripe.checkout.sessions`; resources/Customers.js is `stripe.customers`.
 * We only read the SDK's own source text; nothing is executed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import bundled from "./stripe-operations.bundled.json" with { type: "json" };

export type OperationTable = ReadonlyMap<string, string>;

/** A class method header at class-body indentation: `    retrieve(id, params, options) {` */
const V20_METHOD_HEADER = /^ {4}(\w+)\s*\([^)]*\)\s*\{/gm;
const MAKE_REQUEST = /this\._makeRequest\(\s*'([A-Z]+)'\s*,\s*(`[^`]*`|'[^']*')/g;
const LEGACY_METHOD = /(\w+)\s*:\s*stripeMethod\(\s*\{\s*method\s*:\s*'([A-Z]+)'\s*,\s*fullPath\s*:\s*'([^']*)'/g;

const cache = new Map<string, OperationTable | null>();

/** Table derived from the SDK at `sdkRoot` (…/node_modules/stripe). null if the layout isn't recognised. */
export function operationsFromSdk(sdkRoot: string): OperationTable | null {
  if (cache.has(sdkRoot)) return cache.get(sdkRoot)!;
  const table = deriveOperations(sdkRoot);
  cache.set(sdkRoot, table);
  return table;
}

/** Table shipped with the scanner, derived at build time from a known SDK version. Used when no SDK is installed (Deno imports). */
export const BUNDLED_OPERATIONS: OperationTable = new Map(Object.entries(bundled.operations as Record<string, string>));
export const BUNDLED_FROM: string = bundled.generatedFrom;

export function deriveOperations(sdkRoot: string): Map<string, string> | null {
  const resourcesDir = ["cjs/resources", "lib/resources", "esm/resources"]
    .map((d) => join(sdkRoot, d))
    .find((d) => existsSync(d));
  if (!resourcesDir) return null;

  const table = new Map<string, string>();
  for (const file of walk(resourcesDir)) {
    if (!file.endsWith(".js")) continue;
    const rel = relative(resourcesDir, file).slice(0, -".js".length);
    const chain = rel.split(sep).map(camel).join(".");
    const text = readFileSync(file, "utf8");
    for (const [name, verb, path] of matchMethods(text)) {
      const key = `${chain}.${name}`;
      const op = `${verb} ${canonicalPath(path)}`;
      const prev = table.get(key);
      // Branching methods list every alternative, joined by " | ", in source order.
      table.set(key, prev && prev !== op ? `${prev} | ${op}` : op);
    }
  }
  return table.size > 0 ? table : null;
}

function* matchMethods(text: string): Generator<[string, string, string]> {
  // v20+: scope each method body by brace matching and collect every request inside it.
  // A method that branches (accounts.retrieve: own account vs by id) yields each alternative.
  for (const header of text.matchAll(V20_METHOD_HEADER)) {
    const start = header.index! + header[0].length;
    const body = text.slice(start, closingBrace(text, start));
    const seen = new Set<string>();
    for (const req of body.matchAll(MAKE_REQUEST)) {
      const key = `${req[1]} ${req[2].slice(1, -1)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      yield [header[1], req[1], req[2].slice(1, -1)];
    }
  }
  for (const m of text.matchAll(LEGACY_METHOD)) yield [m[1], m[2], m[3]];
}

/** Index of the brace that closes the block opened just before `from`. */
function closingBrace(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return text.length;
}

/** `/v1/customers/${encodeURIComponent(id)}/sources/{source}` -> `/v1/customers/{}/sources/{}` */
export function canonicalPath(path: string): string {
  return path.replace(/\$\{[^}]*\}/g, "{}").replace(/\{[^}]*\}/g, "{}");
}

function camel(segment: string): string {
  return segment.charAt(0).toLowerCase() + segment.slice(1);
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}
