/**
 * Snapshot store with the acceptance discipline from design doc §4.2:
 *   1. must parse; operation count within ±20% of the last accepted snapshot
 *   2. a "latest" fetch must be seen twice in a row before it is accepted (debounce)
 *   3. every snapshot is content-hashed and kept
 * Filesystem-backed for Phase 1. The interface is what the service keeps.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Snapshot {
  hash: string;
  version: string;
  fetched_at: string;
  /** git ref the spec was fetched at, when explicit (replay); absent for "latest" */
  ref?: string;
  operations: number;
}

interface State {
  accepted: Snapshot[];
  pending: Snapshot | null;
  quarantined: Array<Snapshot & { reason: string }>;
}

export type IngestResult =
  | { status: "accepted"; snapshot: Snapshot }
  | { status: "unchanged"; snapshot: Snapshot }
  | { status: "pending"; snapshot: Snapshot }
  | { status: "quarantined"; reason: string; snapshot?: Snapshot };

export const BAND = 0.2;

export class SnapshotStore {
  private readonly dir: string;
  private readonly stateFile: string;

  constructor(dataDir: string, provider: string) {
    this.dir = join(dataDir, provider);
    this.stateFile = join(this.dir, "state.json");
    mkdirSync(join(this.dir, "snapshots"), { recursive: true });
  }

  state(): State {
    if (!existsSync(this.stateFile)) return { accepted: [], pending: null, quarantined: [] };
    return JSON.parse(readFileSync(this.stateFile, "utf8"));
  }

  private save(s: State): void {
    writeFileSync(this.stateFile, JSON.stringify(s, null, 2) + "\n");
  }

  accepted(): Snapshot[] {
    return this.state().accepted;
  }

  latest(n = 1): Snapshot[] {
    return this.accepted().slice(-n);
  }

  read(hash: string): unknown {
    return JSON.parse(readFileSync(join(this.dir, "snapshots", `${hash}.json`), "utf8"));
  }

  find(hashPrefix: string): Snapshot | undefined {
    return this.accepted().find((s) => s.hash.startsWith(hashPrefix));
  }

  /**
   * @param raw       spec text as fetched
   * @param opts.ref  explicit git ref; such a snapshot is trusted and skips the debounce
   */
  ingest(raw: string, opts: { ref?: string; now?: Date } = {}): IngestResult {
    const state = this.state();
    const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
    const now = (opts.now ?? new Date()).toISOString();

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: "quarantined", reason: "unparseable JSON" };
    }
    const operations = countOperations(parsed);
    const version = String(parsed?.info?.version ?? "unknown");
    const snapshot: Snapshot = { hash, version, fetched_at: now, operations, ...(opts.ref ? { ref: opts.ref } : {}) };

    const existing = state.accepted.find((s) => s.hash === hash);
    if (existing) return { status: "unchanged", snapshot: existing };

    const last = state.accepted[state.accepted.length - 1];
    if (last && operations > 0 && Math.abs(operations - last.operations) / last.operations > BAND) {
      const reason = `operation count ${operations} outside ±${BAND * 100}% of last accepted ${last.operations}`;
      state.quarantined.push({ ...snapshot, reason });
      this.save(state);
      return { status: "quarantined", reason, snapshot };
    }
    if (operations === 0) {
      const reason = "no operations found";
      state.quarantined.push({ ...snapshot, reason });
      this.save(state);
      return { status: "quarantined", reason, snapshot };
    }

    const trusted = Boolean(opts.ref) || state.pending?.hash === hash;
    if (!trusted) {
      state.pending = snapshot;
      this.save(state);
      return { status: "pending", snapshot };
    }

    writeFileSync(join(this.dir, "snapshots", `${hash}.json`), raw);
    state.accepted.push(snapshot);
    state.accepted.sort((a, b) => a.fetched_at.localeCompare(b.fetched_at));
    state.pending = null;
    this.save(state);
    return { status: "accepted", snapshot };
  }
}

export function countOperations(spec: any): number {
  let n = 0;
  for (const item of Object.values<any>(spec?.paths ?? {})) {
    for (const verb of ["get", "post", "put", "patch", "delete"]) if (item?.[verb]) n++;
  }
  return n;
}
