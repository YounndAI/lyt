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

// Phase C (UNIT 4) — README managed-block init-once flow.
//
// MIRRORS flows/agents-md-regen.ts. The README has a SINGLE Lyt-managed region
// bounded by LYT_README_BEGIN / LYT_README_END markers (the template ships them;
// see templates/README.md). Everything OUTSIDE the markers — including the H1
// title — is the handler's prose and is NEVER touched.
//
// CONTRACT (SC4 — README present-from-birth, init-once v1):
//   • At init: a managed-block README is written (regenReadme writes-if-absent).
//   • Marker-bounded regen: when the file is PRESENT and carries the markers,
//     ONLY the bytes between them are replaced (diff-guarded — a no-op write is
//     skipped so re-running is idempotent and never churns git).
//   • When the file is PRESENT but has NO markers (a hand-authored README), it is
//     left UNTOUCHED — no surprise-edit (same posture as regenInstalledPrimerSection).
//   • doctor v1 only WARNS if the README is missing; it does NOT auto-recreate
//     (surface-don't-act; the git-tombstone primitive that would distinguish a
//     deliberate delete is deferred to a later lane). See checkReadmePresent.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getReadmeContent } from "../templates/index.js";

// Delimiters marking the Lyt-managed region in a vault README. Kept BYTE-
// IDENTICAL to the markers shipped in templates/README.md — the regen
// chokepoint locates the block by these literals.
export const README_MANAGED_BEGIN = "<!-- LYT_README_BEGIN -->";
export const README_MANAGED_END = "<!-- LYT_README_END -->";

export interface RegenReadmeResult {
  path: string;
  /** True when the file was created or its managed block changed on disk. */
  written: boolean;
  /** Why nothing was written, when `written` is false (diagnostic only). */
  skippedReason?: "up-to-date" | "no-markers";
}

/**
 * Extract the Lyt-managed region (the text BETWEEN the markers, exclusive) from
 * a freshly-rendered template, so an existing README's block can be replaced
 * with the canonical content while preserving the handler's surrounding prose.
 *
 * @returns the inner block (including the leading/trailing newlines that hug the
 *          markers) or null if the template is malformed (markers absent).
 */
function extractManagedInner(rendered: string): string | null {
  const b = rendered.indexOf(README_MANAGED_BEGIN);
  const e = rendered.indexOf(README_MANAGED_END);
  if (b < 0 || e < 0 || e <= b) return null;
  return rendered.slice(b + README_MANAGED_BEGIN.length, e);
}

/**
 * Init-once + marker-bounded README regen for a vault.
 *
 * - Absent → write the full template (markers + boilerplate + the handler's H1).
 * - Present WITH markers → replace ONLY the managed block; diff-guard the write.
 * - Present WITHOUT markers → leave untouched (no surprise-edit).
 */
export function regenReadme(vaultPath: string, vaultName: string): RegenReadmeResult {
  const path = join(vaultPath, "README.md");
  const rendered = getReadmeContent(vaultName);

  if (!existsSync(path)) {
    writeFileSync(path, rendered, "utf8");
    return { path, written: true };
  }

  const existing = readFileSync(path, "utf8");
  const beginIdx = existing.indexOf(README_MANAGED_BEGIN);
  const endIdx = existing.indexOf(README_MANAGED_END);
  if (beginIdx < 0 || endIdx < 0 || endIdx <= beginIdx) {
    // Hand-authored / pre-Phase-C README without markers — never surprise-edit.
    return { path, written: false, skippedReason: "no-markers" };
  }

  const canonicalInner = extractManagedInner(rendered);
  if (canonicalInner === null) {
    // The template itself lost its markers — refuse to clobber the user file.
    return { path, written: false, skippedReason: "no-markers" };
  }

  const before = existing.slice(0, beginIdx + README_MANAGED_BEGIN.length);
  const after = existing.slice(endIdx);
  const next = before + canonicalInner + after;
  if (next === existing) {
    return { path, written: false, skippedReason: "up-to-date" };
  }
  writeFileSync(path, next, "utf8");
  return { path, written: true };
}

export interface ReadmePresenceCheck {
  present: boolean;
  hasMarkers: boolean;
  path: string;
}

/**
 * doctor v1 helper: report whether a vault has a README (and whether it carries
 * the Lyt-managed markers). doctor WARNS on `present === false`; it does NOT
 * auto-recreate — surface-don't-act, honoring the byte-region promise (a
 * deliberate delete is the handler's to make; the git-tombstone primitive that
 * would distinguish it is deferred).
 */
export function checkReadmePresent(vaultPath: string): ReadmePresenceCheck {
  const path = join(vaultPath, "README.md");
  if (!existsSync(path)) {
    return { present: false, hasMarkers: false, path };
  }
  const raw = readFileSync(path, "utf8");
  const hasMarkers = raw.includes(README_MANAGED_BEGIN) && raw.includes(README_MANAGED_END);
  return { present: true, hasMarkers, path };
}
