// Copy src/patterns/*/ into dist/patterns/ so the published tarball ships the
// 4 default patterns at the location the postinstall hook expects.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "..", "src", "patterns");
const dest = resolve(here, "..", "dist", "patterns");

if (!existsSync(src)) {
  console.error("[copy-patterns] src directory missing, nothing to copy");
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.error(`[copy-patterns] ${src} -> ${dest}`);
