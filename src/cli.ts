#!/usr/bin/env node
import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { scan, SCANNER_VERSION } from "./scan.js";
import { assertSafeToUpload, redactLocations } from "./manifest/schema.js";
import { registerWatch } from "./watcher/cli.js";

const program = new Command();
program
  .name("arcdrip")
  .description("Map a repo's third-party API dependencies into a manifest")
  .version(SCANNER_VERSION);

program
  .command("scan", { isDefault: true })
  .argument("[dir]", "repo root", ".")
  .option("-o, --out <file>", "write manifest JSON here (default: stdout)")
  .option("--redact-paths", "strip file locations, as the upload path does", false)
  .option("--budget <seconds>", "time budget", "300")
  .option("--include-tests", "also scan test files (off by default)", false)
  .action((dir: string, opts: { out?: string; redactPaths: boolean; budget: string; includeTests: boolean }) => {
    let manifest = scan({ rootDir: dir, budgetMs: Number(opts.budget) * 1000, includeTests: opts.includeTests });
    if (opts.redactPaths) manifest = redactLocations(manifest);
    assertSafeToUpload(manifest);

    const json = JSON.stringify(manifest, null, 2);
    if (opts.out) {
      writeFileSync(opts.out, json);
      console.error(`[arcdrip] wrote ${opts.out}`);
    } else {
      console.log(json);
    }

    const { t1, t2, t3 } = manifest.coverage;
    console.error(`[arcdrip] coverage t1=${t1} t2=${t2} t3=${t3} partial=${manifest.partial}`);
  });

registerWatch(program);

program
  .command("action")
  .description("run the GitHub Action logic locally (prints what it would report; no GitHub calls)")
  .argument("[dir]", "repo root", ".")
  .option("--data <dir>", "data directory", ".arcdrip-action")
  .option("--seed-ref <ref>", "baseline spec ref for the first run")
  .option("--include-tests", "also scan test files", false)
  .action(async (dir: string, opts: { data: string; seedRef?: string; includeTests: boolean }) => {
    const { runAction } = await import("./action/main.js");
    await runAction({ workspace: dir, dataDir: opts.data, seedRef: opts.seedRef, includeTests: opts.includeTests, budgetSeconds: 300, local: true });
  });

program.parseAsync(process.argv).catch((err) => {
  // Local CLI may fail loudly. The GitHub Action wrapper (Week 5) must NOT —
  // it catches everything and exits 0.
  console.error(`[arcdrip] ${(err as Error).message}`);
  process.exit(1);
});
