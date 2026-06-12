// Copy src/help/topics/*.md into dist/help/topics/ so the published `dist/`
// tarball contains the topic files at the path the loader expects.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "..", "src", "help", "topics");
const dest = resolve(here, "..", "dist", "help", "topics");

if (!existsSync(src)) {
  console.error("[copy-help-topics] src directory missing, nothing to copy");
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.error(`[copy-help-topics] ${src} -> ${dest}`);
