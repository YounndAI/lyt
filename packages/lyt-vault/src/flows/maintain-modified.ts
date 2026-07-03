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

// Phase A (UNIT 3 / C4) — maintain the figment `modified` frontmatter field on a
// content change, keying `modified` off the file's fs-mtime while leaving
// `created` untouched. This is the write / `sync --watch`-path maintainer.
//
// THE LOOP HAZARD + THE FIX: naively re-stamping `modified` from mtime is a
// self-perpetuating loop — the stamp WRITES the file, which bumps mtime, which
// (under a watcher) fires another change event, which re-stamps a NEWER mtime,
// forever. Two guards make this convergent:
//   1. WHOLE-SECOND mtime. `modified` is stamped to the file's mtime FLOORED to
//      the second (`.000Z`). The write-back bumps the real mtime by a few
//      millis, but the FLOORED second is unchanged within the same second, so a
//      re-run in the same second is a byte-identical no-op (idempotent).
//   2. NO-CHANGE SKIP. The maintainer only stamps when the frontmatter
//      `modified` differs from the (clamped) floored mtime; if they already
//      match it returns `changed:false` and does NOT write. The caller
//      (sync-watch) ALSO drops a self-triggered change via a per-path
//      last-stamped-mtime guard (MJ-3) so the immediate self-write event is
//      absorbed before it ever reaches here.
//
// MJ-1 (`modified >= created`): the stamp is FLOORED to the whole second, but
// `created` carries full millisecond precision. An edit in the SAME wall-clock
// second as `created` (e.g. created 10:00:00.742Z, mtime floored 10:00:00.000Z)
// would otherwise write a `modified` that PRECEDES `created` — a contract
// violation. We clamp: the stamped `modified` is never earlier than `created`.
//
// RESILIENCE: never throws to its caller. A missing file, unreadable content,
// or a figment with no `modified` field (scaffold seeds, non-contract markdown)
// is a `changed:false` no-op — the markdown SoT is never corrupted.

import { readFileSync, statSync, writeFileSync } from "node:fs";

import { stampModifiedFrontmatter, readFrontmatterDates } from "../templates/contract.js";

export interface MaintainModifiedResult {
  /** True when the file's `modified` frontmatter was advanced + rewritten. */
  changed: boolean;
  /** The ISO value written (or the existing one when unchanged); null on no-op. */
  modifiedIso: string | null;
  /**
   * MJ-3 — the file's floored-second fs-mtime (ms) measured AFTER the stamp
   * write-back. The caller records this as the "last self-stamp" watermark; the
   * self-triggered change event carries this same floored mtime, so the caller
   * drops it (absorbing the write-back echo). Present whenever a stamp landed
   * (changed:true); null on a no-op.
   */
  stampedMtimeMs: number | null;
}

/**
 * Floor an mtime to whole seconds and render it as ISO-8601 (`...000Z`). The
 * floor is the loop guard: within one wall-clock second the value is stable, so
 * the write-back (which bumps the real mtime by a few millis) does not change
 * the stamped value on a re-run.
 *
 * Minor (index normalizeIso divergence): `new Date(...).toISOString()` produces
 * the SAME canonical form the FTS `normalizeIso` (Date.parse → toISOString)
 * yields, so the value stamped here round-trips byte-identically through the
 * index read-back — the index never sees a "different" normalized form and so
 * never triggers a spurious re-stamp.
 */
export function mtimeToFlooredIso(mtimeMs: number): string {
  return new Date(Math.floor(mtimeMs / 1000) * 1000).toISOString();
}

/**
 * Advance the `modified` frontmatter of the figment at `absPath` to its
 * fs-mtime (floored to the second, clamped to `>= created`), preserving
 * `created`. No-op (changed:false) when the figment has no `modified` field or
 * it already matches. Never throws.
 *
 * @param absPath absolute path to the figment on disk.
 */
export function maintainModifiedFromMtime(absPath: string): MaintainModifiedResult {
  let raw: string;
  let mtimeMs: number;
  try {
    const st = statSync(absPath);
    mtimeMs = st.mtimeMs;
    raw = readFileSync(absPath, "utf8");
  } catch {
    return { changed: false, modifiedIso: null, stampedMtimeMs: null };
  }

  const { created, modified } = readFrontmatterDates(raw);
  // No `modified` field to maintain (scaffold seed / non-contract markdown) →
  // leave it alone. This maintainer NEVER fabricates a field the writer didn't
  // emit; backfilling missing frontmatter is Phase C/D's job.
  if (modified === null) return { changed: false, modifiedIso: null, stampedMtimeMs: null };

  const flooredMs = Math.floor(mtimeMs / 1000) * 1000;
  let stampIso = new Date(flooredMs).toISOString();

  // MJ-1 — never let the floored `modified` precede the full-precision `created`.
  // (An edit in the same wall-clock second as `created` floors below it.)
  // Clamp to the NORMALIZED created value (Date → toISOString), not the raw
  // frontmatter string: a date-only `created` (e.g. "2026-07-01") would
  // otherwise be written verbatim into `modified`, emitting it at a coarser
  // (date-only) granularity than the full ISO-8601 timestamp the field expects.
  if (created !== null) {
    const createdMs = Date.parse(created);
    if (!Number.isNaN(createdMs) && createdMs > flooredMs) {
      stampIso = new Date(createdMs).toISOString();
    }
  }

  if (modified === stampIso) {
    return { changed: false, modifiedIso: modified, stampedMtimeMs: null };
  }

  const next = stampModifiedFrontmatter(raw, stampIso);
  if (next === raw) return { changed: false, modifiedIso: modified, stampedMtimeMs: null };

  try {
    writeFileSync(absPath, next, "utf8");
  } catch {
    // Write failed — the on-disk markdown is untouched (stampModified is pure);
    // report no-op so the caller doesn't assume a stamp landed.
    return { changed: false, modifiedIso: modified, stampedMtimeMs: null };
  }
  // MJ-3 — report the file's floored mtime AFTER the write-back, so the caller's
  // per-path guard records the exact floored second the self-write echo event
  // will carry (the write bumps mtime to ~now; the echo change event stat()s the
  // same value). Fall back to the source floored mtime if the re-stat fails.
  let postWriteFlooredMs = flooredMs;
  try {
    postWriteFlooredMs = Math.floor(statSync(absPath).mtimeMs / 1000) * 1000;
  } catch {
    // keep the source floored mtime
  }
  return { changed: true, modifiedIso: stampIso, stampedMtimeMs: postWriteFlooredMs };
}
