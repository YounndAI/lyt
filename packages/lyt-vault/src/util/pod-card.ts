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

// v1.GP WS4 — end-of-init pod summary card + OSC 8 clickable links.
//
// Replaces the terse end-of-init lines with a box summarising what was
// minted (mesh · vault · {handle}/lyt-pod · lyt-pod-map), each with local
// paths + GitHub URLs, plus a Next-steps trio. Per D25 the card LEADS with
// "pod" and bridges "federation" exactly once (pod = federation gloss).
//
// OSC 8 hyperlinks render the GitHub URL + local vault path as clickable
// links on supporting terminals (Windows Terminal, iTerm2, modern VTE). When
// unsupported / non-TTY we fall back GRACEFULLY to plain text (the raw URL
// stays visible + copy-pasteable).
//
// D27(e) — NO `obsidian://open` deep-link. D27 reverses the prior F9 "fix":
// Alex live-confirmed the `?path=` URI STILL 404s on unregistered vaults
// (restoring HANDOFF-006 #4 — the `?path=` self-register claim was wrong in
// practice). The card now ALWAYS emits the honest affordance: the `file://`
// vault-FOLDER path + the instruction "To open in Obsidian: Open folder as
// vault → <path>". No verified-file plumbing, no deep-link branch, no
// `openFile`/`podMapOpenFile` fields. `renderPodCard` stays pure (no IO).

import { pathToFileURL } from "node:url";

// OSC 8 hyperlink wrapper. `\x1b]8;;URL\x1b\\TEXT\x1b]8;;\x1b\\`.
// `enabled=false` (non-TTY / unsupported) → graceful plain-text fallback:
// when the visible text already IS the URL, emit it bare; otherwise emit
// `text (url)` so the raw URL is never lost.
export function hyperlink(url: string, text: string, enabled: boolean): string {
  if (!enabled) {
    return text === url ? url : `${text} (${url})`;
  }
  const OSC = "\x1b]8;;";
  const ST = "\x1b\\";
  return `${OSC}${url}${ST}${text}${OSC}${ST}`;
}

// Build a `file://` URL for a local path (the honest "open" affordance —
// points at the vault FOLDER, paired with the "Open folder as vault"
// instruction). Cross-platform via Node's pathToFileURL (handles Windows
// drive letters + backslashes correctly).
export function fileUrlFor(absPath: string): string {
  return pathToFileURL(absPath).href;
}

export interface PodCardMeshRow {
  meshName: string;
  vaultName: string;
  vaultPath: string;
}

export interface PodCardData {
  // The handle/owner the pod is keyed under (drives the pod + pod-map names).
  handle: string;
  // The user's first mesh + vault (e.g. personal / personal/main or the
  // wizard's chosen first vault).
  mesh: PodCardMeshRow;
  // The pod repo full name (`{handle}/lyt-pod`) — sourced from the
  // federation chokepoint, never hardcoded.
  podRepoFullName: string;
  // Local path of the pod (federation) cache, when known.
  podLocalPath?: string;
  // The pod-map vault local path, when generated. D27(c): on-disk dir is FLAT
  // at `~/lyt/vaults/lyt-pod-map/` (no `<owner>` segment); `vault.kind: pod-map`
  // stays the internal discriminator the Pod Manager plugin keys on.
  podMapVaultPath?: string;
  // The owner slug. Retained for content/identity; D27(c) drops it from the
  // pod-map display + on-disk path (the vault is flat at `vaults/lyt-pod-map`).
  ownerSlug?: string;
  // Whether OSC 8 hyperlinks should be emitted (TTY + not piped).
  hyperlinksEnabled: boolean;
  // Brief B (B.3) — the HONEST publish posture. "staged" (default) means the
  // pod is materialized LOCALLY but NOT pushed to GitHub; the card must say so
  // rather than imply it is published. "published" means the round-trip
  // completed (after `lyt sync` / the publish prompt). Drives the status line.
  // D34 (OD-LOCALFIRST) — "local-only" means there is NO GitHub connection yet
  // (a no-gh / provisional init): a stronger honesty than "staged" (which
  // implies gh is wired + the repo exists). The card says "not connected".
  publishState?: "local-only" | "staged" | "published";
}

const GH_BASE = "https://github.com";

// Render the pod summary card. Pure (no IO) so it's unit-testable; the
// command layer prints the returned string. `hyperlinksEnabled=false` yields
// a fully plain-text card (every URL still visible).
export function renderPodCard(data: PodCardData): string {
  const link = (url: string, text: string): string => hyperlink(url, text, data.hyperlinksEnabled);

  // D27(e) — the "open" affordance is ALWAYS honest: the `file://` vault-folder
  // path + the instruction to add it as a vault in Obsidian. No
  // `obsidian://open` deep-link (it 404s on freshly-scaffolded unregistered
  // vaults — both `?vault=` and `?path=` forms). Empty path → omit the line
  // (never emit a broken link).
  // F3 (console-DX): ONE path line per vault — the path itself is the clickable
  // file:// link (OSC 8) — plus a short Obsidian hint. Replaces the prior
  // path: + open: + "→ <path>" triple that printed the same path three times.
  const openAffordance = (vaultDir: string): string[] => {
    if (vaultDir.length === 0) {
      return [];
    }
    return [
      `│   path:    ${link(fileUrlFor(vaultDir), vaultDir)}`,
      "│            ↳ open in Obsidian: Open folder as vault",
    ];
  };

  const published = data.publishState === "published";
  const localOnly = data.publishState === "local-only";

  const lines: string[] = [];
  lines.push("");
  lines.push("┌─ Your pod is ready ──────────────────────────────");
  // D25 bridge — exactly once, leading with "pod".
  lines.push("│ Your pod is your whole bundle of vaults (a federation under the hood).");
  // Brief B (B.3) + D34 (OD-LOCALFIRST) — the honest connection status. NEVER
  // imply published/connected when it isn't:
  // local-only → no GitHub yet (provisional/no-gh); nudge to CONNECT.
  // staged → gh wired, content materialized but not pushed; nudge to PUBLISH.
  // published → round-trip complete.
  lines.push(
    published
      ? "│ ✓ Published to GitHub."
      : localOnly
        ? "│ ✓ local pod ready (git-versioned) · ⚠ not connected to GitHub — run `lyt sync` to back up"
        : "│ ✓ local pod ready · ⚠ not yet published — run `lyt sync`",
  );
  lines.push("│");

  // Mesh + vault.
  lines.push(`│ mesh:      ${data.mesh.meshName}`);
  const vaultUrl = `${GH_BASE}/${data.handle}/${data.mesh.vaultName.replace("/", "-")}`;
  lines.push(`│ vault:     ${data.mesh.vaultName}`);
  lines.push(...openAffordance(data.mesh.vaultPath));
  void vaultUrl; // GitHub vault URL reserved for when vault push lands in the card

  // Pod repo.
  lines.push("│");
  const podUrl = `${GH_BASE}/${data.podRepoFullName}`;
  lines.push(`│ lyt-pod:   ${link(podUrl, data.podRepoFullName)}`);
  if (data.podLocalPath !== undefined && data.podLocalPath.length > 0) {
    lines.push(`│   path:    ${link(data.podLocalPath, data.podLocalPath)}`);
  }

  // Pod-map vault (display name lyt-pod-map; D27(c): on-disk dir is FLAT at
  // `~/lyt/vaults/lyt-pod-map/` — no `<owner>` path segment).
  if (data.podMapVaultPath !== undefined && data.podMapVaultPath.length > 0) {
    lines.push("│");
    lines.push(`│ lyt-pod-map: lyt-pod-map (pod-map vault)`);
    lines.push(...openAffordance(data.podMapVaultPath));
  }

  lines.push("└──────────────────────────────────────────────────");
  return lines.join("\n");
}

export interface NextStepsOpts {
  // Brief C (F4) — when the pod is staged (not yet published to GitHub),
  // surface `lyt sync` as the FIRST, prominent step (publish + back up the pod).
  // Omitted/false → the original capture/ask/open trio (pod already published).
  unpublished?: boolean;
}

// Render the Next-steps list. Plain text — these are commands + a nudge, not
// links. Kept separate from the card so callers can place it after a blank
// line. When `unpublished` is set, `lyt sync` leads the list (the card's
// staged status line already points there; this makes it an actionable step).
export function renderNextSteps(opts: NextStepsOpts = {}): string {
  const core = [
    'lyt capture "your first thought"',
    'ask your agent "what\'s in my pod?" (/lyt-pod)',
    "open your vault in Obsidian",
  ];
  const steps =
    opts.unpublished === true ? ["lyt sync — publish + back up your pod to GitHub", ...core] : core;
  const numbered = steps.map((s, i) => ` ${i + 1}. ${s}`);
  return ["", "Next:", ...numbered].join("\n");
}
