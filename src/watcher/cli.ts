import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertManifest } from "../manifest/schema.js";
import { SnapshotStore } from "./store.js";
import { STRIPE_SOURCE, fetchSpec } from "./sources.js";
import { buildModel } from "./openapi.js";
import { diffModels } from "./diff.js";
import { joinAlerts } from "./join.js";
import { renderAlerts, summarizeChanges } from "./render.js";

const DEFAULT_DATA = ".arcdrip";

export function registerWatch(program: Command): void {
  const watch = program.command("watch").description("watch provider API specs and alert on changes that touch a manifest");

  watch
    .command("fetch")
    .description("fetch the Stripe spec (latest, or at a git ref) into the snapshot store")
    .option("--data <dir>", "data directory", DEFAULT_DATA)
    .option("--ref <ref>", "git ref in stripe/openapi (trusted; skips the two-fetch debounce)")
    .action(async (opts: { data: string; ref?: string }) => {
      const store = new SnapshotStore(resolve(opts.data), "stripe");
      const raw = await fetchSpec(STRIPE_SOURCE, opts.ref);
      const r = store.ingest(raw, { ref: opts.ref });
      const v = "snapshot" in r && r.snapshot ? `${r.snapshot.hash} (${r.snapshot.version}, ${r.snapshot.operations} ops)` : "";
      console.log(`[watch] ${r.status}${"reason" in r ? `: ${r.reason}` : ""} ${v}`);
    });

  watch
    .command("status")
    .option("--data <dir>", "data directory", DEFAULT_DATA)
    .action((opts: { data: string }) => {
      const s = new SnapshotStore(resolve(opts.data), "stripe").state();
      console.log(`accepted: ${s.accepted.length}`);
      for (const a of s.accepted) console.log(`  ${a.hash}  ${a.version.padEnd(20)} ${a.operations} ops  ${a.fetched_at}${a.ref ? `  ref=${a.ref}` : ""}`);
      console.log(`pending: ${s.pending ? `${s.pending.hash} (${s.pending.version}) — will be accepted if seen again` : "none"}`);
      console.log(`quarantined: ${s.quarantined.length}`);
      for (const q of s.quarantined) console.log(`  ${q.hash}  ${q.version}  ${q.reason}`);
    });

  watch
    .command("diff")
    .description("summarise changes between two accepted snapshots (default: the last two)")
    .option("--data <dir>", "data directory", DEFAULT_DATA)
    .option("--from <hash>")
    .option("--to <hash>")
    .option("--json", "print every change as JSON", false)
    .action((opts: { data: string; from?: string; to?: string; json: boolean }) => {
      const { changes } = load(opts);
      if (opts.json) console.log(JSON.stringify(changes, null, 2));
      else console.log(summarizeChanges(changes));
    });

  watch
    .command("alerts")
    .description("join the changes between two snapshots against a manifest")
    .requiredOption("--manifest <file>", "manifest JSON from `arcdrip scan`")
    .option("--data <dir>", "data directory", DEFAULT_DATA)
    .option("--from <hash>")
    .option("--to <hash>")
    .option("--json", "print alerts as JSON", false)
    .action((opts: { manifest: string; data: string; from?: string; to?: string; json: boolean }) => {
      const { changes, fromModel, toModel } = load(opts);
      const manifest = assertManifest(JSON.parse(readFileSync(opts.manifest, "utf8")));
      const alerts = joinAlerts(changes, manifest, fromModel, toModel);
      console.log(opts.json ? JSON.stringify(alerts, null, 2) : renderAlerts(alerts));
    });

  watch
    .command("replay")
    .description("fetch two historical specs and produce the alerts a manifest would have received")
    .requiredOption("--from-ref <ref>")
    .requiredOption("--to-ref <ref>")
    .requiredOption("--manifest <file>")
    .option("--data <dir>", "data directory", DEFAULT_DATA)
    .option("--json", "print alerts as JSON", false)
    .action(async (opts: { fromRef: string; toRef: string; manifest: string; data: string; json: boolean }) => {
      const store = new SnapshotStore(resolve(opts.data), "stripe");
      const snaps = [];
      for (const ref of [opts.fromRef, opts.toRef]) {
        const r = store.ingest(await fetchSpec(STRIPE_SOURCE, ref), { ref });
        if (!("snapshot" in r) || !r.snapshot) throw new Error(`could not ingest ${ref}: ${"reason" in r ? r.reason : r.status}`);
        console.error(`[watch] ${ref}: ${r.status} ${r.snapshot.hash} (${r.snapshot.version})`);
        snaps.push(r.snapshot.hash);
      }
      const { changes, fromModel, toModel } = load({ data: opts.data, from: snaps[0], to: snaps[1] });
      console.error(summarizeChanges(changes));
      const manifest = assertManifest(JSON.parse(readFileSync(opts.manifest, "utf8")));
      const alerts = joinAlerts(changes, manifest, fromModel, toModel);
      console.log(opts.json ? JSON.stringify(alerts, null, 2) : renderAlerts(alerts));
    });
}

function load(opts: { data: string; from?: string; to?: string }) {
  const store = new SnapshotStore(resolve(opts.data), "stripe");
  const accepted = store.accepted();
  const from = opts.from ? store.find(opts.from) : accepted[accepted.length - 2];
  const to = opts.to ? store.find(opts.to) : accepted[accepted.length - 1];
  if (!from || !to) throw new Error("need two accepted snapshots (run `watch fetch` twice, or pass --from/--to)");
  const fromModel = buildModel(store.read(from.hash));
  const toModel = buildModel(store.read(to.hash));
  return { changes: diffModels(fromModel, toModel), fromModel, toModel };
}
