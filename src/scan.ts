import { Project } from "ts-morph";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertManifest, SCHEMA_VERSION, type Manifest, type ProviderSection } from "./manifest/schema.js";
import { detectStripe, PROVIDER as STRIPE } from "./detectors/stripe.js";

export const SCANNER_VERSION = "0.1.0";

export interface ScanOptions {
  rootDir: string;
  /** Wall-clock budget for the whole scan. On overrun: mark partial, keep what we have. */
  budgetMs?: number;
  /** Extra file globs to include (relative to rootDir). Defaults to all TS/JS outside node_modules. */
  include?: string[];
}

type Detector = (project: Project, rootDir: string) => ProviderSection;
const DETECTORS: Record<string, Detector> = {
  [STRIPE]: detectStripe,
};

export function scan(opts: ScanOptions): Manifest {
  const rootDir = resolve(opts.rootDir);
  const budgetMs = opts.budgetMs ?? 5 * 60 * 1000;
  const started = Date.now();
  let partial = false;

  const project = createProject(rootDir, opts.include);

  const providers: Record<string, ProviderSection> = {};
  for (const [name, detect] of Object.entries(DETECTORS)) {
    if (Date.now() - started > budgetMs) {
      partial = true;
      break;
    }
    try {
      const section = detect(project, rootDir);
      if (section.entries.length > 0 || section.pinned_version || section.sdk) providers[name] = section;
    } catch (err) {
      // A detector must never take the scan down. Record degradation, move on.
      partial = true;
      console.error(`[arcdrip] detector ${name} failed: ${(err as Error).message}`);
    }
  }

  const coverage = { t1: 0, t2: 0, t3: 0 };
  for (const p of Object.values(providers)) {
    for (const e of p.entries) coverage[`t${e.tier}` as keyof typeof coverage]++;
  }

  const manifest: Manifest = {
    schema: SCHEMA_VERSION,
    repo_id: repoId(rootDir),
    scanner_version: SCANNER_VERSION,
    scanned_at: new Date().toISOString(),
    partial,
    providers,
    coverage,
  };
  return assertManifest(manifest);
}

function createProject(rootDir: string, include?: string[]): Project {
  const tsconfig = join(rootDir, "tsconfig.json");
  const project = existsSync(tsconfig)
    ? new Project({ tsConfigFilePath: tsconfig, skipAddingFilesFromTsConfig: true })
    : new Project({ compilerOptions: { allowJs: true, checkJs: false, skipLibCheck: true } });

  const globs = include ?? ["**/*.{ts,tsx,js,jsx,mts,cts}"];
  project.addSourceFilesAtPaths([
    ...globs.map((g) => join(rootDir, g)),
    `!${join(rootDir, "**/node_modules/**")}`,
    `!${join(rootDir, "**/dist/**")}`,
    `!${join(rootDir, "**/build/**")}`,
    `!${join(rootDir, "**/*.d.ts")}`,
  ]);
  return project;
}

/** Opaque, stable repo identity. Prefers the git remote (hashed); falls back to the path (hashed). Never the name itself. */
function repoId(rootDir: string): string {
  let seed = rootDir;
  try {
    const cfg = readFileSync(join(rootDir, ".git", "config"), "utf8");
    const m = cfg.match(/url\s*=\s*(.+)/);
    if (m) seed = m[1].trim();
  } catch {
    /* not a git repo; path is fine locally */
  }
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}
