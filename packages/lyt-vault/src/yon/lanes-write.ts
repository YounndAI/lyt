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

// Hand-rolled writer for `lanes.yon` — the per-vault tag-frequency lanes
// index SoT (Lock 0.2). Counterpart to `lanes-read.ts`.
//
// Why hand-rolled: matches the `yon/federation-write.ts` + `yon/vault.ts`
// precedent. `@younndai/yon-parser` runtime dep is deferred to v1.A.3+
// per project posture.
//
// Determinism contract: identical input → byte-identical output. Required
// for master-plan §v1.D.1a acceptance "deterministic membership across
// invocations on same input". The `last_built` stamp is the ONLY field
// allowed to drift across rebuilds — preserved via the caller-supplied
// `lastBuiltAt` field rather than computed inline.
//
// Lane shape:
// @LANE rid=lane:<slug> | name="..." | source_keywords=["t1","t2"]
//  | mem_count:int=N | last_built:ts=<iso>
// @LANE_MEMBER lane_rid=lane:<slug>
//  | figment_rid="<vault-relative-posix-path>"
//
// Note on figment_rid: v1.D.1a stores figment_rid as a vault-relative
// POSIX path string (figments do NOT carry UUIDv7 rids in v1; the rid
// system for individual notes lands in v1.5 alongside the @TASK / @MARK
// surfaces). The column type adjusts to TEXT in the cache schema (see
// vault-db-migrations.ts lane_members) — when v1.5 ships figment rids,
// both YON shape and cache type evolve together with a clean migration.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { escapeQuoted } from "./_helpers.js";

// Canonical per-vault SoT path for the tag-frequency lanes index.
// Lives under .lyt/indexes/ — gitignored at the directory level per the
// scaffold's `getVaultGitignore()` template; the SoT file itself is
// committed (overrides the .lyt/indexes/ rule by being explicitly named).
// Same posture as `.lyt/indexes/` housing the libSQL caches: directory
// gitignored, the explicit SoT file paths re-included by the scaffold's
// `!.lyt/indexes/lanes.yon` rule (added to the gitignore template
// alongside the existing `!.lyt/ledgers/` re-include).
export function getLanesYonPath(vaultPath: string): string {
  return join(vaultPath, ".lyt", "indexes", "lanes.yon");
}

export interface LaneRecord {
  // Stable identifier within a vault. Convention: `lane:<slugified-keyword>`
  // for v1.D.1a single-keyword lanes; v1.D.2+ may evolve to multi-keyword
  // composite slugs.
  ridSlug: string;
  // Human-readable lane name (rendered as quoted YON string).
  name: string;
  // Source keywords clustered into this lane. v1.D.1a emits single-element
  // arrays (one lane per tag with ≥threshold members); the array shape is
  // forward-compatible with multi-keyword co-occurrence clustering.
  sourceKeywords: readonly string[];
  // Number of figments that belong to this lane.
  memCount: number;
  // ISO 8601 timestamp the lane was last rebuilt. Caller-controlled to
  // preserve byte-stable round-trips in tests.
  lastBuilt: string;
}

export interface LaneMemberRecord {
  // The lane this membership belongs to. Matches some `LaneRecord.ridSlug`.
  laneRidSlug: string;
  // Vault-relative POSIX path to the figment markdown file. See module
  // header for v1.5 evolution notes.
  figmentPath: string;
}

export interface LanesDoc {
  // The vault name (or any short identifier) the @DOC id reflects. Used
  // for cross-vault audits when handlers grep ledger snapshots.
  vaultName: string;
  lanes: readonly LaneRecord[];
  members: readonly LaneMemberRecord[];
}

// Render the doc to a deterministic UTF-8 string. Sort order:
// - Lanes: ascending by ridSlug.
// - Members: ascending by (laneRidSlug, figmentPath).
// Both sorts use plain string < comparison; stable across machines.
export function renderLanesYon(doc: LanesDoc): string {
  const sortedLanes = [...doc.lanes].sort(compareLane);
  const sortedMembers = [...doc.members].sort(compareMember);

  const lines: string[] = [
    `@DOC ver=2.0 | id=lanes:${doc.vaultName} | domain=yai.lyt@1.0 | kind=cfg | profile=agent`,
    ``,
  ];

  for (const lane of sortedLanes) {
    lines.push(`@LANE rid=lane:${lane.ridSlug}`);
    lines.push(`  | name="${escapeQuoted(lane.name)}"`);
    lines.push(`  | source_keywords=[${renderStringList(lane.sourceKeywords)}]`);
    lines.push(`  | mem_count:int=${lane.memCount}`);
    lines.push(`  | last_built:ts=${lane.lastBuilt}`);
    lines.push(``);
  }

  for (const m of sortedMembers) {
    lines.push(`@LANE_MEMBER lane_rid=lane:${m.laneRidSlug}`);
    lines.push(`  | figment_rid="${escapeQuoted(m.figmentPath)}"`);
    lines.push(``);
  }

  return lines.join("\n");
}

function renderStringList(items: readonly string[]): string {
  return items.map((s) => `"${escapeQuoted(s)}"`).join(",");
}

// Atomic-write contract per yon/ledger-write.ts precedent: write the full
// rendered body to a tmp file in the same directory, then `rename(2)` over
// the destination. Atomic across POSIX + NTFS (MOVEFILE_REPLACE_EXISTING).
// A crash mid-write leaves either the prior file or the new file; never
// a partial.
//
// Returns the absolute path of the destination so callers can chain a
// `.lyt sync` post-pull cache upsert without re-deriving the location.
export function writeLanesDoc(vaultPath: string, doc: LanesDoc): string {
  const target = getLanesYonPath(vaultPath);
  mkdirSync(dirname(target), { recursive: true });
  const body = renderLanesYon(doc);
  const tmpPath = `${target}.${process.pid}-${tmpCounter()}.tmp`;
  writeFileSync(tmpPath, body, "utf8");
  renameSync(tmpPath, target);
  return target;
}

// Per-process monotonic counter for tmp filenames — same idea as
// ledger-write.ts:tmpCounter (lets concurrent in-process writers avoid
// colliding on the tmp name).
let tmpCounterValue = 0;
function tmpCounter(): number {
  tmpCounterValue += 1;
  return tmpCounterValue;
}

function compareLane(a: LaneRecord, b: LaneRecord): number {
  if (a.ridSlug < b.ridSlug) return -1;
  if (a.ridSlug > b.ridSlug) return 1;
  return 0;
}

function compareMember(a: LaneMemberRecord, b: LaneMemberRecord): number {
  if (a.laneRidSlug < b.laneRidSlug) return -1;
  if (a.laneRidSlug > b.laneRidSlug) return 1;
  if (a.figmentPath < b.figmentPath) return -1;
  if (a.figmentPath > b.figmentPath) return 1;
  return 0;
}
