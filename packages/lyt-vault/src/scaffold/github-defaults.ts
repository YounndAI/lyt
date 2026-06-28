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

// (2026-06-02) — vault-repo topics. `younndai` dropped per the
// dogfooding handler-ask (topic set is now lyt + lyt-vault + linkyourthink;
// the org tag was noise on per-user vaults). Order is the emission order
// used by gh `--add-topic`.
// PARKED (handler-deferred 2026-06-02 — do NOT add without Alex's go):
// `pkm`, `obsidian`, `federated-vaults` — discoverability candidates
// considered but parked; revisit when the public-discovery surface opens.
export const BRAND_TOPICS: readonly string[] = ["lyt", "lyt-vault", "linkyourthink"];

// pod-repo (`{handle}/lyt-pod`) topics. The pod repo is the
// federation/identity layer, NOT a vault, so it carries `lyt-pod` (not
// `lyt-vault`). Same PARKED set as BRAND_TOPICS applies.
export const POD_TOPICS: readonly string[] = ["lyt", "lyt-pod", "linkyourthink"];

// (B-2 Phase E, 2026-06-26) — public-subscribable vault topics. A vault repo
// whose per-vault pod.yon `visibility === "public"` (the conscious-public seam,
// federation-read.ts) carries the standard vault brand set PLUS `lyt-public` so
// `lyt discover` / a public-discovery surface can filter the publicly-shared
// vaults without a per-repo visibility API call. The `lyt-public` trigger is
// LOCKED to per-vault pod.yon visibility — NOT `mesh-visibility` (the per-note
// frontmatter field, verified inert for publishing per decision C2). Order keeps
// the brand set first so the extra topic appends.
//
// DEFERRED LIFECYCLE GAP #1 — INERT IN PRODUCTION (Phase E release review, do NOT
// build here). This consumer is CORRECT, but currently UNREACHABLE in normal use:
// no product verb writes per-vault `@FED_VAULT visibility=public` to pod.yon yet.
// The conscious-public flip is deferred; `commands/federation.ts --public` is the
// POD-repo visibility axis, NOT the per-vault axis. So `lyt-public` is reachable
// today ONLY via a hand-edited or test-seeded pod.yon. When the per-vault
// conscious-public flip ships, it becomes live.
//
// DEFERRED LIFECYCLE GAP #2 — REVERSAL IS UNBUILT, and is a HARD DEPENDENCY of the
// flip above. Flipping a vault back to private will NOT strip `lyt-public`: the
// only writer is `gh repo edit --add-topic` (util/gh.ts editRepo, additive-only,
// never removes). A proper un-publish needs a `--remove-topic` capability that
// MUST ship WITH the conscious-public flip — never the flip alone, or a
// de-published vault keeps advertising `lyt-public` forever.
export const PUBLIC_VAULT_TOPICS: readonly string[] = [...BRAND_TOPICS, "lyt-public"];

// (B-2 Phase E) — formalized per-repo-class topic sets. A repo's brand-grade
// topic floor is determined by which CLASS of Lyt artifact it is:
//   - "vault"        → BRAND_TOPICS        [lyt, lyt-vault, linkyourthink]
//   - "pod"          → POD_TOPICS          [lyt, lyt-pod, linkyourthink]
//   - "public-vault" → PUBLIC_VAULT_TOPICS [lyt, lyt-vault, linkyourthink, lyt-public]
// NOTE on "map": the map repo (`{handle}/lyt-pod-map`) has NO established
// topic-enforcement convention today — pod-map-generate.ts emits the markdown
// vault but never runs a `gh repo create`/`--add-topic` for it. Per the Phase E
// brief ("follow the existing map-repo convention if one exists; otherwise
// leave map untouched and note it"), map is intentionally OMITTED from this
// table. When map-repo topic enforcement is wired, add a "map" class here
// (likely `[lyt, lyt-pod-map, linkyourthink]`) + a caller.
export type RepoClass = "vault" | "pod" | "public-vault";

export function baseTopicsForClass(repoClass: RepoClass): readonly string[] {
  switch (repoClass) {
    case "vault":
      return BRAND_TOPICS;
    case "pod":
      return POD_TOPICS;
    case "public-vault":
      return PUBLIC_VAULT_TOPICS;
  }
}

// exact pod-repo description (handler-locked verbatim string).
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

// GitHub's repo-topic grammar (validated server-side; a violation 422s the whole
// `gh repo edit`). Lowercase, must start with an alphanumeric, only `a-z0-9-`
// thereafter, ≤50 chars. Source: GitHub repo-topics API constraints.
const GH_TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;

// GitHub caps a repo at 20 topics; exceeding it 422s the edit. The brand/base
// floor is known-valid and load-bearing, so it always wins the cap.
const GH_TOPIC_CAP = 20;

// Brand-reserved topics may ONLY be introduced by the class floor (base), never
// forged from user-authored vault.yon extras. `lyt-public` is the public-signal
// marker (PUBLIC_VAULT_TOPICS); a hand-authored `lyt-public` in a private
// vault's vault.yon must NOT counterfeit the public class.
const BRAND_RESERVED: ReadonlySet<string> = new Set(["lyt-public"]);

// UNION (add-missing), never clobber: the brand-set base is asserted first, then
// any user-added extras are appended (de-duped, normalized to lowercase). This is
// the SC7 acceptance contract — enforcement preserves user-added topics.
//
// `base` defaults to BRAND_TOPICS so every pre-existing caller (github-push.ts,
// the vault sync path) keeps the vault-class floor unchanged. Pass an explicit
// base (e.g. PUBLIC_VAULT_TOPICS via baseTopicsForClass) to enforce a different
// repo-class floor — e.g. a public vault gets `+lyt-public`.
//
// HARDENING (Phase E release review): `extra` originates from user-authored
// vault.yon (`@TAG`) and reaches `gh --add-topic` unvalidated. So EXTRA topics are
// (1) validated against GH's grammar — an invalid extra is DROPPED, never thrown,
// so one bad topic can't 422 the edit and block brand enforcement; (2) screened
// for brand-reserved markers (`lyt-public`) — stripped so only the class floor can
// introduce them; (3) capped at 20 (GH's limit) with the base/brand floor taking
// precedence (a brand topic is never dropped to honor the cap). Base topics are
// trusted as known-valid and are NOT grammar-checked. Dropped extras are reported
// via the optional `dropped` sink so the caller can warn the user.
export function mergeTopics(
  extra: readonly string[] | undefined | null,
  base: readonly string[] = BRAND_TOPICS,
  dropped?: { topic: string; reason: "invalid" | "brand-reserved" | "cap-exceeded" }[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const note = (topic: string, reason: "invalid" | "brand-reserved" | "cap-exceeded"): void => {
    if (dropped) dropped.push({ topic, reason });
  };
  // Base/brand floor: trusted, known-valid, always admitted first (subject only
  // to dedupe). Never grammar-checked, never capped away.
  for (const t of base) {
    const norm = t.trim().toLowerCase();
    if (norm.length === 0 || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  // User extras: validate, strip brand-reserved, then admit under the cap.
  for (const raw of extra ?? []) {
    const norm = raw.trim().toLowerCase();
    if (norm.length === 0 || seen.has(norm)) continue;
    if (BRAND_RESERVED.has(norm)) {
      seen.add(norm); // dedupe future repeats; never emit
      note(norm, "brand-reserved");
      continue;
    }
    if (!GH_TOPIC_RE.test(norm)) {
      note(norm, "invalid");
      continue;
    }
    if (out.length >= GH_TOPIC_CAP) {
      note(norm, "cap-exceeded");
      continue;
    }
    seen.add(norm);
    out.push(norm);
  }
  return out;
}
