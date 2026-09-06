/**
 * Stripe detector (Tier 1 only in this version).
 *
 * A call is Tier 1 when the method the code invokes is *declared by the
 * stripe package itself* — we ask the type checker, we do not pattern-match
 * on the variable being named "stripe". A client named `billing` or a
 * client passed in as a parameter both resolve correctly.
 */
import { Node, SyntaxKind, type Project, type SourceFile, type CallExpression } from "ts-morph";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Entry, FieldRef, Location } from "../manifest/schema.js";
import type { DetectorResult } from "../scan.js";
import { operationsFromSdk, BUNDLED_OPERATIONS, type OperationTable } from "./stripe-sdk-table.js";
import {
  collectReadFields,
  collectWriteFields,
  dedupeFields,
  isDeclaredInPackage,
  propertyChain,
  climbPath,
  unwrapExpression,
  isNonExposingUse,
} from "../analysis/fields.js";

export const PROVIDER = "stripe";
const PKG = "stripe";

const WEBHOOK_VERIFY = new Set(["webhooks.constructEvent", "webhooks.constructEventAsync"]);

/**
 * Import specifiers that name the Stripe SDK explicitly. Used when the type
 * checker cannot resolve the package: Deno/edge specifiers, or a plain
 * `import Stripe from "stripe"` in a repo scanned without node_modules
 * (e.g. the Action running before the customer's install step).
 */
const SDK_SPECIFIER = /^(stripe|npm:stripe(@[^/]*)?|https:\/\/esm\.sh\/stripe(@[^/]*)?(\/.*)?|https:\/\/cdn\.skypack\.dev\/stripe(@[^/]*)?)$/;

/** Raw HTTP: any string literal that names the API host. Tier 3 — provider known, operation not. */
const API_HOST = "api.stripe.com";

export function detectStripe(project: Project, rootDir: string): DetectorResult {
  const entries = new Map<string, Entry>();
  let pinned: string | null = null;
  let degraded = false;

  // Operation table: the customer's installed SDK is the truth for their version;
  // the bundled table covers SDKs we can't see (Deno imports); `sdk:` is the honest fallback.
  const sdk = findSdk(rootDir);
  const installed = sdk ? operationsFromSdk(sdk.root) : null;
  const resolveOperation = (method: string): string =>
    installed?.get(method) ?? BUNDLED_OPERATIONS.get(method) ?? `sdk:${method}`;

  for (const sf of project.getSourceFiles()) {
    if (sf.getFilePath().includes("/node_modules/")) continue;
    try {
      pinned ??= findApiVersionPin(sf);
      scanFile(sf, rootDir, entries, resolveOperation);
    } catch (err) {
      // One file must never take the provider down. Report, mark degraded, continue.
      degraded = true;
      console.error(`[arcdrip] stripe: skipped ${sf.getFilePath().slice(rootDir.length + 1)}: ${(err as Error).message}`);
      if (process.env.ARCDRIP_DEBUG) console.error((err as Error).stack);
    }
  }

  return {
    section: {
      pinned_version: pinned,
      sdk: sdk ? { package: PKG, version: sdk.version } : declaredSdkVersion(rootDir),
      entries: [...entries.values()].sort((a, b) => a.id.localeCompare(b.id)),
    },
    degraded,
  };
}

function scanFile(sf: SourceFile, rootDir: string, entries: Map<string, Entry>, resolveOperation: (m: string) => string): void {
  {
    // Tier 3: the host named in a string literal (raw HTTP with a dynamic path, a base URL constant).
    for (const lit of sf.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
      if (!lit.getLiteralValue().includes(API_HOST)) continue;
      mergeEntry(entries, makeEntry("call", `host:${API_HOST}`, [], 3, false, loc(lit, rootDir)));
    }
    for (const tpl of sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral)) {
      if (!tpl.getLiteralValue().includes(API_HOST)) continue;
      mergeEntry(entries, makeEntry("call", `host:${API_HOST}`, [], 3, false, loc(tpl, rootDir)));
    }
    for (const head of sf.getDescendantsOfKind(SyntaxKind.TemplateHead)) {
      if (!head.getLiteralText().includes(API_HOST)) continue;
      mergeEntry(entries, makeEntry("call", `host:${API_HOST}`, [], 3, false, loc(head, rootDir)));
    }

    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) continue;
      const chain = propertyChain(callee);
      if (!chain) continue;

      // Tier 1: the method is declared by the stripe package (type checker says so).
      // Tier 2: the client was constructed from an explicit SDK import we can't resolve (npm:stripe on Deno).
      let tier: 1 | 2;
      if (isDeclaredInPackage(callee.getNameNode(), PKG)) tier = 1;
      else if (isClientFromSdkImport(chain.root)) tier = 2;
      else continue;

      const method = chain.names.join("."); // e.g. "checkout.sessions.create"

      if (WEBHOOK_VERIFY.has(method)) {
        for (const e of detectWebhookHandlers(call, rootDir)) mergeEntry(entries, { ...e, tier });
        continue;
      }

      const write = collectWriteFields(firstParamsArg(call));
      const read = collectReadFields(call);
      const operation = resolveOperation(method);
      mergeEntry(
        entries,
        makeEntry("call", operation, [...write.fields, ...read.fields], tier, write.complete && read.complete, loc(call, rootDir)),
      );
    }
  }
}

/**
 * `const stripe = new Stripe(key)` where `Stripe` was imported from "npm:stripe" or
 * an esm.sh URL. The type checker can't resolve those, so we trust the import text.
 */
function isClientFromSdkImport(root: Node): boolean {
  try {
    // `import { stripe } from "./config"` — the local symbol is an alias; follow it to
    // the real declaration in the other file.
    let sym = root.getSymbol();
    if (sym?.isAlias()) sym = sym.getAliasedSymbol() ?? sym;
    const decl = sym?.getDeclarations().find((d) => Node.isVariableDeclaration(d));
    if (!decl || !Node.isVariableDeclaration(decl)) return false;
    const init = decl.getInitializer();
    if (!init) return false;
    const inner = unwrapExpression(Node.isAwaitExpression(init) ? init.getExpression() : init);
    if (!Node.isNewExpression(inner)) return false;
    return isSdkImportedCtor(inner.getExpression());
  } catch {
    return false;
  }
}

/** `Stripe` in `new Stripe(...)` was imported from a specifier that names the SDK. */
function isSdkImportedCtor(ctor: Node): boolean {
  try {
    const ctorDecl = ctor.getSymbol()?.getDeclarations()[0];
    const importDecl = ctorDecl?.getFirstAncestor((a) => Node.isImportDeclaration(a));
    if (!importDecl || !Node.isImportDeclaration(importDecl)) return false;
    return SDK_SPECIFIER.test(importDecl.getModuleSpecifierValue());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

/** new Stripe(key, { apiVersion: "2024-06-20" }) */
function findApiVersionPin(sf: SourceFile): string | null {
  for (const n of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    if (!isDeclaredInPackage(n.getExpression(), PKG) && !isSdkImportedCtor(n.getExpression())) continue;
    const opts = n.getArguments()[1];
    if (!opts || !Node.isObjectLiteralExpression(opts)) continue;
    const prop = opts.getProperty("apiVersion");
    if (!prop || !Node.isPropertyAssignment(prop)) continue;
    const init = prop.getInitializer();
    if (init && Node.isStringLiteral(init)) return init.getLiteralValue();
  }
  return null;
}

/**
 * The request body is the first object-typed argument (Stripe's convention:
 * `create(params)`, `retrieve(id, params)`). We ask the type checker rather
 * than guessing by position, so `retrieve(customerId)` (a string) is not
 * mistaken for params and `create(customerData)` (a variable) is followed.
 */
function firstParamsArg(call: CallExpression): Node | undefined {
  for (const arg of call.getArguments()) {
    const inner = unwrapExpression(arg);
    if (Node.isObjectLiteralExpression(inner)) return inner;
    try {
      const t = inner.getType();
      if (t.isObject() && !t.isArray() && t.getCallSignatures().length === 0) return inner;
    } catch {
      // Untypeable argument: not something we can claim is the params object.
    }
  }
  return undefined;
}

/**
 * From `const event = stripe.webhooks.constructEvent(...)`, find
 * `switch (event.type) { case "x": ... }` and, per case, the paths read from
 * `event.data.object` (directly or via `const obj = event.data.object`).
 */
function detectWebhookHandlers(verifyCall: CallExpression, rootDir: string): Entry[] {
  const out: Entry[] = [];
  let binding: Node | undefined = verifyCall.getParent();
  while (binding && (Node.isAwaitExpression(binding) || Node.isParenthesizedExpression(binding) || Node.isAsExpression(binding))) {
    binding = binding.getParent();
  }
  if (!binding) return out;

  // const event = constructEvent(...)   OR   let event; ... event = constructEvent(...)
  let eventVar: string | undefined;
  if (Node.isVariableDeclaration(binding) && Node.isIdentifier(binding.getNameNode())) {
    eventVar = binding.getNameNode().getText();
  } else if (Node.isBinaryExpression(binding) && binding.getOperatorToken().getText() === "=" && Node.isIdentifier(binding.getLeft())) {
    eventVar = binding.getLeft().getText();
  }
  if (!eventVar) return out;

  const fn = binding.getFirstAncestor((a) => Node.isFunctionLikeDeclaration(a) || Node.isSourceFile(a));
  if (!fn) return out;

  const switches = fn
    .getDescendantsOfKind(SyntaxKind.SwitchStatement)
    .filter((s) => s.getExpression().getText() === `${eventVar}.type`);

  for (const sw of switches) {
    const clauses = sw.getClauses();
    for (let i = 0; i < clauses.length; i++) {
      const clause = clauses[i];
      if (!Node.isCaseClause(clause)) continue;
      const expr = clause.getExpression();
      if (!Node.isStringLiteral(expr)) continue;
      const eventName = expr.getLiteralValue();

      // Fall-through: `case "a": case "b": <body>` — an empty clause shares the next non-empty body.
      let body: Node = clause;
      for (let j = i; j < clauses.length && body.getChildSyntaxList()?.getChildCount() === 0; j++) body = clauses[j];
      if (body.getChildSyntaxList()?.getChildCount() === 0) body = clause;

      // Aliases for event.data.object inside this body (`const sub = event.data.object as Stripe.Subscription`).
      const aliases = new Set<string>();
      for (const vd of body.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        const init = vd.getInitializer();
        if (init && unwrapExpression(init).getText() === `${eventVar}.data.object` && Node.isIdentifier(vd.getNameNode())) {
          aliases.add(vd.getNameNode().getText());
        }
      }

      const fields: FieldRef[] = [];
      for (const pa of body.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        const chain = propertyChain(pa);
        if (!chain) continue;
        const root = chain.root.getText();
        // Only consider the outermost access of a chain (avoid a.b, a.b.c both matching).
        const parent = pa.getParent();
        if (parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === pa) continue;

        if (root === eventVar && chain.names[0] === "data" && chain.names[1] === "object" && chain.names.length > 2) {
          fields.push({ path: "data.object." + chain.names.slice(2).join("."), dir: "read" });
        } else if (aliases.has(root) && chain.names.length > 0) {
          fields.push({ path: "data.object." + chain.names.join("."), dir: "read" });
        }
      }
      // Field list is a lower bound: the object may be passed elsewhere. Say so.
      const complete = !clauseLeaksObject(body, eventVar, aliases);
      out.push(makeEntry("webhook", eventName, fields, 1, complete, loc(clause, rootDir)));
    }
  }
  return out;
}

/** True if event.data.object (or an alias) is used bare — passed to a function, returned, etc. */
function clauseLeaksObject(clause: Node, eventVar: string, aliases: Set<string>): boolean {
  for (const id of clause.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (!aliases.has(id.getText())) continue;
    let carrier: Node = id;
    let parent: Node | undefined = id.getParent();
    while (parent && (Node.isAsExpression(parent) || Node.isParenthesizedExpression(parent) || Node.isNonNullExpression(parent))) {
      carrier = parent;
      parent = carrier.getParent();
    }
    if (parent && Node.isVariableDeclaration(parent) && parent.getNameNode() === id) continue;
    if (parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === carrier) continue;
    if (parent && isNonExposingUse(carrier, parent)) continue;
    return true;
  }
  for (const pa of clause.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (pa.getText() !== `${eventVar}.data.object`) continue;
    let carrier: Node = pa;
    let parent: Node | undefined = pa.getParent();
    while (parent && (Node.isAsExpression(parent) || Node.isParenthesizedExpression(parent) || Node.isNonNullExpression(parent))) {
      carrier = parent;
      parent = carrier.getParent();
    }
    const isRead = parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === carrier;
    const isAliasInit = parent && Node.isVariableDeclaration(parent);
    if (!isRead && !isAliasInit) return true;
  }
  return false;
}

/** Locate the installed SDK by walking up like Node resolution does. We read its package.json and resource files, never execute it. */
function findSdk(rootDir: string): { root: string; version: string } | null {
  let dir = rootDir;
  for (let i = 0; i < 20; i++) {
    const root = join(dir, "node_modules", PKG);
    if (existsSync(join(root, "package.json"))) {
      try {
        return { root, version: String(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version) };
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** No SDK on disk: report what package.json declares, if anything. */
function declaredSdkVersion(rootDir: string): { package: string; version: string } | null {
  try {
    const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
    const spec = pkg.dependencies?.[PKG] ?? pkg.devDependencies?.[PKG];
    return spec ? { package: PKG, version: String(spec) } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

function loc(node: Node, rootDir: string): Location {
  const file = node.getSourceFile().getFilePath();
  return { file: file.startsWith(rootDir) ? file.slice(rootDir.length + 1) : file, line: node.getStartLineNumber() };
}

function makeEntry(
  kind: Entry["kind"],
  key: string,
  fields: FieldRef[],
  tier: Entry["tier"],
  complete: boolean,
  location: Location,
): Entry {
  const deduped = dedupeFields(fields);
  const id = createHash("sha256")
    .update([PROVIDER, kind, key, ...deduped.map((f) => f.dir + ":" + f.path)].join("|"))
    .digest("hex")
    .slice(0, 16);
  return {
    id,
    kind,
    ...(kind === "call" ? { operation: key } : { event: key }),
    fields: deduped,
    tier,
    fieldsComplete: complete,
    locs: [location],
  };
}

/** Same id in two places = same usage; keep one entry with both locations. */
function mergeEntry(map: Map<string, Entry>, e: Entry): void {
  const existing = map.get(e.id);
  if (!existing) {
    map.set(e.id, e);
    return;
  }
  existing.locs = [...(existing.locs ?? []), ...(e.locs ?? [])];
  existing.fieldsComplete &&= e.fieldsComplete;
}

export { climbPath };
export type { OperationTable };
