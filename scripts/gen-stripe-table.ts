/**
 * Regenerate src/detectors/stripe-operations.bundled.json from the stripe
 * package installed in THIS repo. Run after bumping the stripe devDependency:
 *   npm run gen:stripe-table
 * The bundled table is the fallback for code that imports the SDK without
 * node_modules (Deno `npm:stripe`, esm.sh). Installed SDKs always win.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveOperations } from "../src/detectors/stripe-sdk-table.js";

const here = dirname(fileURLToPath(import.meta.url));
const sdkRoot = join(here, "..", "node_modules", "stripe");
const version = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")).version as string;
const table = deriveOperations(sdkRoot);
if (!table) throw new Error(`could not derive operations from ${sdkRoot}`);

const out = {
  generatedFrom: `stripe@${version}`,
  operations: Object.fromEntries([...table.entries()].sort(([a], [b]) => a.localeCompare(b))),
};
const target = join(here, "..", "src", "detectors", "stripe-operations.bundled.json");
writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
console.log(`[gen] ${table.size} operations from stripe@${version} -> ${target}`);
