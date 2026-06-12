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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getIdentity, validateVaultName } from "../util/identity.js";
import { newUuidv7Bytes } from "../util/uuid7.js";
import { resolveVaultPath } from "../util/paths.js";
import {
  DEFAULT_TEMPLATE,
  type TemplateName,
  getObsidianScaffold,
  getReadmeContent,
  getVaultGitignore,
} from "../templates/index.js";
import {
  AGENTS_MD_TEMPLATE_VERSION,
  getAgentsMdContent,
  getLytOverviewContent,
  getNotesIndexContent,
} from "../templates/priming.js";
import { writeMeshContextFile } from "./mesh-context.js";
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

function writeReadme(vaultPath: string, name: string): void {
  writeFile(join(vaultPath, "README.md"), getReadmeContent(name));
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
    "# `lyt audit export` writes per-window markdown files here (arc §8.4).\n",
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
}

function writePrimingFiles(args: WritePrimingFilesArgs): string[] {
  const written: string[] = [];

  const overviewPath = join(args.vaultPath, "lyt-overview.md");
  writeFile(
    overviewPath,
    getLytOverviewContent({ vaultName: args.name, desc: args.desc, owner: args.owner }),
  );
  written.push("lyt-overview.md");

  writeMeshContextFile(args.vaultPath, {
    vaultName: args.name,
    parentVaultRid: args.parentVaultDisplay,
    shareWith: [],
    acceptsFrom: [],
    desc: args.desc ?? null,
  });
  written.push(".lyt/mesh-context.md");

  const agentsPath = join(args.vaultPath, "agents.md");
  writeFile(agentsPath, getAgentsMdContent({ vaultName: args.name }));
  written.push("agents.md");

  if (args.starterFigment) {
    const starterPath = join(args.vaultPath, "notes", "index.md");
    writeFile(starterPath, getNotesIndexContent(args.name));
    written.push("notes/index.md");
  }

  return written;
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
