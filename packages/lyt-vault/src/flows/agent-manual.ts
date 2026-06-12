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

import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

// v1.G.5 — `lyt agent-manual --runtime {claude|codex|agents|generic}
// [--install] [--dry-run]`.
//
// Generates a Lyt-canonical context block (~150 lines, ~1.5K tokens) and
// emits it to stdout (preview) OR writes it to an agent-runtime global
// instructions file via the version-tagged marker pattern.
//
// the ratified default (the oversight handler default Path A3 hybrid): static template for mental-model
// + workflows + protocol-notes; auto-injected WHEN-USER-SAYS table from
// the 11 SKILL.md frontmatter; auto-injected CLI-verb list from a
// curated whitelist (the lyt-vault CLI registers ~50 verbs; the manual
// surfaces the 8 the agent should reach for first).
//
// the ratified default (Path B1 = D9 update-path primitive, RATIFIED by Alex 2026-06-01):
// marker pattern `<!-- lyt-manual v<lyt-version> BEGIN -->...
// <!-- lyt-manual v<lyt-version> END -->`. Uppercase BEGIN/END for
// grep-distinctness; version interpolated at install time. Treat the
// marker shape as a Lock-0.3-equivalent stability contract from this
// commit forward; future phases MUST NOT change it without a deliberate
// D-numbered decision.
//
// Idempotent install: detects an existing marker block on `--install`,
// replaces the content between markers, preserves all content outside
// markers. Malformed markers (BEGIN-count ≠ END-count) → refuse with
// structured error.
//
// PG-8 shell-injection defenses (pre-release review observation):
// - `--runtime` arg restricted to a TypeScript string literal enum;
// `parseAgentManualArgs` rejects all other values at the parser layer.
// - No `child_process` / shell invocation anywhere in the flow.
// - Destination paths are resolved via `path.resolve()`; symlink follow
// is left to the OS (`fs.writeFile` writes the symlink target, which
// is the documented behaviour the v1.F.2 marker contract expects).

export type AgentManualRuntime = "claude" | "codex" | "agents" | "generic";

export const AGENT_MANUAL_RUNTIMES: readonly AgentManualRuntime[] = [
  "claude",
  "codex",
  "agents",
  "generic",
] as const;

export interface AgentManualArgs {
  runtime: AgentManualRuntime;
  install?: boolean;
  dryRun?: boolean;
  // Test seam — defaults to process.env at call time when undefined.
  homedirOverride?: string;
  // Test seam — defaults to the bundled lyt-skills location resolved
  // relative to this module's URL. Tests inject a fixture directory.
  skillsDirOverride?: string;
  // Test seam — defaults to the lyt-vault package version. Interpolated
  // into the marker pattern at install time.
  versionOverride?: string;
}

// Release review Cor-M2 (Major) fix-pass: a tri-state on the existing
// destination file's marker shape, so the CLI's --dry-run output can
// distinguish "no block yet" (fresh-install) from "1 matched pair"
// (replace) from "malformed" (refuse). Prevents the prior silent
// `wouldReplaceExistingBlock: false` under malformed-marker files.
export type AgentManualMarkerStatus = "none" | "one" | "malformed" | "not-applicable";

export interface AgentManualResult {
  runtime: AgentManualRuntime;
  content: string;
  destinationPath: string | null; // null for "generic" (stdout)
  willWrite: boolean;
  wouldReplaceExistingBlock: boolean;
  markerVersion: string;
  // Cor-M2 fix-pass — visible in CLI --dry-run output.
  markerStatus: AgentManualMarkerStatus;
}

export class AgentManualMalformedMarkersError extends Error {
  public readonly status = "malformed-markers" as const;
  constructor(
    public readonly file: string,
    public readonly beginCount: number,
    public readonly endCount: number,
  ) {
    super(
      `Found ${beginCount} BEGIN marker(s) and ${endCount} END marker(s) in ${file}; cannot determine block boundaries. Resolve manually.`,
    );
    this.name = "AgentManualMalformedMarkersError";
  }
}

export class AgentManualUnsafeRuntimeError extends Error {
  public readonly status = "unsafe-runtime" as const;
  constructor(public readonly received: string) {
    super(
      `--runtime must be one of ${AGENT_MANUAL_RUNTIMES.join(" | ")}; received ${JSON.stringify(received)}`,
    );
    this.name = "AgentManualUnsafeRuntimeError";
  }
}

export function parseAgentManualRuntime(value: unknown): AgentManualRuntime {
  if (typeof value === "string" && (AGENT_MANUAL_RUNTIMES as readonly string[]).includes(value)) {
    return value as AgentManualRuntime;
  }
  throw new AgentManualUnsafeRuntimeError(String(value));
}

// Marker pattern per the ratified default + D9. Uppercase BEGIN/END for
// grep-distinctness. Version is interpolated at install time so the
// post-alpha update path (0.4.0 → 0.5.0 → 1.0.0) can replace the prior
// block by anchoring on the marker string regardless of version.
const MARKER_BEGIN_RE = /<!-- lyt-manual v[0-9][0-9A-Za-z.\-+]* BEGIN -->/g;
const MARKER_END_RE = /<!-- lyt-manual v[0-9][0-9A-Za-z.\-+]* END -->/g;

export function makeMarkerBegin(version: string): string {
  return `<!-- lyt-manual v${version} BEGIN -->`;
}

export function makeMarkerEnd(version: string): string {
  return `<!-- lyt-manual v${version} END -->`;
}

export function wrapInMarker(content: string, version: string): string {
  return `${makeMarkerBegin(version)}\n${content}\n${makeMarkerEnd(version)}\n`;
}

interface MarkerBlockResult {
  result: string;
  replaced: boolean;
  // v1.GP F5 — set when `--force` repaired a malformed-marker file by
  // appending a fresh block (the malformed region is preserved untouched
  // so nothing the handler wrote is destroyed). The CLI surfaces a visible
  // warning when this is true — repair is NEVER silent.
  forcedRepair?: boolean;
}

// v1.GP F5 — opt-in malformed-marker repair. The default (force=false)
// preserves the Cor-C1 / D9 REFUSE contract: malformed markers throw
// AgentManualMalformedMarkersError, never silently mutate a hand-edited
// file. With force=true, instead of refusing, we APPEND a fresh well-formed
// block at the end of the file (preserving the malformed region verbatim so
// no handler content is lost) and flag forcedRepair so the caller warns.
// The marker SHAPE is unchanged (D9 stability contract) — `--force` only
// changes the ACTION on malformed input, not the marker grammar.
export function replaceMarkerBlock(
  existingFile: string,
  newBlock: string,
  destinationPath: string,
  force = false,
): MarkerBlockResult {
  const beginMatches = existingFile.match(MARKER_BEGIN_RE) ?? [];
  const endMatches = existingFile.match(MARKER_END_RE) ?? [];

  // Append a fresh block to the end, preserving everything before it.
  const appendFresh = (forcedRepair: boolean): MarkerBlockResult => {
    const sep = existingFile.length > 0 && !existingFile.endsWith("\n") ? "\n" : "";
    return { result: `${existingFile}${sep}${newBlock}`, replaced: false, forcedRepair };
  };

  const refuseOrForce = (): MarkerBlockResult => {
    if (force) return appendFresh(true);
    throw new AgentManualMalformedMarkersError(
      destinationPath,
      beginMatches.length,
      endMatches.length,
    );
  };

  if (beginMatches.length !== endMatches.length) {
    return refuseOrForce();
  }
  if (beginMatches.length === 0) {
    return appendFresh(false);
  }
  if (beginMatches.length > 1) {
    return refuseOrForce();
  }
  // Release review Cor-C1 (Critical) fix-pass: use non-global regex literals
  // for both anchors so lastIndex sharing is impossible, AND assert
  // END appears AFTER BEGIN — without the order check, a file with a
  // single END BEFORE a single BEGIN passes the 1/1 count gate, gets
  // mis-spliced (before=slice(0, beginIdx) excludes the END; after=
  // slice(endIdx) re-includes the BEGIN), and silently corrupts the
  // handler's CLAUDE.md. D9 was elevated to prevent exactly this
  // failure mode.
  const beginRe = /<!-- lyt-manual v[0-9][0-9A-Za-z.\-+]* BEGIN -->/;
  const endRe = /<!-- lyt-manual v[0-9][0-9A-Za-z.\-+]* END -->/;
  const beginMatch = beginRe.exec(existingFile);
  const endMatch = endRe.exec(existingFile);
  if (beginMatch === null || endMatch === null) {
    // Defensive: counts said 1/1 but anchors didn't resolve. Treat as malformed.
    return refuseOrForce();
  }
  if (endMatch.index < beginMatch.index) {
    // END before BEGIN — counts pass but the file shape is inverted.
    return refuseOrForce();
  }
  const beginIdx = beginMatch.index;
  const endIdx = endMatch.index + endMatch[0].length;
  const before = existingFile.slice(0, beginIdx);
  const after = existingFile.slice(endIdx);
  // Preserve a single newline boundary after the new block when the
  // original file had one; do not invent trailing newlines otherwise.
  const trailing = after.startsWith("\n") ? "" : "\n";
  return { result: `${before}${newBlock.replace(/\n$/, "")}${trailing}${after}`, replaced: true };
}

// The three real (writeable-destination) runtimes, excluding `generic`
// which is stdout-only. Mirrors lyt-skills `ALL_RUNTIMES` for symmetry
// (F5 — agent-manual was single-runtime; skills install already defaults
// to all). Order is stable for deterministic CLI output.
export const INSTALLABLE_RUNTIMES: readonly Exclude<AgentManualRuntime, "generic">[] = [
  "claude",
  "codex",
  "agents",
] as const;

// v1.GP F5 — runtime auto-detection. A runtime is "present" when its home
// directory exists (`~/.claude`, `~/.codex`, `~/.agents`). Presence of the
// dir is the install signal (matches how a user with Claude Code / Codex /
// .agents installed will already have the dir). `generic` is never detected
// (it is a stdout-only pseudo-runtime). Test seam: homedirOverride.
export function detectInstalledRuntimes(
  homedirOverride?: string,
): readonly Exclude<AgentManualRuntime, "generic">[] {
  const home = homedirOverride ?? homedir();
  const dirFor: Record<Exclude<AgentManualRuntime, "generic">, string> = {
    claude: pathResolve(home, ".claude"),
    codex: pathResolve(home, ".codex"),
    agents: pathResolve(home, ".agents"),
  };
  return INSTALLABLE_RUNTIMES.filter((rt) => existsSync(dirFor[rt]));
}

export function resolveRuntimeDestination(
  runtime: AgentManualRuntime,
  homedirOverride?: string,
): string | null {
  if (runtime === "generic") return null;
  const home = homedirOverride ?? homedir();
  // path.resolve() defends against `..` traversal and normalises Windows
  // drive-letter casing; the runtime-keyed sub-path is a string literal,
  // so the only attacker-controlled input is `home`, which originates
  // from process.env.USERPROFILE / process.env.HOME — trusted in the
  // skill threat model.
  switch (runtime) {
    case "claude":
      return pathResolve(home, ".claude", "CLAUDE.md");
    case "codex":
      return pathResolve(home, ".codex", "AGENTS.md");
    case "agents":
      return pathResolve(home, ".agents", "AGENTS.md");
  }
}

// v3 (anchored, agent-first). The body is hand-curated and runtime-agnostic;
// `[lyt.*]` anchors mirror the global-instruction anchor style so handlers can
// reference rules precisely. NO real handles, NO fixed vault paths, only shipped
// skills/verbs — discovery over assumption. Section order is the agent's loop:
// orient -> get out -> put in -> track -> guardrails -> behavior -> reference.
function buildOneLiner(): string {
  return [
    "## Lyt in one line",
    "",
    "The user's **pod** = their Obsidian-markdown **vaults** (each its own GitHub repo, the",
    "pod repo is `lyt-pod`), grouped into **meshes**. The user owns the markdown; Lyt = the",
    'federation layer over those federated vaults. Say "pod" to the user ("federation" = same thing).',
  ].join("\n");
}

function buildPrimeSection(): string {
  return [
    "## `[lyt.prime]` Orient first — discover state, never assume paths",
    "",
    "Layout is per-pod, per-machine; do NOT hardcode a vault path or guess from cwd.",
    "- Topology (one shot): `/lyt-pod` (or `lyt vault list --json` + `lyt mesh list --json`).",
    "  Surfaces handle, meshes, vaults, repos, writable + sync state — it reads the pod manifest",
    "  (`pod.yon` / `identity.yon`, derived from `registry.db`) and resolves the pod root for you.",
    "- Content: `lyt primer --scope vault --target <name>` (or mesh|federation) -> active arcs,",
    "  top keywords, recent; cached at `<vault>/.lyt/primers/{scope}-primer.md`. `/lyt-primer-context` wraps both.",
    '- Resolve "this vault": `--vault` -> `$LYT_ACTIVE_VAULT` (skill hint, often unset) ->',
    "  `lyt vault info --by-path <cwd>` (safe; resolves only inside a registered vault) ->",
    "  `~/lyt/vaults/<handle>/main` (`<handle>` discovered from `identity.yon` / `pod.yon`, never",
    "  assumed) -> ASK. Confirm `.lyt/vault.yon` exists before read/write.",
    "- Keep the primed digest in context; RE-prime after you write/sync, or when the user changes",
    "  vault/mesh scope — primers and pod.yon are derived and go stale.",
  ].join("\n");
}

function buildGetOutSection(): string {
  return [
    "## `[lyt.out]` Get data OUT",
    "",
    "| User says | Do |",
    "|---|---|",
    "| what did I write about X | `/lyt-recall <X>` (one vault) |",
    "| search my pod for X | `/lyt-search <X>` (ranked, pod-wide) |",
    "| what's in my pod | `/lyt-pod` |",
    "| prime me / get context | `/lyt-primer-context` |",
  ].join("\n");
}

function buildPutInSection(): string {
  return [
    "## `[lyt.in]` Put data IN — ceremony is mandatory (the backbone)",
    "",
    "`/lyt-capture` writes ONE Obsidian-markdown Figment to `<vault>/notes/YYYY-MM-DD-<slug>.md`.",
    "EVERY Figment carries the v1 8-field frontmatter contract + `meta`:",
    "",
    "| Field | Rule |",
    "|---|---|",
    "| title | inferred 5-8 word noun phrase, or explicit |",
    "| created / modified | auto ISO-8601, equal at capture |",
    "| tags | inferred list, optional |",
    '| purpose | AUTHOR-SUPPLIED ("why keep this?") — PROMPT if not inferrable |',
    "| topic | AUTHOR-SUPPLIED (semantic category) — PROMPT if not inferrable |",
    "| mesh-visibility | local (default) \\| parent \\| public |",
    "| weight | 1-5, default 3 |",
    "| meta | `{}`; fill only for fields the 8 don't cover |",
    "",
    "- Never fabricate purpose/topic — ask. Never author-fill `links-out-of-vault` (scanner-filled).",
    "- Never write YON in a user Figment (YON is for `.lyt/*` system files only).",
    "- Capture writes the file only — it does NOT git. Sync is separate (`[lyt.sync]`).",
    "- Same ceremony, different home: `/lyt-plan` `/lyt-progress` `/lyt-result` `/lyt-retro`",
    "  `/lyt-insight` `/lyt-decision` `/lyt-handoff` -> work-management Figments.",
  ].join("\n");
}

function buildWorksetSection(): string {
  return [
    "## `[lyt.workset]` Track the vaults in play (session working set)",
    "",
    "After priming, hold a small in-context working set of the vaults you're using this session.",
    "For each: name, path, home mesh, writable verdict, and role — a SOURCE you read/search, a",
    "DESTINATION you write to, or both. Use it to route hot work without re-resolving each turn:",
    "- GET / SEARCH: scope `/lyt-recall` / `/lyt-search` to the working-set vaults first. When a",
    "  hit points at a Figment, READ the file at its path and work from the source — not the snippet.",
    "- PUT (create sources): write new Figments (`[lyt.in]` ceremony) to the working set's writable",
    "  DESTINATION. If more than one vault is writable, confirm which before writing.",
    "Refresh the set when you prime a new vault/mesh or after a write/sync.",
  ].join("\n");
}

function buildGateSection(): string {
  return [
    "## `[lyt.gate]` Write gate — before ANY write",
    "",
    "`lyt vault info <name> --json` -> read the `writable` field (`vault.writable`):",
    "true = proceed | false = offer {save local-only, capture to home vault, request access}",
    '| "unknown" = PAUSE and ASK. The `writableDetermination` reason tailors the prompt.',
  ].join("\n");
}

function buildSyncSection(): string {
  return [
    "## `[lyt.sync]` Sync only via `/lyt-sync`",
    "",
    "Never raw `git pull/commit/push` for a vault sync. `/lyt-sync` owns the gate, commit-message",
    "inference, and conflicts. Read-only/subscriber/orphan/no-remote vaults pull but skip push.",
  ].join("\n");
}

function buildDestructiveSection(): string {
  return [
    "## `[lyt.destructive]` Destructive verbs need handler confirmation",
    "",
    "`lyt vault delete|forget`, `git push --force`. Non-idempotent by design.",
  ].join("\n");
}

// V-B-8 fix-pass (2026-06-09) — single self-heal entry point. The recovery verb
// was inconsistent across surfaces (phantom `lyt mesh repair`, circular
// `lyt mesh rebuild-registry`, wrong `lyt mesh adopt --cluster`); a 2nd-machine
// adopt landed a read-only, mesh-broken pod with no working remedy surfaced.
// Canonical heal = `lyt repair` (idempotent; heals the adopt mesh-link drift
// with no extra args). `lyt doctor` diagnoses and points here.
function buildHealSection(): string {
  return [
    "## `[lyt.heal]` Pod broken? One verb path",
    "",
    'Pod won\'t sync / `lyt mesh info` fails / `writable: "unknown"` / empty `home_vaults`?',
    "`lyt doctor` diagnoses; `lyt repair --dry-run` lists findings; `lyt repair --apply` fixes",
    "(idempotent — heals adopt mesh-link drift with no extra args). It is `lyt repair` — there is",
    "NO `lyt mesh repair`. A truly un-adopted (orphan) vault needs a mesh:",
    "`lyt repair --target <vault> --apply --mesh <mesh>`.",
  ].join("\n");
}

// V-B fix-pass (2026-06-09, handler-placed in the manual) — agent comms style.
function buildExplainSection(): string {
  return [
    "## `[lyt.explain]` Surfacing a finding or issue",
    "",
    "Lead with the verdict + the one fact that proves it. Short and clear. Don't enumerate",
    'alternatives or show reasoning unless asked — offer depth ("want detail?") instead of',
    "dumping it. Be token-mindful.",
  ].join("\n");
}

function buildProactiveSection(): string {
  return [
    "## `[lyt.proactive]` Be the magic — anticipate, then offer (never auto-act)",
    "",
    "When a pod is present and the request touches notes, past work, decisions, or knowledge:",
    "prime first and surface what's relevant (recent Figments, active arcs) before answering cold.",
    "When the user makes something durable — decision, plan, result, insight, handoff — OFFER to",
    "capture it (`[lyt.in]`). Offer and recommend; never write or sync without the user. One",
    "suggestion, not a barrage.",
  ].join("\n");
}

// Enabler session (2026-06-11, D51 never-phone-home lock) — the alpha feedback
// channel is this directive, not telemetry. Feedback is user-initiated, the
// payload is an inspectable markdown Figment in the user's own pod, and
// nothing leaves the machine until the user explicitly syncs. Zero passive
// telemetry in alpha; any future metrics feature must pass through D51's
// shape (a local figment the user reads and chooses to share), not around it.
function buildFeedbackSection(): string {
  return [
    "## `[lyt.feedback]` Alpha feedback — user-initiated, inspectable, never automatic",
    "",
    "When the user voices feedback about Lyt itself (a bug, friction, a wish), OFFER to capture",
    "it as a feedback Figment into the shared `alpha-feedback` vault if it is in the pod",
    "(standard `[lyt.in]` ceremony; topic `lyt-feedback`); otherwise capture to the home vault",
    "and say so. The Figment is readable markdown in the user's own pod — nothing is sent until",
    "the user explicitly syncs (`/lyt-sync`, `[lyt.sync]` gate applies). NEVER send feedback",
    "automatically; NEVER collect usage data passively. Opting out is just not capturing —",
    "or `lyt vault forget alpha-feedback`.",
  ].join("\n");
}

function buildVerbsSection(): string {
  return [
    "## `[lyt.verbs]` CLI verbs that exist today (all take `--json`; `lyt help <topic>`)",
    "",
    "Read/orient: `vault info|list|init`, `mesh list|info|init` (main vault flagged),",
    "`search <q>`, `primer --scope ...`, `discover`.",
    "",
    "To drive Lyt, the high-value verbs grouped by intent (all shipped + unit/E2E-tested —",
    'they exist and do what\'s described; live-validation is ongoing, not "flawless"):',
    "- *vault lifecycle:* `vault clone <url>` (copy+register a vault; `--to-mesh <name>` assigns",
    "  the clone to a mesh), `vault move` (mesh-hop a vault), `vault rename`,",
    "  `vault forget|disconnect|delete` (deregister / unlink / remove).",
    "- *federation:* `mesh subscribe` (clone-on-subscribe a vault into a mesh), `mesh add-edge`",
    "  (parent/child rollup edge), `mesh publish` (make a mesh public), `mesh info --remote`",
    "  (peek a published `mesh.yon` via `gh api`, no clone).",
    "- *recovery:* `vault snapshot` / `restore` / `freeze` / `unfreeze`.",
    "- *maintenance:* `reindex` (rebuild content caches), `vault|mesh rebuild-rollup`,",
    "  `repair [--dry-run|--apply]`, `doctor` (see `[lyt.heal]`).",
  ].join("\n");
}

interface SkillFrontmatter {
  name: string;
  description: string;
}

async function readSkillFrontmatter(skillsDir: string): Promise<SkillFrontmatter[]> {
  if (!existsSync(skillsDir)) return [];
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skills: SkillFrontmatter[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    let raw: string;
    try {
      raw = readFileSync(skillPath, "utf8");
    } catch {
      continue;
    }
    const parsed = parseFrontmatterFields(raw);
    if (parsed.name === null) {
      // Malformed frontmatter — surface as a placeholder per brief counter-case
      // (line 380): emit "(description pending)" rather than crashing.
      skills.push({ name: entry.name, description: "(description pending)" });
      continue;
    }
    skills.push({
      name: parsed.name,
      description: parsed.description ?? "(description pending)",
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function parseFrontmatterFields(raw: string): { name: string | null; description: string | null } {
  // Light-touch YAML frontmatter reader — bounded to the first `---`...`---`
  // block. Handles inline `name: foo`, `description: >\n text\n more`,
  // and `description: |\n text`. Avoids a full YAML dep (the oversight handler lean per
  // PG-6 fs+glob path).
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match || match[1] === undefined) return { name: null, description: null };
  const body = match[1];
  const lines = body.split(/\r?\n/);
  let name: string | null = null;
  let description: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const nameMatch = /^name:\s*(.+?)\s*$/.exec(line);
    if (nameMatch && nameMatch[1] !== undefined) {
      name = stripQuotes(nameMatch[1]);
      continue;
    }
    const descMatch = /^description:\s*(.*)$/.exec(line);
    if (descMatch && descMatch[1] !== undefined) {
      const tag = descMatch[1].trim();
      if (tag === ">" || tag === "|" || tag === ">-" || tag === "|-") {
        const collected: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j];
          if (next === undefined) break;
          if (/^\S/.test(next)) break;
          collected.push(next.trim());
        }
        description = collected.join(" ").trim();
      } else if (tag.length > 0) {
        description = stripQuotes(tag);
      }
    }
  }
  return { name, description };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function summarizeTrigger(description: string): string {
  // Prefer the first quoted user-says phrase ("save this") — the highest-signal
  // trigger an agent matches on. Fall back to the first clause, trimmed at a word
  // boundary (never mid-word). Replaces the prior slice(0,107)+ellipsis truncation
  // that produced unusable "Trigger when t…" rows.
  const compact = description.replace(/\s+/g, " ").trim();
  const quoted = /"([^"]{2,40})"/.exec(compact);
  if (quoted && quoted[1] !== undefined) return `says "${quoted[1]}"`;
  const firstClause = (compact.split(/ — |\. /)[0] ?? compact).trim();
  if (firstClause.length <= 80) return firstClause;
  const cut = firstClause.slice(0, 80);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > 0 ? cut.slice(0, lastSpace) : cut}…`;
}

async function buildSkillIndex(skillsDir: string): Promise<string> {
  const skills = await readSkillFrontmatter(skillsDir);
  if (skills.length === 0) {
    return [
      "## `[lyt.skills]` Installed skill index",
      "",
      "(skill catalog not detected at install time; re-run `lyt agent-manual --install` after `lyt skills install`)",
    ].join("\n");
  }
  const rows = skills.map((s) => `- \`/${s.name}\` — ${summarizeTrigger(s.description)}`);
  return [
    "## `[lyt.skills]` Installed skill index",
    "",
    `${skills.length} Lyt skills installed via \`lyt skills install\`. The fast paths above cover the`,
    "common ones; this is the full list (auto-synced on install):",
    "",
    ...rows,
  ].join("\n");
}

// v3: buildCliVerbList / buildWorkflowsSection / buildProtocolNotesSection removed.
// Their content was folded into the anchored sections above: CLI verbs -> [lyt.verbs];
// workflows -> [lyt.prime] + [lyt.out] + [lyt.in]; protocol notes -> [lyt.gate] +
// [lyt.sync] + [lyt.destructive] (+ [lyt.prime] for `.lyt/vault.yon` identity).

function buildHeader(version: string): string {
  return `# Lyt Agent Manual v${version}`;
}

export async function generateAgentManual(args: AgentManualArgs): Promise<AgentManualResult> {
  const runtime = parseAgentManualRuntime(args.runtime);
  const version = args.versionOverride ?? readPackageVersion();
  const skillsDir = args.skillsDirOverride ?? defaultSkillsDir();
  const destinationPath = resolveRuntimeDestination(runtime, args.homedirOverride);

  const sections = [
    buildHeader(version),
    "",
    "> Managed block. The Lyt CLI owns everything between the markers and replaces it on",
    "> `lyt agent-manual --install`; content OUTSIDE the markers is preserved. Don't hand-edit —",
    "> change the generator and re-install (`lyt agent-manual --help`). The marker version = the",
    "> Lyt release this matches.",
    "",
    buildOneLiner(),
    "",
    buildPrimeSection(),
    "",
    buildGetOutSection(),
    "",
    buildPutInSection(),
    "",
    buildWorksetSection(),
    "",
    buildGateSection(),
    "",
    buildSyncSection(),
    "",
    buildDestructiveSection(),
    "",
    buildHealSection(),
    "",
    buildProactiveSection(),
    "",
    buildFeedbackSection(),
    "",
    buildExplainSection(),
    "",
    buildVerbsSection(),
    "",
    await buildSkillIndex(skillsDir),
  ];
  const body = sections.join("\n");
  const wrapped = wrapInMarker(body, version);

  // --install + --dry-run + generic stdout cases all share the same return
  // shape; the CLI builder decides whether to write or print.
  const install = args.install === true;
  const dryRun = args.dryRun === true;
  const willWrite = install && !dryRun && destinationPath !== null;

  // Cor-M2 fix-pass — compute markerStatus on the existing file so the
  // CLI --dry-run can surface "would-refuse: malformed markers" before
  // the user runs --install for real.
  let markerStatus: AgentManualMarkerStatus = "not-applicable";
  let wouldReplaceExistingBlock = false;
  if (destinationPath !== null) {
    if (!existsSync(destinationPath)) {
      markerStatus = "none";
    } else {
      const existing = readFileSync(destinationPath, "utf8");
      const beginMatches = existing.match(MARKER_BEGIN_RE) ?? [];
      const endMatches = existing.match(MARKER_END_RE) ?? [];
      if (beginMatches.length === 0 && endMatches.length === 0) {
        markerStatus = "none";
      } else if (beginMatches.length === 1 && endMatches.length === 1) {
        // 1/1 counts AND end-after-begin → "one" (replace-eligible).
        const beginRe = /<!-- lyt-manual v[0-9][0-9A-Za-z.\-+]* BEGIN -->/;
        const endRe = /<!-- lyt-manual v[0-9][0-9A-Za-z.\-+]* END -->/;
        const b = beginRe.exec(existing);
        const e = endRe.exec(existing);
        if (b !== null && e !== null && e.index >= b.index) {
          markerStatus = "one";
          wouldReplaceExistingBlock = true;
        } else {
          markerStatus = "malformed";
        }
      } else {
        markerStatus = "malformed";
      }
    }
  }

  return {
    runtime,
    content: wrapped,
    destinationPath,
    willWrite,
    wouldReplaceExistingBlock,
    markerVersion: version,
    markerStatus,
  };
}

function readPackageVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    const candidate = pathResolve(here, "..", "..", "..", "package.json");
    const raw = readFileSync(candidate, "utf8");
    const json = JSON.parse(raw) as { version?: string };
    if (typeof json.version === "string" && json.version.length > 0) return json.version;
  } catch {
    /* fall through */
  }
  return "0.0.0";
}

function defaultSkillsDir(): string {
  // The lyt-skills package lives at packages/lyt-skills/skills/ in the
  // monorepo source layout, AND at <install>/node_modules/@younndai/
  // lyt-skills/skills/ after npm install. Resolve via require.resolve-
  // style URL walking from this module so both layouts work without a
  // hard-coded path. Tests inject `skillsDirOverride`.
  const here = fileURLToPath(import.meta.url);
  // dist/flows/agent-manual.js → packages/lyt-vault/dist/flows/ →
  // ../../ → packages/lyt-vault/ → ../lyt-skills/skills/
  const sibling = pathResolve(here, "..", "..", "..", "..", "lyt-skills", "skills");
  if (existsSync(sibling)) return sibling;
  // Fallback: npm install layout — node_modules/@younndai/lyt-skills/skills
  const nodeModulesPath = pathResolve(
    here,
    "..",
    "..",
    "..",
    "..",
    "..",
    "@younndai",
    "lyt-skills",
    "skills",
  );
  if (existsSync(nodeModulesPath)) return nodeModulesPath;
  // Source-layout fallback for dev work without a build step.
  const srcSibling = pathResolve(here, "..", "..", "..", "..", "..", "lyt-skills", "skills");
  return srcSibling;
}
