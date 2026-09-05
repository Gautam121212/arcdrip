/**
 * The arcdrip GitHub Action, standalone mode (Phase 1).
 *
 * Everything happens inside the customer's CI. Nothing leaves it: the manifest
 * is written to $RUNNER_TEMP (outside the workspace, so it can never be
 * committed), the spec is fetched from Stripe's public repository, and alerts
 * are reported through the workflow's own GITHUB_TOKEN. Snapshots and alert
 * state persist between runs via actions/cache.
 *
 * Invariant: this process exits 0 no matter what. Failures become a
 * ::warning:: in the log and, when possible, a neutral check run.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scan } from "../scan.js";
import { assertManifest, redactLocations, assertSafeToUpload, type Manifest } from "../manifest/schema.js";
import { SnapshotStore } from "../watcher/store.js";
import { STRIPE_SOURCE, fetchSpec } from "../watcher/sources.js";
import { buildModel } from "../watcher/openapi.js";
import { diffModels } from "../watcher/diff.js";
import { joinAlerts, type Alert } from "../watcher/join.js";
import { loadState, saveState, reconcile, acknowledge, type AlertRecord } from "./state.js";
import { GitHubClient, issueTitle } from "./github.js";

export interface ActionInputs {
  workspace: string;
  dataDir: string;
  /** seed the store with a historical spec ref as the baseline (first run only) */
  seedRef?: string;
  includeTests: boolean;
  budgetSeconds: number;
  /** print instead of calling GitHub */
  local: boolean;
  github?: { token: string; repo: string; sha: string; apiUrl?: string };
}

export function inputsFromEnv(env: NodeJS.ProcessEnv): ActionInputs {
  const local = !env.GITHUB_TOKEN || env.INPUT_LOCAL === "true";
  return {
    workspace: env.GITHUB_WORKSPACE ?? process.cwd(),
    dataDir: env.INPUT_DATA_DIR ?? join(env.RUNNER_TEMP ?? "/tmp", "arcdrip"),
    seedRef: env.INPUT_SEED_REF || undefined,
    includeTests: env.INPUT_INCLUDE_TESTS === "true",
    budgetSeconds: Number(env.INPUT_BUDGET_SECONDS || 300),
    local,
    github: local ? undefined : { token: env.GITHUB_TOKEN!, repo: env.GITHUB_REPOSITORY!, sha: env.GITHUB_SHA!, apiUrl: env.GITHUB_API_URL },
  };
}

export async function runAction(inputs: ActionInputs, log: (s: string) => void = console.log): Promise<void> {
  const dataDir = resolve(inputs.dataDir);
  mkdirSync(dataDir, { recursive: true });

  // 1. Scan. The manifest never touches the workspace.
  const manifest = scan({ rootDir: inputs.workspace, budgetMs: inputs.budgetSeconds * 1000, includeTests: inputs.includeTests });
  const redacted = redactLocations(manifest);
  assertSafeToUpload(redacted); // the invariant holds even though nothing is uploaded in standalone mode
  writeFileSync(join(dataDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const { t1, t2, t3 } = manifest.coverage;
  log(`[arcdrip] scan: t1=${t1} t2=${t2} t3=${t3} partial=${manifest.partial}`);
  if (!manifest.providers.stripe) {
    log("[arcdrip] no Stripe usage found; nothing to watch");
    await report(inputs, [], [], "No Stripe usage detected in this repository.", log);
    return;
  }

  // 2. Snapshot the spec. Seed once if asked; otherwise fetch latest with the debounce.
  const store = new SnapshotStore(dataDir, "stripe");
  if (inputs.seedRef && store.accepted().length === 0) {
    const r = store.ingest(await fetchSpec(STRIPE_SOURCE, inputs.seedRef), { ref: inputs.seedRef });
    log(`[arcdrip] seed ${inputs.seedRef}: ${r.status}${"snapshot" in r && r.snapshot ? ` ${r.snapshot.version}` : ""}`);
  }
  const r = store.ingest(await fetchSpec(STRIPE_SOURCE));
  log(`[arcdrip] spec: ${r.status}${"reason" in r ? ` (${r.reason})` : ""}${"snapshot" in r && r.snapshot ? ` ${r.snapshot.version}` : ""}`);

  // 3. Alerts: diff the last two accepted snapshots, join, persist.
  const accepted = store.accepted();
  let fresh: Alert[] = [];
  if (accepted.length >= 2) {
    const from = buildModel(store.read(accepted[accepted.length - 2].hash));
    const to = buildModel(store.read(accepted[accepted.length - 1].hash));
    const changes = diffModels(from, to);
    fresh = joinAlerts(changes, manifest, from, to);
    log(`[arcdrip] ${from.version} -> ${to.version}: ${changes.length} change(s), ${changes.filter((c) => c.breaking).length} breaking, ${fresh.length} touch this code`);
  } else {
    log(`[arcdrip] baseline only (${accepted.length} accepted snapshot); alerts start with the next accepted change`);
  }
  const now = new Date().toISOString();
  let { state, opened, resolved, open } = reconcile(loadState(dataDir), fresh, manifest, now);
  saveState(dataDir, state);
  log(`[arcdrip] alerts: ${open.length} open (${opened.length} new), ${resolved.length} resolved this run`);

  // 4. Report. Issues a human closed come back as acknowledged and are recorded.
  const acknowledged = await report(inputs, open, resolved, summaryText(manifest, accepted.length, open, opened, resolved, r.status), log);
  if (acknowledged.length > 0) {
    state = acknowledge(state, acknowledged, now);
    log(`[arcdrip] acknowledged by closed issue: ${acknowledged.length}`);
  }
  saveState(dataDir, state);
}

async function report(inputs: ActionInputs, open: AlertRecord[], resolved: AlertRecord[], summary: string, log: (s: string) => void): Promise<string[]> {
  if (inputs.local || !inputs.github) {
    log("[arcdrip] local mode: would create check run and sync issues:");
    log(summary);
    for (const r of open) log(`  OPEN     ${issueTitle(r)}  ${r.alert.locs.map((l) => `${l.file}:${l.line}`).join(", ")}`);
    for (const r of resolved) log(`  RESOLVED ${issueTitle(r)}`);
    return [];
  }
  const gh = new GitHubClient(inputs.github);
  const s = await gh.syncIssues(open, resolved);
  log(`[arcdrip] issues: ${s.created} created, ${s.updated} updated, ${s.closed} closed, ${s.acknowledged.length} acknowledged`);
  const stillOpen = open.filter((r) => !s.acknowledged.includes(r.alert.id));
  await gh.createCheckRun(stillOpen, summary);
  return s.acknowledged;
}

function summaryText(m: Manifest, snapshots: number, open: AlertRecord[], opened: AlertRecord[], resolved: AlertRecord[], specStatus: string): string {
  const s = m.providers.stripe;
  return [
    `Stripe usage: ${s?.entries.length ?? 0} entries (t1=${m.coverage.t1}, t2=${m.coverage.t2}, t3=${m.coverage.t3}), pinned to ${s?.pinned_version ?? "no version (latest)"}.`,
    `Spec snapshots accepted: ${snapshots} (this run: ${specStatus}).`,
    `Open alerts: ${open.length} (${opened.length} new this run, ${resolved.length} resolved).`,
    ...(m.partial ? ["Scan was partial: some files were skipped; field-level results are a lower bound."] : []),
  ].join("\n");
}

// Entry point when run directly.
const isMain = process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("main.js");
if (isMain) {
  runAction(inputsFromEnv(process.env)).catch((err) => {
    // Never fail the customer's workflow.
    console.log(`::warning title=arcdrip::internal error, no alerts were evaluated this run: ${(err as Error).message}`);
    if (process.env.ARCDRIP_DEBUG) console.error((err as Error).stack);
    process.exitCode = 0;
  });
}
