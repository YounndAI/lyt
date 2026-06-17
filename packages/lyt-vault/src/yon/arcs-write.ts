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

// Hand-rolled writer for `arcs.yon` — the per-vault position-ordered
// narrative arcs index SoT (Lock 0.2). Counterpart to `arcs-read.ts`.
//
// Why hand-rolled: matches the `yon/lanes-write.ts` precedent (which in
// turn mirrored `yon/federation-write.ts` + `yon/ledger-write.ts`).
// `@younndai/yon-parser` runtime dep is deferred per project posture.
//
// Determinism contract: identical input → byte-identical output. Required
// for master-plan §v1.D.2a acceptance "position monotonic". The
// `last_touched` stamp is the only field allowed to drift across rebuilds
// — preserved via the caller-supplied `lastTouched` field rather than
// computed inline.
//
// Arc shape:
// @ARC rid=arc:<slug> | name="..." | category="..." | last_touched:ts=<iso>
// @ARC_MEMBER arc_rid=arc:<slug>
// | figment_rid="<vault-relative-posix-path>"
// | position:int=N
//
// Note on figment_rid: v1.D.2a stores figment_rid as a vault-relative
// POSIX path string (figments do NOT carry UUIDv7 rids in v1; the rid
// system for individual notes lands in v1.5 alongside the @TASK / @MARK
// surfaces). The column type adjusts to TEXT in the cache schema (see
// vault-db-migrations.ts arc_members) — when v1.5 ships figment rids,
// both YON shape and cache type evolve together with a clean migration.
// Same posture as v1.D.1a `@LANE_MEMBER.figment_rid` (v1.D.1 ).

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { escapeQuoted } from "./_helpers.js";

// Canonical per-vault SoT path for the position-ordered narrative arcs index.
// Lives under .lyt/indexes/ — gitignored at the directory level per the
// scaffold's `getVaultGitignore()` template; the SoT file itself is
// committed (overrides the .lyt/indexes/ rule by being explicitly named
// via the `!.lyt/indexes/arcs.yon` re-include — sibling of the
// `!.lyt/indexes/lanes.yon` rule landed in v1.D.1a Commit 1).
export function getArcsYonPath(vaultPath: string): string {
  return join(vaultPath, ".lyt", "indexes", "arcs.yon");
}

export interface ArcRecord {
  // Stable identifier within a vault. Convention: `arc:<slugified-name>`
  // where the slug derivation mirrors v1.D.1a's `slugifyTag` algorithm.
  ridSlug: string;
  // Human-readable arc name (rendered as quoted YON string).
  name: string;
  // Arc category. v1.D.2a default "uncategorized" when no manual @ARC
  // declaration provides a category; the rebuild flow surfaces a warning
  // (NOT a fatal error per the ratified default) when multiple figments declare
  // the same arc with different categories.
  category: string;
  // ISO 8601 timestamp of the most-recently-touched member figment
  // (max(mtime) across members per the ratified default). Caller-controlled to
  // preserve byte-stable round-trips in tests.
  lastTouched: string;
}

export interface ArcMemberRecord {
  // The arc this membership belongs to. Matches some `ArcRecord.ridSlug`.
  arcRidSlug: string;
  // Vault-relative POSIX path to the figment markdown file. See module
  // header for v1.5 evolution notes.
  figmentPath: string;
  // 1-based position within the arc. Manual @ARC_MEMBER records may
  // declare an explicit position; frontmatter-derived members get
  // auto-assigned positions in deterministic file-path lexical order
  // (skipping reserved-manual slots) per the ratified default.
  position: number;
}

export interface ArcsDoc {
  // The vault name (or any short identifier) the @DOC id reflects. Used
  // for cross-vault audits when handlers grep ledger snapshots.
  vaultName: string;
  arcs: readonly ArcRecord[];
  members: readonly ArcMemberRecord[];
}

// Render the doc to a deterministic UTF-8 string. Sort order:
// - Arcs: ascending by ridSlug.
// - Members: ascending by (arcRidSlug, position).
// Both sorts use stable comparators; deterministic across machines.
export function renderArcsYon(doc: ArcsDoc): string {
  const sortedArcs = [...doc.arcs].sort(compareArc);
  const sortedMembers = [...doc.members].sort(compareMember);

  const lines: string[] = [
    `@DOC ver=2.0 | id=arcs:${doc.vaultName} | domain=yai.lyt@1.0 | kind=cfg | profile=agent`,
    ``,
  ];

  for (const arc of sortedArcs) {
    lines.push(`@ARC rid=arc:${arc.ridSlug}`);
    lines.push(`  | name="${escapeQuoted(arc.name)}"`);
    lines.push(`  | category="${escapeQuoted(arc.category)}"`);
    lines.push(`  | last_touched:ts=${arc.lastTouched}`);
    lines.push(``);
  }

  for (const m of sortedMembers) {
    lines.push(`@ARC_MEMBER arc_rid=arc:${m.arcRidSlug}`);
    lines.push(`  | figment_rid="${escapeQuoted(m.figmentPath)}"`);
    lines.push(`  | position:int=${m.position}`);
    lines.push(``);
  }

  return lines.join("\n");
}

// Atomic-write contract per yon/lanes-write.ts precedent: write the full
// rendered body to a tmp file in the same directory, then `rename(2)` over
// the destination. Atomic across POSIX + NTFS (MOVEFILE_REPLACE_EXISTING).
// A crash mid-write leaves either the prior file or the new file; never
// a partial.
//
// Returns the absolute path of the destination so callers can chain a
// `lyt sync` post-pull cache upsert without re-deriving the location.
export function writeArcsDoc(vaultPath: string, doc: ArcsDoc): string {
  const target = getArcsYonPath(vaultPath);
  mkdirSync(dirname(target), { recursive: true });
  const body = renderArcsYon(doc);
  const tmpPath = `${target}.${process.pid}-${tmpCounter()}.tmp`;
  writeFileSync(tmpPath, body, "utf8");
  renameSync(tmpPath, target);
  return target;
}

// Per-process monotonic counter for tmp filenames — same idea as
// lanes-write.ts:tmpCounter (lets concurrent in-process writers avoid
// colliding on the tmp name).
let tmpCounterValue = 0;
function tmpCounter(): number {
  tmpCounterValue += 1;
  return tmpCounterValue;
}

function compareArc(a: ArcRecord, b: ArcRecord): number {
  if (a.ridSlug < b.ridSlug) return -1;
  if (a.ridSlug > b.ridSlug) return 1;
  return 0;
}

function compareMember(a: ArcMemberRecord, b: ArcMemberRecord): number {
  if (a.arcRidSlug < b.arcRidSlug) return -1;
  if (a.arcRidSlug > b.arcRidSlug) return 1;
  if (a.position < b.position) return -1;
  if (a.position > b.position) return 1;
  return 0;
}
