/**
 * changes × manifest -> alerts (design doc §4.6).
 *
 * Only breaking changes that intersect something the code actually reads,
 * writes, calls, or handles become alerts. Additive changes never do.
 * Tier 3 entries only match provider-wide events (operation removal is not
 * one; there are none in a pure spec diff, so T3 entries produce nothing here).
 */
import { createHash } from "node:crypto";
import type { Entry, Manifest } from "../manifest/schema.js";
import type { Change } from "./diff.js";
import { eventToSchema, resolvePath, type SpecModel } from "./openapi.js";

export type Severity = "breaking" | "advisory";

export interface Alert {
  id: string;
  provider: "stripe";
  code: Change["code"];
  severity: Severity;
  /** why it is advisory instead of breaking, when it is */
  severity_note?: string;
  operation?: string;
  event?: string;
  /** the manifest path that is affected (request write, response read, or webhook read) */
  affected_path?: string;
  entry_ids: string[];
  locs: Array<{ file: string; line: number }>;
  source: "observed";
  evidence: {
    from_version: string;
    to_version: string;
    change: Change;
  };
}

export function joinAlerts(changes: Change[], manifest: Manifest, from: SpecModel, to: SpecModel): Alert[] {
  const section = manifest.providers.stripe;
  if (!section) return [];
  const breaking = changes.filter((c) => c.breaking);
  const pinned = section.pinned_version;
  const alerts = new Map<string, Alert>();

  const add = (entry: Entry, change: Change, affectedPath?: string) => {
    const opOrEvent = entry.kind === "call" ? entry.operation! : entry.event!;
    // One alert per (code, operation/event, affected path). When a parent and a child are both
    // removed, the parent removal is the cause; keep the outermost change as evidence.
    const key = `${change.code}|${opOrEvent}|${affectedPath ?? ""}|${change.schema ?? ""}`;
    const existing = alerts.get(key);
    if (existing) {
      if (!existing.entry_ids.includes(entry.id)) existing.entry_ids.push(entry.id);
      for (const l of entry.locs ?? []) if (!existing.locs.some((x) => x.file === l.file && x.line === l.line)) existing.locs.push(l);
      if ((change.path ?? "").length < (existing.evidence.change.path ?? "").length) existing.evidence.change = change;
      return;
    }
    const sev = applicability(pinned, to.version);
    alerts.set(key, {
      id: createHash("sha256").update(key).digest("hex").slice(0, 16),
      provider: "stripe",
      code: change.code,
      severity: sev.severity,
      ...(sev.note ? { severity_note: sev.note } : {}),
      ...(entry.kind === "call" ? { operation: entry.operation } : { event: entry.event }),
      ...(affectedPath ? { affected_path: affectedPath } : {}),
      entry_ids: [entry.id],
      locs: [...(entry.locs ?? [])],
      source: "observed",
      evidence: { from_version: from.version, to_version: to.version, change },
    });
  };

  for (const entry of section.entries) {
    if (entry.tier === 3) continue;
    if (entry.kind === "call") joinCall(entry, breaking, from, to, add);
    else joinWebhook(entry, breaking, from, to, add);
  }
  return [...alerts.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function joinCall(entry: Entry, changes: Change[], from: SpecModel, to: SpecModel, add: (e: Entry, c: Change, p?: string) => void) {
  const ops = (entry.operation ?? "").split(" | ").filter((o) => !o.startsWith("sdk:") && !o.startsWith("host:"));
  for (const op of ops) {
    const opChanges = changes.filter((c) => c.scope === "operation" && c.operation === op);
    for (const c of opChanges) {
      if (c.code === "OPERATION_REMOVED") add(entry, c);
      if (c.code === "REQUIRED_PARAM_ADDED" && !entry.fields.some((f) => f.dir === "write" && f.path === c.path)) add(entry, c, c.path);
    }
    const model = from.operations.get(op);
    for (const f of entry.fields) {
      if (f.dir === "write") {
        for (const c of opChanges) {
          if (c.side !== "request" || !c.path) continue;
          if (f.path === c.path || f.path.startsWith(c.path + ".") || f.path.startsWith(c.path + "[]")) add(entry, c, f.path);
        }
        continue;
      }
      // read: resolve through the inline response and mounted schemas
      const deps = resolvePath(from, { inline: model?.response }, f.path);
      const roots = model?.responseRoots ?? [];
      // A response that IS a schema (customer | deleted_customer): resolve against each root too.
      const rootDeps = roots.flatMap((r) => resolvePath(from, { schema: r }, f.path));
      matchDeps(entry, [...deps, ...rootDeps], op, changes, f.path, add);
    }
  }
}

function joinWebhook(entry: Entry, changes: Change[], from: SpecModel, _to: SpecModel, add: (e: Entry, c: Change, p?: string) => void) {
  const schema = eventToSchema(entry.event ?? "", from);
  if (!schema) return;
  for (const f of entry.fields) {
    if (!f.path.startsWith("data.object.")) continue;
    const objectPath = f.path.slice("data.object.".length);
    const deps = resolvePath(from, { schema }, objectPath);
    matchDeps(entry, deps, null, changes, f.path, add);
  }
}

function matchDeps(
  entry: Entry,
  deps: Array<{ schema: string | null; path: string }>,
  op: string | null,
  changes: Change[],
  affectedPath: string,
  add: (e: Entry, c: Change, p?: string) => void,
) {
  for (const dep of deps) {
    for (const c of changes) {
      if (c.side !== "response" || !c.path) continue;
      const sameScope =
        (dep.schema && c.scope === "schema" && c.schema === dep.schema) ||
        (!dep.schema && c.scope === "operation" && c.operation === op);
      if (!sameScope) continue;
      if (c.path === dep.path) add(entry, c, affectedPath);
    }
  }
}

/**
 * Version applicability (design doc §4.5). Stripe API versions are dated and
 * immutable: code pinned to an older version keeps the old behaviour until it
 * moves. A diff between two "latest" specs therefore applies to unpinned code
 * now, and to pinned code only when it upgrades past the newer version.
 */
export function applicability(pinned: string | null, toVersion: string): { severity: Severity; note?: string } {
  if (!pinned) return { severity: "breaking" };
  const p = pinned.slice(0, 10);
  const t = toVersion.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(p) && /^\d{4}-\d{2}-\d{2}$/.test(t) && p < t) {
    return { severity: "advisory", note: `code is pinned to ${pinned}; applies when it moves to ${toVersion} or later` };
  }
  return { severity: "breaking" };
}
