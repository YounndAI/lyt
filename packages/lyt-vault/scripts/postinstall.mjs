// Postinstall: copy bundled patterns from this package's dist/patterns/ to
// ~/lyt/patterns/<name>/ if the target does not exist. Preserves user customizations
// (skip + warn if a directory already exists at the target). Documented in
// `lyt help patterns`.
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
// In the published tarball, scripts/postinstall.mjs sits next to dist/. In a local
// `npm install` of the workspace, the same layout holds.
const bundled = resolve(here, "..", "dist", "patterns");

if (!existsSync(bundled)) {
  // Build hasn't run yet (dev install before build). Silent skip — postinstall is
  // best-effort, not load-bearing for the build.
  process.exit(0);
}

const userHome = process.env.LYT_HOME ?? join(homedir(), "lyt");
const target = join(userHome, "patterns");
mkdirSync(target, { recursive: true });

const names = readdirSync(bundled).filter((n) => {
  const full = join(bundled, n);
  return statSync(full).isDirectory();
});

for (const name of names) {
  const sourceDir = join(bundled, name);
  const targetDir = join(target, name);
  // Skip ONLY if a REAL (populated) pattern is already installed — preserves user
  // customizations. A hollow dir (exists but missing pattern.yon) is broken, not a
  // customization, so we (re)seed it; cpSync merges into the existing empty dir.
  // 2026-06-16: a pre-existing empty ~/lyt/patterns/<name> (left by a prior
  // install/init) made every upgrade skip the seed via the old `existsSync(targetDir)`
  // guard, leaving `lyt capture`/`recall` dead pod-wide with no auto-recovery.
  if (existsSync(join(targetDir, "pattern.yon"))) {
    console.log(`[lyt postinstall] skip ${name} (already installed — user customization preserved)`);
    continue;
  }
  cpSync(sourceDir, targetDir, { recursive: true });
  console.log(`[lyt postinstall] installed ${name} -> ${targetDir}`);
}
