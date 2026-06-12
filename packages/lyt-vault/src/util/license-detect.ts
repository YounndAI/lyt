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

// v1.B.6 — license heuristic for LICENSE-file detection. Used by the
// publish flow (LICENSE-presence + bucket check) + `lyt vault info --json`
// licensePosture surface + the license-aware federation warning helper.
//
// Heuristic (v1.B.6; full SPDX-aware comparison deferred to v1.5+ per
// DQ-new-20):
// - Line 1 pattern match for the major OSS licenses
// - Bucket: copyleft (GPL/AGPL/LGPL) | permissive (MIT/Apache/BSD/ISC/Unlicense/CC-BY/MPL) | unknown
//
// Returns null for `id` when the heuristic can't classify (LICENSE file
// missing or unrecognised). The bucket is still surfaced ("unknown") so
// callers can decide whether to warn.

export type LicenseBucket = "copyleft" | "permissive" | "unknown";

export interface DetectedLicense {
  id: string | null;
  bucket: LicenseBucket;
}

// Patterns ordered most-specific first so e.g. "GNU AFFERO GENERAL PUBLIC"
// matches before the GPL fallback. Pattern shape: { id, regex, bucket }.
interface LicensePattern {
  id: string;
  // Matched case-insensitively against the first 400 chars of the file
  // (enough to catch the line-1 header in every standard OSS LICENSE).
  regex: RegExp;
  bucket: LicenseBucket;
}

const PATTERNS: LicensePattern[] = [
  { id: "AGPL-3.0", regex: /GNU\s+AFFERO\s+GENERAL\s+PUBLIC\s+LICENSE/i, bucket: "copyleft" },
  { id: "LGPL-3.0", regex: /GNU\s+LESSER\s+GENERAL\s+PUBLIC\s+LICENSE/i, bucket: "copyleft" },
  {
    id: "GPL-3.0",
    regex: /GNU\s+GENERAL\s+PUBLIC\s+LICENSE\b[\s\S]{0,200}Version\s+3/i,
    bucket: "copyleft",
  },
  {
    id: "GPL-2.0",
    regex: /GNU\s+GENERAL\s+PUBLIC\s+LICENSE\b[\s\S]{0,200}Version\s+2/i,
    bucket: "copyleft",
  },
  { id: "GPL", regex: /GNU\s+GENERAL\s+PUBLIC\s+LICENSE/i, bucket: "copyleft" },
  {
    id: "MPL-2.0",
    regex: /Mozilla\s+Public\s+License[\s\S]{0,200}Version\s+2/i,
    bucket: "permissive",
  },
  { id: "Apache-2.0", regex: /Apache\s+License[\s\S]{0,200}Version\s+2/i, bucket: "permissive" },
  { id: "BSD-3-Clause", regex: /BSD\s+3-Clause/i, bucket: "permissive" },
  { id: "BSD-2-Clause", regex: /BSD\s+2-Clause/i, bucket: "permissive" },
  { id: "BSD", regex: /\bBSD\s+License\b/i, bucket: "permissive" },
  { id: "ISC", regex: /ISC\s+License/i, bucket: "permissive" },
  { id: "MIT", regex: /\bMIT\s+License\b/i, bucket: "permissive" },
  { id: "CC-BY-4.0", regex: /Creative\s+Commons\s+Attribution\s+4\.0/i, bucket: "permissive" },
  {
    id: "CC-BY-SA-4.0",
    regex: /Creative\s+Commons\s+Attribution[-\s]ShareAlike\s+4\.0/i,
    bucket: "copyleft",
  },
  { id: "CC0-1.0", regex: /CC0\s+1\.0/i, bucket: "permissive" },
  {
    id: "Unlicense",
    regex: /^This\s+is\s+free\s+and\s+unencumbered\s+software/im,
    bucket: "permissive",
  },
];

export function detectLicenseFromContent(text: string): DetectedLicense {
  const sample = text.slice(0, 400);
  for (const p of PATTERNS) {
    if (p.regex.test(sample)) {
      return { id: p.id, bucket: p.bucket };
    }
  }
  return { id: null, bucket: "unknown" };
}
