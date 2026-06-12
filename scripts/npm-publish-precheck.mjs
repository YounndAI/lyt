#!/usr/bin/env node
// npm publish dry-run precheck for the Lyt monorepo.
//
// For every publishable workspace (a package whose package.json does not set
// `private: true`), this script:
//   1. Reads the package.json and captures shape (files, bin, exports, main,
//      types, license, repository, keywords, engines, dependencies, README
//      inclusion).
//   2. Runs `npm pack --dry-run --json` and captures the would-be tarball
//      contents (file paths, total size, entry count).
//   3. Computes drift against the v1 publish contract: every publishable
//      package must have a LICENSE file on disk, a README.md on disk,
//      README.md in `files[]`, `engines.node` of `>=20.9`, a `repository.url`,
//      and every `bin` target must exist at the relative path it points to.
//
// Exits 0 if no drift; exits 1 with a structured drift report otherwise.
//
// Usage:
//   node scripts/npm-publish-precheck.mjs                # human report at repo root
//   node scripts/npm-publish-precheck.mjs --json         # machine-readable
//   node scripts/npm-publish-precheck.mjs --root <dir>   # alternate repo root (tests)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REQUIRED_NODE_ENGINE = ">=20.9";

function parseArgs(argv) {
  const args = { root: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && i + 1 < argv.length) {
      args.root = argv[++i];
    } else if (argv[i] === "--json") {
      args.json = true;
    }
  }
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function listPublishableWorkspaces(rootDir) {
  const rootPkg = readJson(join(rootDir, "package.json"));
  const patterns = rootPkg.workspaces ?? [];
  const dirs = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) continue;
    const parent = join(rootDir, pattern.slice(0, -2));
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent)) {
      const dir = join(parent, entry);
      const pkgPath = join(dir, "package.json");
      if (!existsSync(pkgPath)) continue;
      const pkg = readJson(pkgPath);
      if (pkg.private === true) continue;
      dirs.push({ dir, pkg });
    }
  }
  dirs.sort((a, b) => a.pkg.name.localeCompare(b.pkg.name));
  return dirs;
}

function npmPackDryRun(dir) {
  const stdout = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: dir,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

function capturePackageShape(dir, pkg) {
  return {
    name: pkg.name,
    version: pkg.version,
    main: pkg.main ?? null,
    types: pkg.types ?? null,
    license: pkg.license ?? null,
    repository: pkg.repository ?? null,
    keywords: pkg.keywords ?? [],
    engines: pkg.engines ?? {},
    files: pkg.files ?? [],
    bin: pkg.bin ?? {},
    exports: pkg.exports ?? null,
    dependencies: pkg.dependencies ?? {},
    peerDependencies: pkg.peerDependencies ?? {},
    readmeOnDisk: existsSync(join(dir, "README.md")),
    licenseOnDisk: existsSync(join(dir, "LICENSE")),
    readmeInFiles: (pkg.files ?? []).includes("README.md"),
    licenseInFiles: (pkg.files ?? []).includes("LICENSE"),
  };
}

function detectDrift(dir, shape) {
  const drift = [];
  if (!shape.licenseOnDisk) drift.push({ kind: "missing-license-file", detail: "LICENSE missing in package directory" });
  if (!shape.readmeOnDisk) drift.push({ kind: "missing-readme-file", detail: "README.md missing in package directory" });
  if (!shape.readmeInFiles) drift.push({ kind: "readme-not-in-files", detail: "README.md not listed in package.json files[]" });
  if (shape.engines?.node !== REQUIRED_NODE_ENGINE) {
    drift.push({
      kind: "engines-node-mismatch",
      detail: `engines.node is ${JSON.stringify(shape.engines?.node ?? null)}, expected ${JSON.stringify(REQUIRED_NODE_ENGINE)}`,
    });
  }
  if (!shape.repository || !shape.repository.url) {
    drift.push({ kind: "missing-repository-url", detail: "repository.url is not set" });
  }
  for (const [binName, binPath] of Object.entries(shape.bin)) {
    const resolved = resolve(dir, binPath);
    if (!existsSync(resolved)) {
      drift.push({
        kind: "bin-target-missing",
        detail: `bin "${binName}" points to ${binPath}, but ${relative(dir, resolved)} does not exist (run \`npm run build\`?)`,
      });
    }
  }
  return drift;
}

export function runPrecheck({ rootDir }) {
  const workspaces = listPublishableWorkspaces(rootDir);
  const reports = [];
  for (const { dir, pkg } of workspaces) {
    const shape = capturePackageShape(dir, pkg);
    let pack = null;
    let packError = null;
    try {
      const raw = npmPackDryRun(dir);
      pack = {
        filename: raw.filename ?? null,
        entryCount: raw.entryCount ?? null,
        size: raw.size ?? null,
        unpackedSize: raw.unpackedSize ?? null,
        files: Array.isArray(raw.files) ? raw.files.map((f) => f.path) : [],
      };
    } catch (err) {
      packError = err instanceof Error ? err.message : String(err);
    }
    const drift = detectDrift(dir, shape);
    if (packError) drift.push({ kind: "npm-pack-failed", detail: packError });
    reports.push({ dir: relative(rootDir, dir), shape, pack, drift });
  }
  const totalDrift = reports.reduce((n, r) => n + r.drift.length, 0);
  return { ok: totalDrift === 0, totalDrift, workspaceCount: reports.length, reports };
}

function formatHuman(result) {
  const lines = [];
  lines.push(`npm publish precheck — ${result.workspaceCount} publishable workspace(s)`);
  lines.push("");
  for (const r of result.reports) {
    const marker = r.drift.length === 0 ? "[ok]" : `[drift x${r.drift.length}]`;
    lines.push(`${marker} ${r.shape.name}@${r.shape.version}  (${r.dir})`);
    if (r.pack) {
      lines.push(`       tarball ${r.pack.filename} · ${r.pack.entryCount} entries · ${r.pack.unpackedSize} bytes unpacked`);
    }
    for (const d of r.drift) {
      lines.push(`       - ${d.kind}: ${d.detail}`);
    }
  }
  lines.push("");
  if (result.ok) {
    lines.push("clean: 0 drift detected, all workspaces publish-ready.");
  } else {
    lines.push(`drift: ${result.totalDrift} issue(s) detected across ${result.reports.filter((r) => r.drift.length > 0).length} workspace(s).`);
  }
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = args.root ? resolve(args.root) : process.cwd();
  const result = runPrecheck({ rootDir });
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(formatHuman(result) + "\n");
  }
  process.exit(result.ok ? 0 : 1);
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main();
}
