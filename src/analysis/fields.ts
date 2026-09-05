/**
 * Deterministic field extraction. No heuristics that guess; when tracking
 * becomes uncertain we stop and set complete=false rather than invent.
 */
import { Node, SyntaxKind, type CallExpression, type Identifier } from "ts-morph";
import type { FieldRef } from "../manifest/schema.js";

export interface FieldResult {
  fields: FieldRef[];
  complete: boolean;
}

/** True if the symbol behind this node is declared inside node_modules/<pkg>/ */
export function isDeclaredInPackage(node: Node, pkg: string): boolean {
  const sym = node.getSymbol();
  if (!sym) return false;
  const needle = `/node_modules/${pkg}/`;
  const inPkg = (s: import("ts-morph").Symbol) =>
    s.getDeclarations().some((d) => d.getSourceFile().getFilePath().includes(needle));
  // Imports are aliases: `import Stripe from "stripe"` declares a local alias whose
  // declaration is in the customer's file. Follow it to the real declaration.
  return inPkg(sym) || (sym.isAlias() && inPkg(sym.getAliasedSymbolOrThrow()));
}

/**
 * Request side: walk an object-literal argument and collect dotted key paths.
 * Arrays of objects become "items[].price". A spread means we can't see every
 * key, so complete=false.
 */
export function collectWriteFields(node: Node | undefined, prefix = ""): FieldResult {
  const out: FieldResult = { fields: [], complete: true };
  if (!node) return out;
  if (!Node.isObjectLiteralExpression(node)) {
    // Variable, function call, etc. — we don't chase it in Phase 1.
    out.complete = false;
    return out;
  }
  for (const prop of node.getProperties()) {
    if (Node.isSpreadAssignment(prop)) {
      out.complete = false;
      continue;
    }
    if (Node.isPropertyAssignment(prop) || Node.isShorthandPropertyAssignment(prop)) {
      const name = unquote(prop.getName());
      const path = prefix + name;
      const init = Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined;
      if (init && Node.isObjectLiteralExpression(init)) {
        const nested = collectWriteFields(init, path + ".");
        out.fields.push(...nested.fields);
        out.complete &&= nested.complete;
      } else if (init && Node.isArrayLiteralExpression(init)) {
        out.fields.push({ path, dir: "write" });
        for (const el of init.getElements()) {
          if (Node.isObjectLiteralExpression(el)) {
            const nested = collectWriteFields(el, path + "[].");
            out.fields.push(...nested.fields);
            out.complete &&= nested.complete;
          }
        }
      } else {
        out.fields.push({ path, dir: "write" });
      }
      continue;
    }
    // Methods, accessors, computed names: not something an API body would carry.
    out.complete = false;
  }
  return out;
}

/**
 * Response side: given the call expression, find where its result goes and
 * collect the property paths read from it.
 *
 * Handled:
 *   const c = await call();  c.a.b        -> "a.b"
 *   const { a, b: { c } } = await call()   -> "a", "b.c"
 *   (await call()).a                       -> "a"
 *   call().then(...)                       -> complete=false (Phase 2)
 *   return await call() / fn(await call()) -> complete=false
 */
export function collectReadFields(call: CallExpression): FieldResult {
  const out: FieldResult = { fields: [], complete: true };
  let node: Node = call;
  let parent = node.getParent();

  // Unwrap `await` and parentheses.
  while (parent && (Node.isAwaitExpression(parent) || Node.isParenthesizedExpression(parent))) {
    node = parent;
    parent = node.getParent();
  }
  if (!parent) return out;

  // (await call()).field
  if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === node) {
    out.fields.push({ path: climbPath(parent, parent.getName()), dir: "read" });
    return out;
  }

  if (Node.isVariableDeclaration(parent)) {
    const nameNode = parent.getNameNode();
    if (Node.isIdentifier(nameNode)) {
      const r = readsFromIdentifier(nameNode);
      out.fields.push(...r.fields);
      out.complete = r.complete;
      return out;
    }
    if (Node.isObjectBindingPattern(nameNode)) {
      const r = readsFromBinding(nameNode, "");
      out.fields.push(...r.fields);
      out.complete = r.complete;
      return out;
    }
  }

  // Anything else: returned, passed as an argument, .then chain, assigned to a
  // pre-declared variable. The operation is certain; the field list is not.
  out.complete = false;
  return out;
}

/** Follow every reference to a local identifier and collect property paths read from it. */
function readsFromIdentifier(decl: Identifier): FieldResult {
  const out: FieldResult = { fields: [], complete: true };
  for (const ref of decl.findReferencesAsNodes()) {
    if (ref === decl) continue;
    const parent = ref.getParent();
    if (parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === ref) {
      out.fields.push({ path: climbPath(parent, parent.getName()), dir: "read" });
      continue;
    }
    if (parent && Node.isVariableDeclaration(parent) && Node.isObjectBindingPattern(parent.getNameNode())) {
      const r = readsFromBinding(parent.getNameNode() as any, "");
      out.fields.push(...r.fields);
      out.complete &&= r.complete;
      continue;
    }
    // Bare use: passed along, returned, spread, compared. Stop tracking.
    out.complete = false;
  }
  return out;
}

/** const { a, b: { c }, d: renamed } = x  ->  a, b.c, d */
function readsFromBinding(pattern: Node, prefix: string): FieldResult {
  const out: FieldResult = { fields: [], complete: true };
  if (!Node.isObjectBindingPattern(pattern)) return { fields: [], complete: false };
  for (const el of pattern.getElements()) {
    if (el.getDotDotDotToken()) {
      out.complete = false; // rest element: unknown keys
      continue;
    }
    const propName = el.getPropertyNameNode()?.getText() ?? el.getNameNode().getText();
    const path = prefix + unquote(propName);
    const nameNode = el.getNameNode();
    if (Node.isObjectBindingPattern(nameNode)) {
      const nested = readsFromBinding(nameNode, path + ".");
      out.fields.push(...nested.fields);
      out.complete &&= nested.complete;
    } else {
      out.fields.push({ path, dir: "read" });
      // If the destructured value is itself an object that gets read further
      // (const { data } = x; data.foo), follow it.
      if (Node.isIdentifier(nameNode)) {
        const deeper = readsFromIdentifier(nameNode);
        for (const f of deeper.fields) out.fields.push({ path: path + "." + f.path, dir: "read" });
        // Bare uses of a destructured leaf are fine; that's just using the value.
      }
    }
  }
  return out;
}

/** From a PropertyAccessExpression, keep climbing while the parent is also a property access on us. */
export function climbPath(node: Node, first: string): string {
  const parts = [first];
  let current: Node = node;
  let parent = current.getParent();
  while (parent) {
    if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === current) {
      parts.push(parent.getName());
      current = parent;
      parent = current.getParent();
      continue;
    }
    if (Node.isElementAccessExpression(parent) && parent.getExpression() === current) {
      // data[0].total -> "data[].total". We never record the index value.
      parts[parts.length - 1] += "[]";
      current = parent;
      parent = current.getParent();
      continue;
    }
    if (Node.isNonNullExpression(parent) || Node.isParenthesizedExpression(parent)) {
      current = parent;
      parent = current.getParent();
      continue;
    }
    break;
  }
  return parts.join(".");
}

/** Given `a.b.c.d`, return ["a","b","c","d"] and the root node, or null if not a pure identifier chain. */
export function propertyChain(node: Node): { root: Identifier; names: string[] } | null {
  const names: string[] = [];
  let current: Node = node;
  while (Node.isPropertyAccessExpression(current)) {
    names.unshift(current.getName());
    current = current.getExpression();
    while (Node.isNonNullExpression(current) || Node.isParenthesizedExpression(current)) {
      current = current.getExpression();
    }
  }
  if (!Node.isIdentifier(current)) return null;
  return { root: current, names };
}

export function unquote(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, "");
}

export function dedupeFields(fields: FieldRef[]): FieldRef[] {
  const seen = new Set<string>();
  const out: FieldRef[] = [];
  for (const f of fields) {
    const k = f.dir + ":" + f.path;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out.sort((a, b) => (a.dir + a.path).localeCompare(b.dir + b.path));
}

export { SyntaxKind };
