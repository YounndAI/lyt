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

import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { getIdentity, validateVaultName } from "../util/identity.js";
import { newUuidv7Bytes } from "../util/uuid7.js";
import { resolveVaultPath } from "../util/paths.js";
import {
  DEFAULT_TEMPLATE,
  type TemplateName,
  getObsidianScaffold,
  getVaultGitignore,
} from "../templates/index.js";
import {
  AGENTS_MD_TEMPLATE_VERSION,
  getAgentsMdContent,
  getLytOverviewContent,
  getNotesIndexContent,
} from "../templates/priming.js";
import { FRONTMATTER_CONTRACT_VERSION } from "../templates/contract.js";
import {
  payloadForVault,
  renderSeedFigment,
  resolveScaffoldTier,
  type ScaffoldTier,
} from "../templates/tier-payloads.js";
import { regenAgentsMd } from "../flows/agents-md-regen.js";
import { regenReadme } from "../flows/readme-regen.js";
import {
  AGENTS_MD_REL_WRITE_PATH,
  LYT_OVERVIEW_REL_WRITE_PATH,
  agentsMdWritePath,
  lytOverviewWritePath,
  resolveLytOverviewReadPath,
} from "../util/agent-file-paths.js";
import { isMeshDefiner, writeMeshContextFile } from "./mesh-context.js";
import { renderMemscopeYon } from "../yon/memscope.js";
import { renderVaultYon } from "../yon/vault.js";

// Bundled v1 reference @AUTOMATOR YON declarations copied into every fresh
// vault's .lyt/automators/. Block-A.3 shipped metadata-filler.yon (the
// archetype=filler wedge for the 8 mandatory frontmatter fields). v1.D.1c
// added lane-builder.yon (archetype=aggregator — rebuilds the tag-frequency
// lanes index per v1.D.1a). v1.D.2c adds arc-builder.yon (archetype=aggregator
// — rebuilds the position-ordered narrative arcs index per v1.D.2a, mirror
// to lane-builder applied to the second search tier). Each is consumed at
// runtime by block-B's lyt-runner; the scaffold copies them so a fresh
// vault has the v1 archetype set without an additional install step.
const BUNDLED_AUTOMATOR_FILENAMES = [
  "metadata-filler.yon",
  "lane-builder.yon",
  "arc-builder.yon",
] as const;

// v1.B.3 — home-mesh assignment threaded through the scaffold so vault.yon
// gets a @VAULT_HOME_MESH block on creation, rather than a post-scaffold
// re-render. `assignedAt` is the same ISO timestamp as the vault's own
// createdAt by convention; callers may override (move/clone use the
// move/clone time).
export interface ScaffoldHomeMesh {
  meshRid: Uint8Array;
  meshName: string;
  // Optional override; defaults to the same iso timestamp as the @VAULT
  // record's `created_at`. Move flow passes a fresh `now` for the new
  // assignment.
  assignedAt?: string | undefined;
}

export interface InitOptions {
  name: string;
  path?: string | undefined;
  template?: TemplateName | undefined;
  // Parent vault NAME (display + CLI surface). Kept as string because the
  // CLI accepts a human-readable name; if a rid is needed for FK semantics,
  // pass `parentVaultRid` (bytes) too.
  parent?: string | undefined;
  // Parent vault rid bytes. v1.A.1b: the on-disk `parent_vault` field in
  // vault.yon serialises to dashed UUIDv7, FK-compatible with vaults.rid
  // BLOB. Callers (flows/init.ts) resolve `--parent <name>` → bytes before
  // calling scaffold; tests can pass the bytes directly.
  parentVaultRid?: Uint8Array | undefined;
  tierHint?: string | undefined;
  desc?: string | undefined;
  topics?: readonly string[] | undefined;
  starterFigment?: boolean | undefined;
  gitInit?: boolean | undefined;
  commitInitial?: boolean | undefined;
  // v1.B.3 — when present, scaffolded vault.yon gets a @VAULT_HOME_MESH
  // block pointing at this mesh. Absence leaves vault.yon mesh-unaffiliated
  // (pre-v1.B.3 behavior; the v1.B.3 init flow's auto-personal branch and
  // clone --to-mesh path always set this).
  homeMesh?: ScaffoldHomeMesh | undefined;
}

export interface InitResult {
  vaultPath: string;
  vaultRid: Uint8Array;
  memscopeRid: Uint8Array;
  template: TemplateName;
  gitInitialized: boolean;
  initialCommitMade: boolean;
  primingFilesWritten: string[];
  // Phase C (UNIT 1) — which tier payload was materialised. "rich" for a
  // `{mesh}/main` vault (full seed + mesh-prop write); "mini" for a member vault.
  tier: ScaffoldTier;
}

export function initVault(opts: InitOptions): InitResult {
  const template = opts.template ?? DEFAULT_TEMPLATE;
  validateVaultName(opts.name);
  const vaultPath = resolveVaultPath(opts.name, opts.path);

  ensureEmptyOrCreate(vaultPath);

  const owner = getIdentity();
  const vaultRid = newUuidv7Bytes();
  const memscopeRid = newUuidv7Bytes();
  const createdAt = new Date().toISOString();

  // Phase C (UNIT 1) — branch the scaffold payload by tier. `{mesh}/main` →
  // rich (full seed + mesh-prop write); non-main → mini. Data-driven: the
  // branch SELECTS a payload-definition object (templates/tier-payloads.ts); it
  // does NOT inline the contents, so B-1's contract can later supply the data.
  const tier = resolveScaffoldTier(opts.name);

  writeVaultYon({ vaultPath, name: opts.name, vaultRid, memscopeRid, owner, createdAt, opts });
  writeMemscopeYon({ vaultPath, name: opts.name, vaultRid, memscopeRid, owner });
  writeObsidianScaffold(vaultPath, template);
  writeReadme(vaultPath, opts.name);
  writeVaultGitignore(vaultPath);
  writeNotesPlaceholder(vaultPath);
  writeAuditDirPlaceholder(vaultPath);
  copyBundledAutomators(vaultPath);

  const primingFilesWritten = writePrimingFiles({
    vaultPath,
    name: opts.name,
    desc: opts.desc,
    owner,
    parentVaultDisplay: opts.parent ?? null,
    starterFigment: opts.starterFigment !== false,
    tier,
  });

  const gitInit = opts.gitInit ?? true;
  let gitInitialized = false;
  if (gitInit) {
    gitInitialized = runGitInit(vaultPath);
  }

  let initialCommitMade = false;
  if (gitInitialized && opts.commitInitial === true) {
    initialCommitMade = runInitialCommit(vaultPath, primingFilesWritten);
  }

  return {
    vaultPath,
    vaultRid,
    memscopeRid,
    template,
    gitInitialized,
    initialCommitMade,
    primingFilesWritten,
    tier,
  };
}

function ensureEmptyOrCreate(dir: string): void {
  if (existsSync(dir)) {
    const entries = readdirSync(dir);
    if (entries.length > 0) {
      throw new Error(
        `Refusing to scaffold into a non-empty directory: ${dir}\n` +
          `Use 'lyt vault adopt' for an existing Obsidian vault, or pick a fresh path with --path.`,
      );
    }
    return;
  }
  mkdirSync(dir, { recursive: true });
}

function writeFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

interface WriteVaultYonArgs {
  vaultPath: string;
  name: string;
  vaultRid: Uint8Array;
  memscopeRid: Uint8Array;
  owner: string;
  createdAt: string;
  opts: InitOptions;
}

function writeVaultYon(args: WriteVaultYonArgs): void {
  const content = renderVaultYon({
    vault: {
      rid: args.vaultRid,
      name: args.name,
      desc: args.opts.desc,
      parentVault: args.opts.parentVaultRid,
      tierHint: args.opts.tierHint,
      memscope: args.memscopeRid,
      createdAt: args.createdAt,
      version: "0.1",
    },
    topics: args.opts.topics ?? [],
    primaryOwner: args.owner,
    lifecycle: "active",
    agentTemplateVersion: AGENTS_MD_TEMPLATE_VERSION,
    // Phase A — scaffold-system version stamps (reconciled with `version` in @VAULT).
    // `templateVersion` mirrors AGENTS_MD_TEMPLATE_VERSION (same scaffold generation).
    // `contractVersion` is the yai.lyt v1 frontmatter contract revision from contract.ts.
    templateVersion: AGENTS_MD_TEMPLATE_VERSION,
    contractVersion: FRONTMATTER_CONTRACT_VERSION,
    ...(args.opts.homeMesh !== undefined
      ? {
          homeMesh: {
            vaultRid: args.vaultRid,
            meshRid: args.opts.homeMesh.meshRid,
            meshName: args.opts.homeMesh.meshName,
            assignedAt: args.opts.homeMesh.assignedAt ?? args.createdAt,
          },
        }
      : {}),
  });
  writeFile(join(args.vaultPath, ".lyt", "vault.yon"), content);
}

interface WriteMemscopeYonArgs {
  vaultPath: string;
  name: string;
  vaultRid: Uint8Array;
  memscopeRid: Uint8Array;
  owner: string;
}

function writeMemscopeYon(args: WriteMemscopeYonArgs): void {
  const content = renderMemscopeYon({
    vaultRid: args.vaultRid,
    vaultName: args.name,
    scope: {
      rid: args.memscopeRid,
      scopeLevel: "vault",
      readRoles: [args.owner],
      writeRoles: [args.owner],
      adminRoles: [args.owner],
      defaultView: "private",
    },
    allowExpandToProject: false,
    allowExpandToWorkspace: false,
  });
  writeFile(join(args.vaultPath, ".lyt", "memscope.yon"), content);
}

function writeObsidianScaffold(vaultPath: string, template: TemplateName): void {
  const scaffold = getObsidianScaffold(template);
  const dir = join(vaultPath, ".obsidian");
  writeFile(join(dir, "app.json"), scaffold.appJson);
  writeFile(join(dir, "workspace.json"), scaffold.workspaceJson);
  writeFile(join(dir, "core-plugins.json"), scaffold.corePluginsJson);
  writeFile(join(dir, "community-plugins.json"), scaffold.communityPluginsJson);
}

// Phase C (UNIT 4) — the README is written via the managed-block init-once flow
// (regenReadme). At init the file is absent, so regenReadme writes the full
// template (markers + boilerplate). Routing through regenReadme (rather than a
// raw write) keeps the write path identical to the later marker-bounded regen
// and to the conformance path, so there is ONE README-writing chokepoint.
function writeReadme(vaultPath: string, name: string): void {
  regenReadme(vaultPath, name);
}

function writeVaultGitignore(vaultPath: string): void {
  writeFile(join(vaultPath, ".gitignore"), getVaultGitignore());
}

function writeNotesPlaceholder(vaultPath: string): void {
  writeFile(
    join(vaultPath, "notes", ".gitkeep"),
    "# Notes (Figments) live here. Subfolders are organizational only — Lyt indexes by content.\n",
  );
}

// `.lyt/audit/` is the destination for `lyt audit export` (arc §8.4). Creating
// it scaffold-side keeps first-export latency-free + gives handlers a visible
// place for compliance evidence; .gitkeep ensures the empty directory is
// tracked by git. The directory is intentionally NOT gitignored — exported
// audit markdown is the handler-shareable cross-machine artifact.
function writeAuditDirPlaceholder(vaultPath: string): void {
  writeFile(
    join(vaultPath, ".lyt", "audit", ".gitkeep"),
    "# `lyt audit export` writes per-window markdown files here.\n",
  );
}

// Copies the bundled @AUTOMATOR reference declarations (block-A.3 ships
// metadata-filler.yon only) into the fresh vault's .lyt/automators/.
// Additive on adopt: never overwrites an existing handler-customised copy.
// block-B's lyt-runner reads these declarations at runtime.
export function copyBundledAutomators(vaultPath: string): void {
  const targetDir = join(vaultPath, ".lyt", "automators");
  mkdirSync(targetDir, { recursive: true });
  const sourceDir = getBundledAutomatorsSourceDir();
  for (const name of BUNDLED_AUTOMATOR_FILENAMES) {
    const target = join(targetDir, name);
    if (existsSync(target)) continue; // additive: respect handler overrides
    const source = join(sourceDir, name);
    if (!existsSync(source)) continue; // skip if not on disk (e.g., dev builds with stale dist)
    copyFileSync(source, target);
  }
}

// Resolves the `scaffold/defaults/automators/` directory from this module's
// own file URL — works for both src/ (vitest) and dist/ (built / installed
// package) layouts because both ship the defaults under the same relative
// path. The dist build copies the .yon files via the existing
// copy-patterns.mjs pattern (see scripts/copy-yon-defaults.mjs added in
// this commit).
function getBundledAutomatorsSourceDir(): string {
  // import.meta.url → .../scaffold/init.{ts|js}
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "defaults", "automators");
}

interface WritePrimingFilesArgs {
  vaultPath: string;
  name: string;
  desc: string | undefined;
  owner: string;
  // Display string for mesh-context.md (parent vault name, e.g. "alex/main").
  // Not a rid — see writeMeshContextFile which renders it inside a code span.
  parentVaultDisplay: string | null;
  starterFigment: boolean;
  // Phase C (UNIT 1) — the resolved tier; selects the payload definition.
  tier: ScaffoldTier;
}

function writePrimingFiles(args: WritePrimingFilesArgs): string[] {
  const written: string[] = [];
  const payload = payloadForVault(args.name);

  // Phase D (SC6) — agent-priming files write under `.lyt/` (resolver-owned).
  const overviewPath = lytOverviewWritePath(args.vaultPath);
  writeFile(
    overviewPath,
    getLytOverviewContent({ vaultName: args.name, desc: args.desc, owner: args.owner }),
  );
  written.push(LYT_OVERVIEW_REL_WRITE_PATH);

  // Phase C (UNIT 3 / M1a fix) — render the initial .lyt/mesh-context.md. The
  // "this vault defines the mesh" signal is NOT seeded as stored prose here:
  // doing so wrote into the DERIVED mesh-context.md only, and the first mesh op
  // (regenMeshContextFromYon) erased it. Instead the definer line is DERIVED in
  // renderMeshContext from the durable structural fact (mesh.yon main_vault_rid
  // === this vault's rid; see isMeshDefiner). At scaffold time mesh.yon does not
  // exist yet (mesh-init writes it later), so isMeshDefiner is false now and the
  // line appears on the first regen after mesh.yon lands — durable by
  // construction. An explicit --desc still flows through normally; without one,
  // desc is null exactly as before Phase C.
  const meshDesc = args.desc ?? null;
  writeMeshContextFile(args.vaultPath, {
    vaultName: args.name,
    parentVaultRid: args.parentVaultDisplay,
    shareWith: [],
    acceptsFrom: [],
    desc: meshDesc,
    isMeshDefiner: isMeshDefiner(args.vaultPath),
  });
  written.push(".lyt/mesh-context.md");

  const agentsPath = agentsMdWritePath(args.vaultPath);
  writeFile(agentsPath, getAgentsMdContent({ vaultName: args.name }));
  written.push(AGENTS_MD_REL_WRITE_PATH);

  // Phase C (UNIT 2) — tier seed Figments. Both tiers write a conformant
  // welcome Figment (sentinel-bearing, FTS-excluded); the rich tier's copy
  // orients to the whole mesh, the mini tier's to the single vault. The CONTENTS
  // come from the payload-definition object (tier-payloads.ts), not inlined here.
  if (args.starterFigment) {
    const starterPath = join(args.vaultPath, "notes", "index.md");
    writeFile(starterPath, getNotesIndexContent(args.name));
    written.push("notes/index.md");

    for (const seed of payload.seedFigments) {
      writeFile(join(args.vaultPath, seed.relativePath), renderSeedFigment(seed));
      written.push(seed.relativePath);
    }
  }

  return written;
}

export interface ScaffoldConformanceArgs {
  vaultPath: string;
  name: string;
  desc?: string | undefined;
  owner?: string | undefined;
}

export interface ScaffoldConformanceResult {
  /** Relative paths of files written or regenerated for conformance. */
  written: string[];
}

// UNIT 4 — apply scaffold conformance on clone + adopt, not just init.
//
// init() scaffolds the priming seeds (lyt-overview.md / agents.md) carrying the
// `lyt-scaffold: true` sentinel so the g6 gate FTS-excludes them. A vault that
// arrives via `lyt vault adopt <path>` (the adopt-an-existing-vault path) or `lyt vault
// clone <url>` may have NO priming seeds at all — or, worse, a pre-existing
// agents.md / lyt-overview.md WITHOUT the sentinel that would FTS-pollute the
// primer. This brings such a vault to conformance.
//
// BLAST-RADIUS DISCIPLINE (system-first, but never clobber handler content):
//   • lyt-overview.md / README.md — ADDITIVE: written only when ABSENT. Their
//     bodies carry handler-evolvable content (the vault description); we never
//     overwrite an existing one.
//   • agents.md — when ABSENT, written fresh (sentinel-bearing). When PRESENT,
//     run regenAgentsMd: it is marker-bounded (replaces only the LYT_PATTERNS /
//     LYT_PRIMER sections, preserving user edits + any existing leading
//     frontmatter). SCOPE BOUNDARY: this conformance does NOT *upgrade* an
//     existing agents.md to carry the sentinel — if the file is PRESENT WITH
//     LYT_PATTERNS markers but WITHOUT a `lyt-scaffold:` frontmatter (the shape
//     a pre-Phase-B / hand-authored agents.md has), the marker-bounded branch
//     preserves it as-is and it stays sentinel-less (and thus FTS-indexed). The
//     full-rewrite branch that re-emits the sentinel fires ONLY when markers are
//     ABSENT. Migrating such existing files to conformance is Phase D's
//     doctor/heal job, not this fresh-scaffold path. See the Phase-D
// adopt-upgrade follow-up (release review #2-behavior, deferred per plan).
//   • README.md + notes/index.md are basename-excluded from FTS regardless of a
//     sentinel, so they are NOT FTS-pollution vectors; README is still seeded
//     when absent for a complete scaffold, but no sentinel mutation is forced.
export function writeScaffoldConformance(
  args: ScaffoldConformanceArgs,
): ScaffoldConformanceResult {
  const written: string[] = [];
  const owner = args.owner ?? getIdentity();

  // Phase D (SC6) — ADDITIVE: write lyt-overview.md under `.lyt/` only when the
  // vault has NEITHER a `.lyt/` copy NOR a legacy-root copy (resolveLytOverview-
  // ReadPath returns the legacy path when one exists, so an adopted vault that
  // already carries a root lyt-overview.md is left untouched — never duplicated).
  const overviewReadPath = resolveLytOverviewReadPath(args.vaultPath);
  if (!existsSync(overviewReadPath)) {
    const overviewPath = lytOverviewWritePath(args.vaultPath);
    writeFile(
      overviewPath,
      getLytOverviewContent({ vaultName: args.name, desc: args.desc, owner }),
    );
    written.push(LYT_OVERVIEW_REL_WRITE_PATH);
  }

  // README: regenReadme writes-if-absent (managed-block) AND marker-bounded-
  // regens-if-present (diff-guarded). Mirrors the agents.md conformance below.
  const readmeRes = regenReadme(args.vaultPath, args.name);
  if (readmeRes.written) written.push("README.md");

  // agents.md: regenAgentsMd writes-if-absent (sentinel-bearing) AND
  // marker-bounded-regens-if-present. Either way the conformant file lands.
  // Phase D (SC6) — regenAgentsMd resolves `.lyt/` (new) vs legacy root; report
  // the actual relative path it wrote (vault-relative POSIX).
  const r = regenAgentsMd(args.vaultPath, args.name);
  if (r.written) {
    written.push(relative(args.vaultPath, r.path).split(sep).join(posix.sep));
  }

  return { written };
}

function runGitInit(vaultPath: string): boolean {
  try {
    execSync("git init --initial-branch=main", {
      cwd: vaultPath,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

// Per Phase 5.5 smoke Observation #2: opt-in helper to commit only the lyt
// scaffold (explicit path list, never `git add -A`) so a user's pre-existing
// files in --path <existing-dir> are not auto-committed.
//
// Phase D (SC6) — the agent-priming files (`agents.md`, `lyt-overview.md`) now
// live under `.lyt/`, so they are committed transitively by the `.lyt` entry
// here. They ALSO appear in the per-call `primingFiles` list (as
// `.lyt/agents.md` / `.lyt/lyt-overview.md`) appended in runInitialCommit — the
// overlap is harmless (`git add` is idempotent). README + seed Figments stay in
// the vault tree (README.md + notes/* below).
const SCAFFOLD_COMMIT_PATHS = [".lyt", ".obsidian", ".gitignore", "README.md", "notes/.gitkeep"];

function runInitialCommit(vaultPath: string, primingFiles: readonly string[]): boolean {
  try {
    const paths = [...SCAFFOLD_COMMIT_PATHS, ...primingFiles];
    const args = paths.map((p) => `"${p}"`).join(" ");
    execSync(`git add ${args}`, {
      cwd: vaultPath,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync('git commit -m "chore: lyt vault init scaffold"', {
      cwd: vaultPath,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}
