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

// GH-decoupling seam (plan criterion C7 / Phase C). This is the SINGLE
// constructor of GitHub origin URLs in lyt-vault — every inline
// `https://github.com/<handle>/<repo>.git` construction routes through here.
// It is deliberately DUMB: pure string construction, no gh calls, no I/O. When
// a future non-GitHub backend swaps in (Phase C), this is the one place the
// host/scheme changes — callers never re-derive the URL shape themselves.

/**
 * Build the canonical GitHub origin URL from a handle (owner) and repo name.
 * Pure: `resolveRemoteUrl("younndai", "main")` → `https://github.com/younndai/main.git`.
 */
export function resolveRemoteUrl(handle: string, repo: string): string {
  return `https://github.com/${handle}/${repo}.git`;
}

/**
 * Sibling overload for an already-joined `owner/repo` slug (the input is a
 * single segment that already contains the owner/repo split). Kept distinct
 * from {@link resolveRemoteUrl} so a full slug is never wrongly split into a
 * handle+repo pair. Same seam semantics apply.
 */
export function resolveRemoteUrlFromSlug(slug: string): string {
  return `https://github.com/${slug}.git`;
}

/**
 * Browseable discovery URL (web page, NOT a `.git` clone target) for a repo.
 * Same host seam as {@link resolveRemoteUrl} but WITHOUT the `.git` suffix —
 * used where the URL is surfaced to a human to open in a browser, not handed
 * to `git`. Distinct fn so the suffix difference is explicit, not a flag.
 */
export function resolveDiscoveryUrl(handle: string, repo: string): string {
  return `https://github.com/${handle}/${repo}`;
}
