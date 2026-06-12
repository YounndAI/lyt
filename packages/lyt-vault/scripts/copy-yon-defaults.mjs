// Copy src/scaffold/defaults/ into dist/scaffold/defaults/ so the published
// tarball ships the bundled @AUTOMATOR (and future @DIRECTIVE / @MEMSCOPE)
// YON reference declarations that `lyt vault init` / `lyt vault adopt` copy
// into a fresh vault's .lyt/automators/ etc.
//
// Block-A.3 Commit 10: metadata-filler.yon (arc §6.13 Example 1).
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "..", "src", "scaffold", "defaults");
const dest = resolve(here, "..", "dist", "scaffold", "defaults");

if (!existsSync(src)) {
  console.error("[copy-yon-defaults] src directory missing, nothing to copy");
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.error(`[copy-yon-defaults] ${src} -> ${dest}`);
