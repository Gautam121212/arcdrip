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
  // The checker can throw on unusual code (it did, on a .js file). An unresolvable
  // symbol is "not ours", never a crash.
  try {
    const sym = node.getSymbol();
    if (!sym) return false;
    const needle = `/node_modules/${pkg}/`;
    const inPkg = (s: import("ts-morph").Symbol) =>
      s.getDeclarations().some((d) => d.getSourceFile().getFilePath().includes(needle));
    // Imports are aliases: `import Stripe from "stripe"` declares a local alias whose
    // declaration is in the customer's file. Follow it to the real declaration.
    return inPkg(sym) || (sym.isAlias() && inPkg(sym.getAliasedSymbolOrThrow()));
  } catch {
    return false;
  }
}

/** findReferencesAsNodes can throw inside the checker; treat that as "can't track". */
export function safeReferences(id: Identifier): Node[] | null {
  try {
    return id.findReferencesAsNodes();
  } catch {
    return null;
  }
}

/**
 * Request side: walk an object-literal argument and collect dotted key paths.
 * Arrays of objects become "items[].price". A spread means we can't see every
 * key, so complete=false.
 */
export function collectWriteFields(node: Node | undefined, prefix = ""): FieldResult {
  const out: FieldResult = { fields: [], complete: true };
  if (!node) return out;
  node = unwrapExpression(node);
  if (Node.isIdentifier(node) && prefix === "") {
    // const params = { ... }; call(params)  — follow the local declaration.
    return collectWriteFieldsFromVariable(node);
  }
  if (!Node.isObjectLiteralExpression(node)) {
    // Function call, member access, etc. — we don't chase it in Phase 1.
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
 * Follow an identifier argument to its declaration. Collect keys from the
 * initializer and from every later `x = {...}` reassignment. If the variable
 * is mutated in any other way (x.foo = ..., passed to a function that may
 * mutate it, spread from an unknown), the list is a lower bound.
 */
function collectWriteFieldsFromVariable(id: Identifier): FieldResult {
  const out: FieldResult = { fields: [], complete: true };
  const decl = id.getSymbol()?.getDeclarations().find((d) => Node.isVariableDeclaration(d));
  if (!decl || !Node.isVariableDeclaration(decl)) return { fields: [], complete: false };
  const nameNode = decl.getNameNode();
  if (!Node.isIdentifier(nameNode)) return { fields: [], complete: false };

  const init = decl.getInitializer();
  if (init) {
    const r = collectWriteFields(init);
    out.fields.push(...r.fields);
    out.complete &&= r.complete;
  } else {
    out.complete = false; // declared without initializer; assignments below may fill it
  }

  const refs = safeReferences(nameNode);
  if (!refs) return { fields: out.fields, complete: false };
  for (const ref of refs) {
    if (ref === nameNode || ref === id) continue;
    const parent = ref.getParent();
    if (parent && Node.isBinaryExpression(parent) && parent.getLeft() === ref && parent.getOperatorToken().getText() === "=") {
      const r = collectWriteFields(parent.getRight());
      out.fields.push(...r.fields);
      out.complete &&= r.complete;
      continue;
    }
    if (parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === ref) {
      const gp = parent.getParent();
      const isWrite = gp && Node.isBinaryExpression(gp) && gp.getLeft() === parent && gp.getOperatorToken().getText() === "=";
      if (isWrite) {
        out.fields.push({ path: climbPath(parent, parent.getName()), dir: "write" });
      }
      continue; // reads of params don't change what is sent
    }
    if (parent && Node.isCallExpression(parent) && parent.getExpression() !== ref) {
      // Passed to some other function: it may be the API call itself (fine) or a mutator (unknown).
      continue;
    }
    // Any other use (spread into something, returned, etc.) doesn't change what is sent.
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

  // Unwrap `await`, parentheses, `as` casts, `!`.
  while (
    parent &&
    (Node.isAwaitExpression(parent) ||
      Node.isParenthesizedExpression(parent) ||
      Node.isAsExpression(parent) ||
      Node.isNonNullExpression(parent) ||
      Node.isSatisfiesExpression(parent))
  ) {
    node = parent;
    parent = node.getParent();
  }
  if (!parent) return out;

  // `await call();` as a statement: the result is discarded. Nothing is read; that is complete.
  if (Node.isExpressionStatement(parent)) return out;

  // `session = await call();` where `session` was declared earlier (let session;)
  if (Node.isBinaryExpression(parent) && parent.getRight() === node && parent.getOperatorToken().getText() === "=") {
    const left = parent.getLeft();
    if (Node.isIdentifier(left)) {
      const decl = left.getSymbol()?.getDeclarations().find((d) => Node.isVariableDeclaration(d));
      const nameNode = decl && Node.isVariableDeclaration(decl) ? decl.getNameNode() : undefined;
      if (nameNode && Node.isIdentifier(nameNode)) {
        const r = readsFromIdentifier(nameNode);
        out.fields.push(...r.fields);
        out.complete = r.complete;
        return out;
      }
    }
    out.complete = false;
    return out;
  }

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
  const refs = safeReferences(decl);
  if (!refs) return { fields: [], complete: false };
  for (const ref of refs) {
    if (ref === decl) continue;
    let parent: Node | undefined = ref.getParent();
    // `x = ...` is a write to the variable, not a use of the value.
    if (parent && Node.isBinaryExpression(parent) && parent.getLeft() === ref && parent.getOperatorToken().getText() === "=") continue;
    // Look through `x!`, `(x)`, `x as T` to the real consumer.
    let carrier: Node = ref;
    while (parent && (Node.isNonNullExpression(parent) || Node.isParenthesizedExpression(parent) || Node.isAsExpression(parent))) {
      carrier = parent;
      parent = carrier.getParent();
    }
    if (parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === carrier) {
      out.fields.push({ path: climbPath(parent, parent.getName()), dir: "read" });
      continue;
    }
    if (parent && Node.isVariableDeclaration(parent) && Node.isObjectBindingPattern(parent.getNameNode())) {
      const r = readsFromBinding(parent.getNameNode() as any, "");
      out.fields.push(...r.fields);
      out.complete &&= r.complete;
      continue;
    }
    if (parent && isNonExposingUse(carrier, parent)) continue;
    // Bare use: passed along, returned, spread, assigned elsewhere. Stop tracking.
    out.complete = false;
  }
  return out;
}

/** Uses of a value that cannot read its fields: `!x`, `if (x)`, `x === y`, `typeof x`, `x ? a : b` (as the condition). */
export function isNonExposingUse(node: Node, parent: Node): boolean {
  if (Node.isPrefixUnaryExpression(parent)) return true; // !x, -x, typeof handled below
  if (Node.isTypeOfExpression(parent)) return true;
  if (Node.isIfStatement(parent) && parent.getExpression() === node) return true;
  if (Node.isWhileStatement(parent) && parent.getExpression() === node) return true;
  if (Node.isConditionalExpression(parent) && parent.getCondition() === node) return true;
  if (Node.isBinaryExpression(parent)) {
    const op = parent.getOperatorToken().getText();
    if (["===", "!==", "==", "!="].includes(op)) return true;
  }
  return false;
}

/** Descend through `x as T`, `(x)`, `x!`, `x satisfies T` to the underlying expression. */
export function unwrapExpression(node: Node): Node {
  let current = node;
  while (
    Node.isAsExpression(current) ||
    Node.isParenthesizedExpression(current) ||
    Node.isNonNullExpression(current) ||
    Node.isSatisfiesExpression(current) ||
    Node.isTypeAssertion(current)
  ) {
    current = current.getExpression();
  }
  return current;
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

/**
 * Members that belong to the JavaScript value, not to the API object. A path
 * stops before them: `data.filter(...)` reads `data`, `data.length` reads `data`.
 */
const JS_BUILTIN_MEMBERS = new Set([
  "length", "filter", "map", "find", "findIndex", "findLast", "forEach", "some", "every", "reduce", "reduceRight",
  "slice", "splice", "includes", "indexOf", "lastIndexOf", "join", "sort", "reverse", "flat", "flatMap", "at",
  "concat", "entries", "keys", "values", "push", "pop", "shift", "unshift", "fill",
  "toString", "toFixed", "toLocaleString", "valueOf", "toLowerCase", "toUpperCase", "trim", "trimStart", "trimEnd",
  "split", "startsWith", "endsWith", "replace", "replaceAll", "padStart", "padEnd", "charAt", "substring", "match",
  "hasOwnProperty", "toJSON", "then", "catch", "finally",
]);

/** From a PropertyAccessExpression, keep climbing while the parent is also a property access on us. */
export function climbPath(node: Node, first: string): string {
  if (JS_BUILTIN_MEMBERS.has(first)) return "";
  const parts = [first];
  let current: Node = node;
  let parent = current.getParent();
  while (parent) {
    if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === current) {
      if (JS_BUILTIN_MEMBERS.has(parent.getName())) break;
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
    if (!f.path) continue;
    const k = f.dir + ":" + f.path;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out.sort((a, b) => (a.dir + a.path).localeCompare(b.dir + b.path));
}

export { SyntaxKind };
