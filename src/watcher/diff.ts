/**
 * Diff two SpecModels into the change taxonomy (design doc §4.4).
 *
 * Deterministic. Every change carries enough detail to be shown as evidence.
 * Additive changes are recorded (for digests) but marked non-breaking; the
 * join layer never alerts on them.
 */
import type { FieldSpec, FlatSchema, SpecModel } from "./openapi.js";

export type ChangeCode =
  | "OPERATION_REMOVED"
  | "OPERATION_ADDED"
  | "FIELD_REMOVED"
  | "FIELD_TYPE_CHANGED"
  | "FIELD_NULLABLE_CHANGED"
  | "REQUEST_FIELD_REMOVED"
  | "REQUEST_FIELD_TYPE_CHANGED"
  | "REQUIRED_PARAM_ADDED"
  | "ENUM_VALUE_REMOVED"
  | "ENUM_VALUE_ADDED"
  | "ADDITIVE";

export interface Change {
  code: ChangeCode;
  breaking: boolean;
  /** "operation" = inline request/response of one endpoint; "schema" = a component schema shared by many */
  scope: "operation" | "schema";
  operation?: string;
  schema?: string;
  side?: "request" | "response";
  path?: string;
  detail: string;
}

const BREAKING: Set<ChangeCode> = new Set([
  "OPERATION_REMOVED",
  "FIELD_REMOVED",
  "FIELD_TYPE_CHANGED",
  "FIELD_NULLABLE_CHANGED",
  "REQUEST_FIELD_REMOVED",
  "REQUEST_FIELD_TYPE_CHANGED",
  "REQUIRED_PARAM_ADDED",
  "ENUM_VALUE_REMOVED",
]);

export function diffModels(from: SpecModel, to: SpecModel): Change[] {
  const out: Change[] = [];
  const push = (c: Omit<Change, "breaking">) => out.push({ ...c, breaking: BREAKING.has(c.code) });

  // Operations
  for (const [key, a] of from.operations) {
    const b = to.operations.get(key);
    if (!b) {
      push({ code: "OPERATION_REMOVED", scope: "operation", operation: key, detail: `${key} no longer exists` });
      continue;
    }
    // Request side
    for (const c of diffFields(a.request, b.request, "request")) push({ ...c, scope: "operation", operation: key, side: "request" });
    for (const p of b.requiredParams) {
      if (!a.requiredParams.has(p)) {
        push({ code: "REQUIRED_PARAM_ADDED", scope: "operation", operation: key, side: "request", path: p, detail: `${p} is now required` });
      }
    }
    // Inline response side (mounted schemas are diffed once, below)
    for (const c of diffFields(a.response, b.response, "response")) push({ ...c, scope: "operation", operation: key, side: "response" });
  }
  for (const key of to.operations.keys()) {
    if (!from.operations.has(key)) push({ code: "OPERATION_ADDED", scope: "operation", operation: key, detail: `${key} added` });
  }

  // Component schemas
  for (const [name, a] of from.schemas) {
    const b = to.schemas.get(name);
    if (!b) {
      push({ code: "FIELD_REMOVED", scope: "schema", schema: name, path: "", detail: `schema ${name} removed` });
      continue;
    }
    for (const c of diffFields(a, b, "response")) push({ ...c, scope: "schema", schema: name, side: "response" });
  }

  return out;
}

type Partial = Omit<Change, "breaking" | "scope" | "operation" | "schema" | "side">;

function diffFields(a: FlatSchema, b: FlatSchema, side: "request" | "response"): Partial[] {
  const out: Partial[] = [];
  for (const [path, fa] of a) {
    const fb = b.get(path);
    if (!fb) {
      // If a parent was already removed, the leaf removal is implied; still report — joins match by prefix.
      out.push({ code: side === "request" ? "REQUEST_FIELD_REMOVED" : "FIELD_REMOVED", path, detail: `${path} removed` });
      continue;
    }
    if (fa.type !== fb.type && !typeWidened(fa, fb)) {
      out.push({
        code: side === "request" ? "REQUEST_FIELD_TYPE_CHANGED" : "FIELD_TYPE_CHANGED",
        path,
        detail: `${path}: ${fa.type} -> ${fb.type}`,
      });
    }
    if (side === "response" && !fa.nullable && fb.nullable) {
      out.push({ code: "FIELD_NULLABLE_CHANGED", path, detail: `${path} may now be null or absent` });
    }
    if (fa.enum && fb.enum) {
      const removed = fa.enum.filter((v) => !fb.enum!.includes(v));
      const added = fb.enum.filter((v) => !fa.enum!.includes(v));
      if (removed.length) out.push({ code: "ENUM_VALUE_REMOVED", path, detail: `${path}: removed ${removed.join(", ")}` });
      if (added.length) out.push({ code: "ENUM_VALUE_ADDED", path, detail: `${path}: added ${added.join(", ")}` });
    }
  }
  let added = 0;
  for (const path of b.keys()) if (!a.has(path)) added++;
  if (added > 0) out.push({ code: "ADDITIVE", detail: `${added} field(s) added` });
  return out;
}

/** string -> string|object (a field became expandable) is not breaking for readers of the string. */
function typeWidened(fa: FieldSpec, fb: FieldSpec): boolean {
  const a = new Set(fa.type.split("|"));
  const b = new Set(fb.type.split("|"));
  for (const t of a) if (!b.has(t)) return false;
  return true;
}
