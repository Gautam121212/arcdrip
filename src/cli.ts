#!/usr/bin/env node
import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { scan, SCANNER_VERSION } from "./scan.js";
import { assertSafeToUpload, redactLocations } from "./manifest/schema.js";

const program = new Command();
program
  .name("arcdrip")
  .description("Map a repo's third-party API dependencies into a manifest")
  .version(SCANNER_VERSION);

program
  .command("scan")
  .argument("[dir]", "repo root", ".")
  .option("-o, --out <file>", "write manifest JSON here (default: stdout)")
  .option("--redact-paths", "strip file locations, as the upload path does", false)
  .option("--budget <seconds>", "time budget", "300")
  .action((dir: string, opts: { out?: string; redactPaths: boolean; budget: string }) => {
    let manifest = scan({ rootDir: dir, budgetMs: Number(opts.budget) * 1000 });
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

program.parseAsync(process.argv).catch((err) => {
  // Local CLI may fail loudly. The GitHub Action wrapper (Week 5) must NOT —
  // it catches everything and exits 0.
  console.error(`[arcdrip] ${(err as Error).message}`);
  process.exit(1);
});
