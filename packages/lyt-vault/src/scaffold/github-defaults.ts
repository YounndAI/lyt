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

// Brand defaults injected on every Lyt-driven GitHub repo create/edit.
// Single source of truth: change here = change everywhere.

// D26 (2026-06-02) — vault-repo topics. `younndai` dropped per the
// dogfooding handler-ask (topic set is now lyt + lyt-vault + linkyourthink;
// the org tag was noise on per-user vaults). Order is the emission order
// used by gh `--add-topic`.
// PARKED (handler-deferred 2026-06-02 — do NOT add without Alex's go):
// `pkm`, `obsidian`, `federated-vaults` — discoverability candidates
// considered but parked; revisit when the public-discovery surface opens.
export const BRAND_TOPICS: readonly string[] = ["lyt", "lyt-vault", "linkyourthink"];

// D26 — pod-repo (`{handle}/lyt-pod`) topics. The pod repo is the
// federation/identity layer, NOT a vault, so it carries `lyt-pod` (not
// `lyt-vault`). Same PARKED set as BRAND_TOPICS applies.
export const POD_TOPICS: readonly string[] = ["lyt", "lyt-pod", "linkyourthink"];

// D26 — exact pod-repo description (handler-locked verbatim string).
export const POD_REPO_DESCRIPTION = "LYT Pod — Link Your Think — linkyourthink.com";

export const DESCRIPTION_PREFIX = "LYT Vault";
export const DESCRIPTION_SUFFIX = "linkyourthink.com";

export function formatRepoDescription(userDescription: string | undefined | null): string {
  const desc = (userDescription ?? "").trim();
  if (desc.length === 0) {
    return `${DESCRIPTION_PREFIX} | ${DESCRIPTION_SUFFIX}`;
  }
  return `${DESCRIPTION_PREFIX} | ${desc} | ${DESCRIPTION_SUFFIX}`;
}

export function mergeTopics(extra: readonly string[] | undefined | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (t: string): void => {
    const norm = t.trim().toLowerCase();
    if (norm.length === 0) return;
    if (seen.has(norm)) return;
    seen.add(norm);
    out.push(norm);
  };
  for (const t of BRAND_TOPICS) push(t);
  for (const t of extra ?? []) push(t);
  return out;
}
