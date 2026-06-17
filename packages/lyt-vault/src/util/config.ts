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

import type { FederationRepoVisibility } from "./gh-federation.js";

// Brief B (§3–§6) — minimal config SEAM.
//
// The handler (2026-06-04) wants a settings/config layer for user-preference
// defaults; the FULL layer (a config file + `lyt config get/set` + env
// precedence + per-pod/global scope resolution) is DEFERRED to its own
// decision + brief (flagged for oversight in the Brief B retro). This seam exists
// so the three Brief-B defaults (a) live in exactly ONE place — no
// coupled-constant drift across the publish/visibility/conflict call-sites —
// and (b) the future layer is a purely ADDITIVE swap: when the config file
// ships, resolveConfig() gains a file read (merged OVER DEFAULT_LYT_CONFIG, the
// `overrides` slot below is the landing point) and every call-site is unchanged.
//
// FUTURE (handler directive 2026-06-04): the config layer MUST be a YON file
// (`config.yon` — parseable via @younndai/yon-parser AND natively
// AI-understandable), NOT JSON/TOML. Consistent with "YON is first-class".

// Init publish-prompt default. → "yes" ([Y/n]): publishing is the
// expected end-state of `lyt init`, and the prompt itself is the explicit
// consent (no surprise push) so an affirmative default is safe.
export type PublishPromptDefault = "yes" | "no";

// Sync pull-conflict posture. → "halt": reuse syncOneVault's proven
// surface-and-halt behavior (git rebase --abort + status:conflict + a
// resolution recipe; no data overwrite). Satisfies acceptance gate #5.
export type ConflictPosture = "halt" | "hil";

export interface LytConfig {
  // → "private": all auto-created repos default private; making a vault
  // public is a conscious, explicit per-vault action (a deferred seam), never a
  // default.
  defaultRepoVisibility: FederationRepoVisibility;
  publishPromptDefault: PublishPromptDefault;
  conflictPosture: ConflictPosture;
}

export const DEFAULT_LYT_CONFIG: LytConfig = {
  defaultRepoVisibility: "private",
  publishPromptDefault: "yes",
  conflictPosture: "halt",
};

export interface ResolveConfigOptions {
  // Test/caller override hook. The future config.yon read lands HERE: parse the
  // file → Partial<LytConfig> → pass as overrides (merged over the defaults).
  overrides?: Partial<LytConfig> | undefined;
}

// The single source of preference defaults for Brief B. Today it returns the
// locked defaults (optionally with caller overrides); tomorrow it reads
// config.yon. Call-sites depend only on this signature.
export function resolveConfig(opts: ResolveConfigOptions = {}): LytConfig {
  return { ...DEFAULT_LYT_CONFIG, ...(opts.overrides ?? {}) };
}
