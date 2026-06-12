/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// D30.3 / OD-2 (2026-06-03) — bundled-patterns manifest. Maps each bundled
// pattern id → its semver `version` + a content `hash` (+ the set of
// `prior_hashes` shipped under older versions). The manifest is what lets
// `healPatterns` (pattern-paths.ts) distinguish three states of an installed
// pattern under `~/lyt/patterns/<id>/`:
//
// - hash === current bundled hash → "current" (no-op)
// - hash ∈ prior_hashes (pristine, older) → "replaced" (backup-then-replace)
// - hash ∉ {current} ∪ prior_hashes → "divergent" (user fork — LEAVE)
//
// The manifest is GENERATED (scripts/gen-patterns-manifest.mjs) and shipped at
// `src/patterns/manifest.yon` (→ `dist/patterns/manifest.yon` via
// copy-patterns.mjs). A unit test (pattern-manifest.test.ts) regenerates the
// hashes and asserts equality, so a pattern edited without regenerating the
// manifest — or a generator/runtime hash-algorithm drift — fails CI rather
// than shipping a manifest that silently lies (global coupled-constant rule).

export interface PatternManifestEntry {
  id: string;
  version: string;
  hash: string;
  priorHashes: string[];
}

export const PATTERN_MANIFEST_FILENAME = "manifest.yon";

// Content hash of a pattern directory. Deterministic + checkout-stable:
// - files walked recursively, relative paths normalised to POSIX `/`, sorted
// - text read as utf8 with CRLF→LF normalisation (so a Windows autocrlf
// checkout hashes identically to a LF checkout — the manifest is portable)
// - each entry contributes `<relpath>\0<normalised-content>\0`
//
// MUST stay byte-identical to the algorithm in
// scripts/gen-patterns-manifest.mjs — pattern-manifest.test.ts guards the pair.
export function hashPatternDir(dir: string): string {
  const files: string[] = [];
  const walk = (d: string): void => {
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

// Pull the `version="x.y.z"` field from a pattern.yon `@PATTERN` line.
export function readPatternVersion(patternYonPath: string): string | null {
  if (!existsSync(patternYonPath)) return null;
  const raw = readFileSync(patternYonPath, "utf8");
  const m = raw.match(/@PATTERN\b[^\n]*\bversion="([^"]+)"/);
  return m ? m[1]! : null;
}

export function renderPatternManifest(entries: readonly PatternManifestEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));
  const lines = [
    `@DOC ver=2.0 | id=lyt-patterns-manifest | title="Lyt bundled-patterns manifest" | domain=yai.lyt | kind=cfg | profile=agent`,
    ``,
  ];
  for (const e of sorted) {
    lines.push(
      `@PATTERN_MANIFEST id="${e.id}" | version="${e.version}" | hash="${e.hash}" | prior_hashes="${e.priorHashes.join(",")}"`,
    );
  }
  return lines.join("\n") + "\n";
}

export function parsePatternManifest(raw: string): PatternManifestEntry[] {
  const out: PatternManifestEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("@PATTERN_MANIFEST")) continue;
    const id = manifestField(line, "id");
    const version = manifestField(line, "version");
    const hash = manifestField(line, "hash");
    const prior = manifestField(line, "prior_hashes") ?? "";
    if (id === null || version === null || hash === null) continue;
    out.push({
      id,
      version,
      hash,
      priorHashes: prior
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    });
  }
  return out;
}

function manifestField(line: string, key: string): string | null {
  const m = line.match(new RegExp(`\\b${key}="([^"]*)"`));
  return m ? m[1]! : null;
}
