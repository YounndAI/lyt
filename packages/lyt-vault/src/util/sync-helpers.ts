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

// v1.G.3 — sync-helper shared between the /lyt-sync skill (which shells
// out to git directly per Path A1+) and any internal consumer that needs
// to summarise a git diff into a one-line commit message. Extracted to a
// helper to give the heuristic a unit-test surface that the SKILL.md
// prose can describe without re-implementing it inside markdown.
//
// Per the ratified default (the oversight handler default ratified 2026-06-01):
// 0 files → "no changes" (defensive; skill shouldn't have called)
// 1 file → "sync: <filename>" (or "sync: mesh.yon update" when the
// single file is mesh.yon at any depth)
// 2-4 files → "sync: N files (<comma-joined list>)"
// >4 files → "sync: N files (<first 3>, +M more)"
//
// Stays internal: NOT exported via packages/lyt-vault/src/index.ts.
// Test-only surface; the SKILL.md prose describes the behavior so an
// agent can reproduce it inline without importing.

export interface GitDiffSummary {
  staged: string[];
  modified: string[];
}

export function inferCommitMessage(diff: GitDiffSummary): string {
  const files = [...diff.staged, ...diff.modified].sort();
  if (files.length === 0) return "no changes";
  if (files.length === 1) {
    const only = files[0]!;
    if (only === "mesh.yon" || only.endsWith("/mesh.yon")) {
      return "sync: mesh.yon update";
    }
    return `sync: ${only}`;
  }
  if (files.length <= 4) {
    return `sync: ${files.length} files (${files.join(", ")})`;
  }
  return `sync: ${files.length} files (${files.slice(0, 3).join(", ")}, +${files.length - 3} more)`;
}

// ---------------------------------------------------------------------------
// Brief C (F2) — metadata-driven vault commit messages.
//
// Replaces the terse `lyt sync: <ts>` ongoing-changes commit message (built in
// lyt-mesh sync.ts:syncOneVault) with a deterministic, LLM-FREE summary naming
// each changed figment by title with a +new / ~updated / -deleted prefix. An
// agent-issued `lyt sync` MAY override the whole message via a caller-supplied
// `message`; the CLI itself NEVER calls an LLM (§2-F2 + handler ask). These
// helpers are PURE (no fs/git) so the heuristic has a unit-test surface; the fs
// glue (reading each figment's frontmatter title) lives in the caller.
// ---------------------------------------------------------------------------

// `+`new / `~`updated / `-`deleted — derived from git status (A/M/D).
export type FigmentChangeType = "add" | "modify" | "delete";

export interface ChangedFigment {
  // Vault-relative path (posix) — used only for deterministic ordering.
  path: string;
  changeType: FigmentChangeType;
  // Display title: frontmatter `title:` (caller-resolved), filename fallback,
  // or the path's basename for a deleted figment (can't read a deleted file).
  title: string;
}

export interface PorcelainChange {
  path: string;
  changeType: FigmentChangeType;
}

export interface VaultCommitMessageOpts {
  // GitHub handle for the subject's `lyt sync(<handle>)` prefix. Empty → the
  // `(<handle>)` segment is omitted (no identity resolvable).
  handle: string;
  // `<mesh>/<vault>` (the registry vault name is already in this shape).
  vaultName: string;
  // Minute-granularity ISO timestamp for the subject suffix, e.g.
  // `2026-06-04T12:54Z` (built by the caller from the sync clock).
  shortTs: string;
  // True when `.lyt/**` config churned this sync — summarized as a single
  // `+ .lyt config` body line rather than enumerating config files (per F2).
  configChanged?: boolean;
}

const CHANGE_PREFIX: Record<FigmentChangeType, string> = {
  add: "+",
  modify: "~",
  delete: "-",
};

// Build the deterministic, metadata-driven commit message:
// lyt sync(<handle>): <mesh>/<vault> — +<A> ~<M> -<D> [<short-ts>]
//
// + <title of each new figment>
// ~ <title of each updated figment>
// - <title of each deleted figment>
//
// Body groups are ordered add → modify → delete; within a group, figments are
// sorted by path for reproducibility (Lock-0.3-style determinism). A `.lyt/**`
// change appends a single `+ .lyt config` line. When nothing enumerable
// changed (only config, or an empty change-set), the subject stands alone.
export function buildVaultCommitMessage(
  changed: readonly ChangedFigment[],
  opts: VaultCommitMessageOpts,
): string {
  const adds = changed.filter((c) => c.changeType === "add");
  const mods = changed.filter((c) => c.changeType === "modify");
  const dels = changed.filter((c) => c.changeType === "delete");
  const handlePart = opts.handle.length > 0 ? `(${opts.handle})` : "";
  const subject = `lyt sync${handlePart}: ${opts.vaultName} — +${adds.length} ~${mods.length} -${dels.length} [${opts.shortTs}]`;

  const byPath = (a: ChangedFigment, b: ChangedFigment): number => a.path.localeCompare(b.path);
  const ordered = [...[...adds].sort(byPath), ...[...mods].sort(byPath), ...[...dels].sort(byPath)];
  const bodyLines = ordered.map((c) => `${CHANGE_PREFIX[c.changeType]} ${c.title}`);
  if (opts.configChanged === true) bodyLines.push("+ .lyt config");

  return bodyLines.length > 0 ? `${subject}\n\n${bodyLines.join("\n")}` : subject;
}

// Extract the frontmatter `title:` from a figment's raw markdown. Lightweight
// line-scan over the leading `---`…`---` block (mirrors parseFrontmatterTags /
// parseFrontmatterArcs — no full YAML parse). Strips surrounding quotes.
// Returns null when there's no frontmatter title (caller falls back to filename).
export function readFigmentTitle(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "---") break; // end of frontmatter block
    const m = /^title:\s*(.+)$/.exec(line);
    if (m) {
      let v = m[1]!.trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      return v.length > 0 ? v : null;
    }
  }
  return null;
}

// Classify a `git status --porcelain` v1 line into a path + change-type.
// `XY <path>` (or `XY <orig> -> <new>` for renames). Untracked `??` → add;
// any `D` → delete; any `A` → add; rename `R` resolves to the destination
// path and counts as a modify. Returns null for a malformed/short line.
export function classifyPorcelainLine(line: string): PorcelainChange | null {
  if (line.length < 4) return null;
  const xy = line.slice(0, 2);
  const rest = line.slice(3);
  const arrow = rest.indexOf(" -> ");
  const path = arrow >= 0 ? rest.slice(arrow + 4) : rest;
  let changeType: FigmentChangeType;
  if (xy === "??") changeType = "add";
  else if (xy.includes("D")) changeType = "delete";
  else if (xy.includes("A")) changeType = "add";
  else changeType = "modify";
  return { path, changeType };
}

// A figment = vault markdown (`.md`) that is NOT under a `.lyt/` config dir.
export function isFigmentPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/");
  if (isConfigPath(p)) return false;
  return p.toLowerCase().endsWith(".md");
}

// A `.lyt/**` config path (root `.lyt/` or any nested `.lyt/`).
export function isConfigPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/");
  return p.startsWith(".lyt/") || p.includes("/.lyt/");
}
