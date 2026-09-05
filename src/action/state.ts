/**
 * Alerts persist across runs. A new alert is opened when a spec change first
 * intersects the manifest; it stays open until the code no longer contains
 * the entry that triggered it (auto-resolved) or a human closes the issue.
 *
 * Locations are re-derived from the *current* manifest on every run by entry
 * id (ids are path-independent), so annotations follow the code as it moves.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Alert } from "../watcher/join.js";
import type { Manifest } from "../manifest/schema.js";

export interface AlertRecord {
  alert: Alert;
  status: "open" | "resolved";
  first_seen: string;
  resolved_at?: string;
  resolved_reason?: "code_no_longer_depends" | "issue_closed";
  reopened_at?: string;
  issue_number?: number;
}

export interface AlertState {
  records: Record<string, AlertRecord>;
}

export function loadState(dataDir: string): AlertState {
  const f = join(dataDir, "alerts.json");
  if (!existsSync(f)) return { records: {} };
  return JSON.parse(readFileSync(f, "utf8"));
}

export function saveState(dataDir: string, state: AlertState): void {
  writeFileSync(join(dataDir, "alerts.json"), JSON.stringify(state, null, 2) + "\n");
}

/**
 * Merge freshly computed alerts into the state and reconcile open ones
 * against the current manifest. Pure; returns the new state and what changed.
 */
/** A human closed the issue: acknowledged. It will not be recreated. */
export function acknowledge(state: AlertState, alertIds: string[], now: string): AlertState {
  const records = { ...state.records };
  for (const id of alertIds) {
    const rec = records[id];
    if (rec && rec.status === "open") {
      rec.status = "resolved";
      rec.resolved_at = now;
      rec.resolved_reason = "issue_closed";
    }
  }
  return { records };
}

export function reconcile(
  state: AlertState,
  fresh: Alert[],
  manifest: Manifest,
  now: string,
): { state: AlertState; opened: AlertRecord[]; resolved: AlertRecord[]; open: AlertRecord[] } {
  const records = { ...state.records };
  const opened: AlertRecord[] = [];
  const resolved: AlertRecord[] = [];

  const entries = Object.values(manifest.providers).flatMap((p) => p.entries);
  /**
   * An alert still applies while the code has an entry for the same operation
   * or event that still reads/writes the affected path. Matching is semantic,
   * not by entry id: ids change whenever the field set changes, and adding an
   * unrelated read must not silently resolve an alert.
   */
  const dependents = (a: Alert) =>
    entries.filter((e) => {
      const same = a.operation ? e.kind === "call" && e.operation === a.operation : e.kind === "webhook" && e.event === a.event;
      if (!same) return false;
      if (!a.affected_path) return true;
      return e.fields.some((f) => f.path === a.affected_path);
    });

  for (const a of fresh) {
    const known = records[a.id];
    if (!known) {
      const rec: AlertRecord = { alert: a, status: "open", first_seen: now };
      records[a.id] = rec;
      opened.push(rec);
      continue;
    }
    // Auto-resolved because the code stopped depending, and now it depends again: reopen.
    // Closed by a human (acknowledged) stays closed.
    if (known.status === "resolved" && known.resolved_reason === "code_no_longer_depends" && dependents(a).length > 0) {
      known.status = "open";
      known.reopened_at = now;
      delete known.resolved_at;
      delete known.resolved_reason;
      opened.push(known);
    }
  }

  for (const rec of Object.values(records)) {
    if (rec.status !== "open") continue;
    const deps = dependents(rec.alert);
    if (deps.length === 0) {
      rec.status = "resolved";
      rec.resolved_at = now;
      rec.resolved_reason = "code_no_longer_depends";
      resolved.push(rec);
      continue;
    }
    // Follow the code: refresh entry ids and locations from the current manifest.
    rec.alert.entry_ids = deps.map((e) => e.id);
    rec.alert.locs = deps.flatMap((e) => e.locs ?? []);
  }

  const open = Object.values(records).filter((r) => r.status === "open");
  return { state: { records }, opened, resolved, open };
}
