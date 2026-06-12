// Regenerate src/patterns/manifest.yon from the bundled pattern dirs.
//
// D30.3 / OD-2 — the manifest records each pattern's id → version → content
// hash (+ prior shipped hashes). `healPatterns` uses it to tell a pristine
// install (safe to backup-then-replace) from a user fork (leave untouched).
//
// Run:  node ./scripts/gen-patterns-manifest.mjs
//
// Prior-hash carry-forward: when a pattern's content hash CHANGES vs the
// existing manifest, the OLD hash is appended to that pattern's prior_hashes
// (so an installed older-pristine copy is still recognised as replaceable).
//
// The hash algorithm here MUST stay byte-identical to hashPatternDir() in
// src/util/pattern-manifest.ts — pattern-manifest.test.ts asserts the
// checked-in manifest matches the TS-computed hashes, which fails CI if the
// two algorithms ever drift.
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const patternsDir = resolve(here, "..", "src", "patterns");
const manifestPath = join(patternsDir, "manifest.yon");

function hashPatternDir(dir) {
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) files.push(full);
    }
  };
  walk(dir);
  const rels = files.map((f) => relative(dir, f).split(sep).join("/")).sort();
  const h = createHash("sha256");
  for (const rel of rels) {
    const content = readFileSync(join(dir, rel.split("/").join(sep)), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    h.update(rel, "utf8");
    h.update("\0");
    h.update(content, "utf8");
    h.update("\0");
  }
  return h.digest("hex");
}

function readPatternVersion(patternYonPath) {
  if (!existsSync(patternYonPath)) return null;
  const raw = readFileSync(patternYonPath, "utf8");
  const m = raw.match(/@PATTERN\b[^\n]*\bversion="([^"]+)"/);
  return m ? m[1] : null;
}

function manifestField(line, key) {
  const m = line.match(new RegExp(`\\b${key}="([^"]*)"`));
  return m ? m[1] : null;
}

function parseExisting(raw) {
  const out = new Map();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("@PATTERN_MANIFEST")) continue;
    const id = manifestField(line, "id");
    if (id === null) continue;
    out.set(id, {
      version: manifestField(line, "version") ?? "",
      hash: manifestField(line, "hash") ?? "",
      priorHashes: (manifestField(line, "prior_hashes") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });
  }
  return out;
}

if (!existsSync(patternsDir)) {
  console.error(`[gen-patterns-manifest] no patterns dir at ${patternsDir}`);
  process.exit(1);
}

const existing = existsSync(manifestPath)
  ? parseExisting(readFileSync(manifestPath, "utf8"))
  : new Map();

const ids = readdirSync(patternsDir)
  .filter((name) => {
    const full = join(patternsDir, name);
    return statSync(full).isDirectory() && existsSync(join(full, "pattern.yon"));
  })
  .sort();

const lines = [
  `@DOC ver=2.0 | id=lyt-patterns-manifest | title="Lyt bundled-patterns manifest" | domain=yai.lyt | kind=cfg | profile=agent`,
  ``,
];
for (const id of ids) {
  const dir = join(patternsDir, id);
  const version = readPatternVersion(join(dir, "pattern.yon")) ?? "0.0.0";
  const hash = hashPatternDir(dir);
  const prev = existing.get(id);
  let prior = prev ? [...prev.priorHashes] : [];
  if (prev && prev.hash && prev.hash !== hash && !prior.includes(prev.hash)) {
    prior.push(prev.hash); // carry the now-superseded hash forward
  }
  lines.push(
    `@PATTERN_MANIFEST id="${id}" | version="${version}" | hash="${hash}" | prior_hashes="${prior.join(",")}"`,
  );
}

writeFileSync(manifestPath, lines.join("\n") + "\n", "utf8");
console.error(`[gen-patterns-manifest] wrote ${manifestPath} (${ids.length} patterns)`);
