/**
 * Turn an OpenAPI 3 document into something diffable and joinable.
 *
 * We do NOT expand $refs into a giant tree. Each component schema is
 * flattened on its own, and a field that points at another schema is recorded
 * as a *mount* (`ref`). Joining a manifest read path such as
 * `items.data[].price.id` walks those mounts. This keeps the model small,
 * makes a change in `price` a single change, and mirrors how Stripe actually
 * changes things: per resource.
 *
 * Paths use the manifest convention: `a.b`, arrays as `a[]`, `a[].b`.
 * Free-form maps (`metadata`) are marked `freeform` and never descended.
 */
import { canonicalPath } from "../detectors/stripe-sdk-table.js";

export interface FieldSpec {
  /** "string", "integer", "object", "array", "boolean", "number", or a union joined with "|" */
  type: string;
  /** true when the spec allows null, or the field is not listed as required by its parent */
  nullable: boolean;
  /** schema names this field may be an instance of (expandable fields, nested resources, array items) */
  refs?: string[];
  enum?: string[];
  freeform?: boolean;
}

export type FlatSchema = Map<string, FieldSpec>;

export interface OperationModel {
  request: FlatSchema;
  requiredParams: Set<string>;
  /** inline response shape; refs are mounts into `schemas` */
  response: FlatSchema;
  /** schema names the whole response body may be (e.g. customer | deleted_customer) */
  responseRoots: string[];
}

export interface SpecModel {
  version: string;
  operations: Map<string, OperationModel>;
  schemas: Map<string, FlatSchema>;
}

const MAX_DEPTH = 6;
const MAX_FIELDS_PER_SCHEMA = 5000;

type Json = any;

export function buildModel(spec: Json): SpecModel {
  const components: Record<string, Json> = spec?.components?.schemas ?? {};
  const schemas = new Map<string, FlatSchema>();
  for (const [name, schema] of Object.entries(components)) {
    schemas.set(name, flatten(schema, components));
  }

  const operations = new Map<string, OperationModel>();
  for (const [path, item] of Object.entries<Json>(spec?.paths ?? {})) {
    for (const verb of ["get", "post", "put", "patch", "delete"]) {
      const op = item?.[verb];
      if (!op) continue;
      const key = `${verb.toUpperCase()} ${canonicalPath(path)}`;
      operations.set(key, buildOperation(op, components));
    }
  }
  return { version: String(spec?.info?.version ?? "unknown"), operations, schemas };
}

function buildOperation(op: Json, components: Record<string, Json>): OperationModel {
  const reqSchema =
    op.requestBody?.content?.["application/x-www-form-urlencoded"]?.schema ??
    op.requestBody?.content?.["application/json"]?.schema ??
    null;
  const request = reqSchema ? flatten(reqSchema, components) : new Map();
  const requiredParams = new Set<string>(Array.isArray(reqSchema?.required) ? reqSchema.required : []);
  for (const p of op.parameters ?? []) if (p?.required && p?.in === "query") requiredParams.add(String(p.name));

  const resSchema = op.responses?.["200"]?.content?.["application/json"]?.schema ?? null;
  const response = resSchema ? flatten(resSchema, components) : new Map();
  const responseRoots = resSchema ? refsOf(resSchema) : [];
  return { request, requiredParams, response, responseRoots };
}

/** Names of schemas a node may directly be (through $ref / anyOf / oneOf / allOf). */
function refsOf(node: Json): string[] {
  const out: string[] = [];
  const visit = (n: Json) => {
    if (!n || typeof n !== "object") return;
    if (typeof n.$ref === "string") out.push(refName(n.$ref));
    for (const k of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(n[k])) n[k].forEach(visit);
  };
  visit(node);
  return [...new Set(out)];
}

function refName(ref: string): string {
  return ref.replace(/^#\/components\/schemas\//, "");
}

/** Flatten one schema node into path -> FieldSpec, treating $refs as mounts. */
export function flatten(schema: Json, components: Record<string, Json>): FlatSchema {
  const out: FlatSchema = new Map();
  walk(schema, "", 0, out, components, true);
  return out;
}

function walk(node: Json, prefix: string, depth: number, out: FlatSchema, components: Record<string, Json>, isRoot: boolean): void {
  if (!node || typeof node !== "object" || depth > MAX_DEPTH || out.size > MAX_FIELDS_PER_SCHEMA) return;

  // Unions: merge the properties of every variant; a field is nullable if any variant lacks it.
  const variants: Json[] = [];
  for (const k of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(node[k])) variants.push(...node[k]);
  if (variants.length > 0 && !node.properties) {
    for (const v of variants) {
      if (typeof v?.$ref === "string") continue; // mounts are recorded by the parent, not descended
      walk(v, prefix, depth, out, components, isRoot);
    }
    return;
  }

  const required = new Set<string>(Array.isArray(node.required) ? node.required : []);
  const props: Record<string, Json> = node.properties ?? {};
  for (const [name, prop] of Object.entries(props)) {
    const path = prefix ? `${prefix}.${name}` : name;
    const spec = describe(prop, !required.has(name));
    out.set(path, spec);
    if (spec.freeform) continue;
    if (spec.refs && spec.refs.length > 0 && !prop.properties) continue; // pure mount; its fields live in the target schema
    if (spec.type.includes("array")) {
      const items = arrayItems(prop);
      if (items && !refsOf(items).length) walk(items, `${path}[]`, depth + 1, out, components, false);
      else if (items) out.set(`${path}[]`, describe(items, false));
      continue;
    }
    walk(prop, path, depth + 1, out, components, false);
  }
}

function arrayItems(prop: Json): Json | null {
  if (prop?.items) return prop.items;
  for (const k of ["anyOf", "oneOf"]) for (const v of prop?.[k] ?? []) if (v?.items) return v.items;
  return null;
}

/** Describe a single property node. */
function describe(prop: Json, optional: boolean): FieldSpec {
  const types = new Set<string>();
  let nullable = optional || prop?.nullable === true;
  let enumVals: string[] | undefined;
  const refs = refsOf(prop);
  let freeform = false;

  const visit = (n: Json) => {
    if (!n || typeof n !== "object") return;
    if (typeof n.$ref === "string") {
      types.add("object");
      return;
    }
    if (n.nullable === true) nullable = true;
    if (Array.isArray(n.enum)) enumVals = [...new Set([...(enumVals ?? []), ...n.enum.map(String)])];
    if (n.type) types.add(Array.isArray(n.type) ? n.type.join("|") : String(n.type));
    if (n.type === "object" && !n.properties && (n.additionalProperties === true || typeof n.additionalProperties === "object")) freeform = true;
    if (n.type === "object" && n.properties) freeform = false;
    for (const k of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(n[k])) n[k].forEach(visit);
  };
  visit(prop);
  if (types.size === 0) types.add(refs.length ? "object" : "any");
  return {
    type: [...types].sort().join("|"),
    nullable,
    ...(refs.length ? { refs } : {}),
    ...(enumVals ? { enum: enumVals.sort() } : {}),
    ...(freeform ? { freeform: true } : {}),
  };
}

/**
 * Stripe names webhook events `<object>.<action>`. Find the component schema
 * the payload object is: `customer.subscription.updated` -> subscription,
 * `checkout.session.completed` -> checkout.session, `invoice.paid` -> invoice.
 */
export function eventToSchema(event: string, model: SpecModel): string | null {
  const segs = event.split(".");
  for (let i = 0; i < segs.length - 1; i++) {
    const candidate = segs.slice(i, segs.length - 1).join(".");
    if (model.schemas.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Walk a manifest read path from a root through mounts.
 * Returns every (schema, path) pair the read depends on, outermost first,
 * so a removed parent is caught as well as a removed leaf.
 */
export function resolvePath(
  model: SpecModel,
  root: { schema?: string; inline?: FlatSchema },
  path: string,
): Array<{ schema: string | null; path: string }> {
  const deps: Array<{ schema: string | null; path: string }> = [];
  const segments = splitPath(path);
  let current: FlatSchema | undefined = root.inline ?? (root.schema ? model.schemas.get(root.schema) : undefined);
  let currentSchema: string | null = root.schema ?? null;
  let local: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    local.push(segments[i]);
    const localPath = local.join(".").replace(/\.\[\]/g, "[]");
    deps.push({ schema: currentSchema, path: localPath });
    const spec = current?.get(localPath);
    if (!spec) break; // unknown field: the join reports "not in spec" rather than guessing
    if (spec.freeform) break;
    if (spec.refs && spec.refs.length > 0 && i < segments.length - 1) {
      // Descend into the first mount that exists; expandable fields list the object variant.
      const target = spec.refs.find((r) => model.schemas.has(r));
      if (!target) break;
      current = model.schemas.get(target);
      currentSchema = target;
      local = [];
    }
  }
  return deps;
}

function splitPath(path: string): string[] {
  // "items.data[].price.id" -> ["items", "data", "[]", "price", "id"]
  const out: string[] = [];
  for (const seg of path.split(".")) {
    if (seg.endsWith("[]")) {
      out.push(seg.slice(0, -2), "[]");
    } else out.push(seg);
  }
  return out;
}
