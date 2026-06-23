#!/usr/bin/env node
// Guard: fail the publish if any local `file:` dependency survives in a package.json —
// they must be replaced with published registry versions before release.
//
// A local `file:` dependency or a vendored `vendor/*.tgz` tarball is only valid during
// local development. Publishing with one still wired in would ship a broken dependency
// graph. This guard is chained ahead of the publish precheck (`npm run precheck-publish`),
// so the publish gate exits non-zero while ANY such artifact remains.
//
// Usage:
//   node scripts/check-no-vendored-deps.mjs            # check repo root (cwd)
//   node scripts/check-no-vendored-deps.mjs --root DIR # alternate root (tests)
// Exit 0 = clean (safe to publish). Exit 1 = vendoring still active.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SOT_MARKER = "Marlink"; // path fragment that flags a local source-tree dependency

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function detectVendoringDrift(rootDir) {
  const hits = [];

  // 1. vendored tarballs on disk
  const vendorDir = join(rootDir, "vendor");
  if (existsSync(vendorDir)) {
    const tgz = readdirSync(vendorDir).filter((f) => f.endsWith(".tgz"));
    if (tgz.length > 0) {
      hits.push(`vendor/ holds ${tgz.length} vendored tarball(s): ${tgz.join(", ")}`);
    }
  }

  // 2. root package.json: any @younndai dep/override resolved from a local file:
  const rootPkg = readJson(join(rootDir, "package.json"));
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "overrides"]) {
    const block = rootPkg[field] ?? {};
    for (const [name, spec] of Object.entries(block)) {
      if (typeof spec === "string" && name.startsWith("@younndai/") && spec.startsWith("file:")) {
        hits.push(`root package.json ${field}["${name}"] = "${spec}"`);
      }
    }
  }

  // 3. any publishable workspace dep reaching a local source tree or a vendored tarball
  for (const pattern of rootPkg.workspaces ?? []) {
    if (!pattern.endsWith("/*")) continue;
    const parent = join(rootDir, pattern.slice(0, -2));
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent)) {
      const pkgPath = join(parent, entry, "package.json");
      if (!existsSync(pkgPath)) continue;
      const pkg = readJson(pkgPath);
      for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
        for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
          if (typeof spec !== "string") continue;
          if (spec.includes(SOT_MARKER)) {
            hits.push(`${pkg.name} ${field}["${name}"] links into a local source tree: "${spec}"`);
          } else if (spec.startsWith("file:") && spec.includes("vendor")) {
            hits.push(`${pkg.name} ${field}["${name}"] points at a vendored tarball: "${spec}"`);
          }
        }
      }
    }
  }

  return hits;
}

function main() {
  const argv = process.argv.slice(2);
  const rootIdx = argv.indexOf("--root");
  const rootDir = rootIdx >= 0 && argv[rootIdx + 1] ? argv[rootIdx + 1] : process.cwd();

  const hits = detectVendoringDrift(rootDir);
  if (hits.length === 0) {
    console.log("vendoring guard: clean — no LOCAL-DEV vendoring artifacts present (safe to publish).");
    process.exit(0);
  }

  console.error("vendoring guard: BLOCKED — vendored file: deps are still present:");
  for (const h of hits) console.error(`  - ${h}`);
  console.error(
    "\nCleanup before publish: delete vendor/, remove the root @younndai `file:` deps + the " +
      '"//vendored-deps" key, restore the YON deps to real published versions, then `npm install`.\n' +
      "See the release checklist.",
  );
  process.exit(1);
}

main();
