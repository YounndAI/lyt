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

// v1.G.10 — pod-map vault generator. Emits a markdown-vault visualisation
// of the handler's pod: one note per registered mesh + one note per
// registered vault + Obsidian-wikilink edges encoding @MESH_EDGE / @MESH_HOME
// / @MESH_SUBSCRIPTION relationships. Opens in Obsidian's graph view to
// render the pod's federation topology natively.
//
// Per the ratified default Option A (ratified by Alex 2026-06-01 ) + the pod-map
// vault lives FLAT at `<vaults-root>/lyt-pod-map/` — alongside the handler's
// other vaults (no `<owner>` segment, matching paths.ts resolveVaultPath),
// NOT inside `alex/main` as a section. The owner is still threaded into the
// vault's content/id, only the on-disk PATH lost the owner segment. The
// vault.kind discriminator (`pod-map`) keeps the regular registry-vault
// machinery from treating it as a federation participant: the generator
// is the sole writer, and the markdown content is regenerated on
// each `/lyt-sync` or wizard P9 invocation.
//
// Two callers per the ratified default (ratified Alex 2026-06-01): wizard P9 init
// (first-time auto-generation during `lyt init --wizard`) and a future
// `/lyt-sync` post-pull hook (deferred per @DELTA_FROM_BRIEF — see retro;
// /lyt-sync ships as SKILL.md only and has no TS hook surface to wire
// the regen into without modifying skill prose). File-watcher trigger is
// out of scope per the same the ratified default + master-plan post-alpha gate.
//
// Determinism (Lock 0.3 per v1.D.5 canvas-* precedent — see
// canvas-federation.ts:31-35): meshes sorted by name ASC; vaults sorted
// by name ASC; wikilinks sorted by target ASC. Same registry state +
// same `--now-iso` → byte-identical markdown output. Test (T1) asserts.
//
// Writable-flag enforcement (per the ratified default + brief acceptance clause (a)(ix)):
// pod-map vault is NOT registered in the lyt registry — it's a generated
// artifact, not a federation vault. `vault.kind: pod-map` discriminates;
// every vault-note carries `vault.writable: true|false|unknown` mirrored
// from the live G.2 writability derivation per registered vault. The
// Pod Manager plugin (`packages/lyt-vault/obsidian-plugins/lyt-pod-manager/`)
// reads this frontmatter to render 🔒 badges on non-writable nodes. See
// @DELTA_FROM_BRIEF in retro — brief assumes `initVaultFlow` takes a
// `writable: false` arg, but writability is derived per G.2; direct
// emission is the cleanest path.
//
// Destination-write-symlink-follow defence (per G.5 NEW family seed +
// G.4 2nd-instance close; G.10 = 3rd-instance candidate per Blueprint
// §2.7 floor): every handler-controlled write target (pod-map vault root
// + meshes/ + vaults/ + .obsidian/ + plugins/ + plugin folder) gets a
// pre-write lstatSync 3-point defence mirroring wizard.ts:546-579.

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve as pathResolve } from "node:path";

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { listEdgesByRefMesh } from "../registry/mesh-edges-repo.js";
import { listSubscriptionsForMesh } from "../registry/mesh-subscriptions-repo.js";
import { listVaultsInMesh } from "../registry/mesh-vaults-repo.js";
import { listMeshes, type MeshRow } from "../registry/meshes-repo.js";
import { getVaultByRid, type VaultRow } from "../registry/repo.js";
import { slugifyHandle } from "../util/federation-paths.js";
import { getDefaultVaultsRoot } from "../util/paths.js";
import { slugifyVaultName } from "../util/identity.js";
import { deriveVaultWritable, type WritabilityVerdict } from "./writability.js";

export interface PodMapArgs {
  // GitHub handle / owner under which the pod-map vault is keyed. Per
  // the ratified default: a missing or empty owner makes the generator refuse with
  // `ok: false` — no stub-mode fallback (the multi-org composition per
  // requires a known owner to disambiguate the write target).
  owner: string;
  // Vaults root under which the pod-map vault is written. Defaults to
  // `getDefaultVaultsRoot()` (`<lyt-home>/vaults`); tests override via
  // LYT_HOME env (same shape as canvas-federation tests).
  vaultsRoot?: string;
  // Deterministic timestamp seam — every emitted frontmatter
  // `last-regenerated` value uses this. When omitted, falls back to
  // `new Date().toISOString()`. Tests pass a fixed value to assert
  // byte-equal output across runs.
  nowIso?: string;
  // Injectable registry-db seam (mirrors canvas-* args.registryDb).
  // When omitted, the generator opens + closes its own registry.
  registryDb?: Client;
}

export interface PodMapVaultPaths {
  // Pod-map vault root: `<vaultsRoot>/<sluggedOwner>/lyt-pod-map/` (user-facing
  // dir name; `vault.kind: pod-map` stays the internal discriminator the plugin keys on).
  root: string;
  // `<root>/.lyt/`
  lytDir: string;
  // `<root>/meshes/`
  meshesDir: string;
  // `<root>/vaults/`
  vaultsDir: string;
  // `<root>/.obsidian/`
  obsidianDir: string;
  // `<root>/.obsidian/plugins/`
  obsidianPluginsDir: string;
  // `<root>/.obsidian/plugins/lyt-pod-manager/`
  pluginInstallDir: string;
}

export interface PodMapResult {
  ok: boolean;
  // Pod-map vault root path. Populated even on `ok:false` (caller may
  // surface it in the error message).
  vaultPath: string;
  // Populated when `ok:false`. One of:
  // - "handle-unknown": args.owner missing or empty (the ratified default refuse).
  // - "symlink-refused": one of the destination paths is a symlink.
  // - "internal": unexpected throw from the registry / fs layer.
  error?: string;
  // Detailed paths for downstream consumers (wizard P9b plugin install).
  paths: PodMapVaultPaths;
  // Count of meshes enumerated from the registry.
  meshCount: number;
  // Count of vaults enumerated from the registry.
  vaultCount: number;
  // Count of markdown notes emitted (meshes/ + vaults/ + README).
  notesEmitted: number;
  // Wall-clock for the regen — tracked toward brief's "<500ms typical"
  // claim so we can validate in the retro.
  durationMs: number;
}

const POD_MAP_VAULT_KIND = "pod-map";
const GENERATOR_TAG = "lyt-pod-map-generator";

export async function generatePodMapFlow(args: PodMapArgs): Promise<PodMapResult> {
  const startedAt = Date.now();
  const nowIso = args.nowIso ?? new Date().toISOString();

  if (typeof args.owner !== "string" || args.owner.trim().length === 0) {
    // the ratified default refuse: owner unknown → no fallback. The wizard's P8
    // federation init populates the handle before P9 calls us; a
    // missing handle indicates the federation init failed AND the
    // handler proceeded anyway (a defensive caller error).
    return {
      ok: false,
      error: "handle-unknown",
      vaultPath: "",
      paths: emptyPaths(),
      meshCount: 0,
      vaultCount: 0,
      notesEmitted: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const ownerSlug = slugifyHandle(args.owner);
  const vaultsRoot = args.vaultsRoot ?? getDefaultVaultsRoot();
  const paths = derivePodMapPaths(vaultsRoot, ownerSlug);

  // Destination-write-symlink-follow defence (Blueprint §2.7 family
  // 3rd-instance candidate). Each path is checked twice: once before
  // mkdirSync (so we don't follow a symlink into an attacker's target)
  // and the meshes/+vaults/ dirs additionally on rmSync (idempotent
  // regen would otherwise blow away symlinked content). Mirrors
  // wizard.ts:546-579 + G.4 retro Cor-C1/Sec-M2.
  const symlinkCheck = checkSymlinks([
    paths.root,
    paths.lytDir,
    paths.meshesDir,
    paths.vaultsDir,
    paths.obsidianDir,
    paths.obsidianPluginsDir,
    paths.pluginInstallDir,
  ]);
  if (symlinkCheck !== null) {
    return {
      ok: false,
      error: symlinkCheck,
      vaultPath: paths.root,
      paths,
      meshCount: 0,
      vaultCount: 0,
      notesEmitted: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const callerSuppliedRegistry = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());

  try {
    // Enumerate. Sort meshes + vaults by name ASC for Lock 0.3
    // determinism. listMeshes() already ORDERs BY name; defensive
    // re-sort guards against future SQL drift.
    const meshes = [...(await listMeshes(db))].sort(byNameAsc);

    // For each mesh: home vaults (role=home), subscribed vaults
    // (role=subscribed), outgoing edges (mesh.yon @MESH_EDGE rows
    // owned by this mesh), incoming subscriptions (other meshes that
    // subscribe to this mesh's vaults).
    const meshContexts: MeshContext[] = [];
    const seenVaultRids = new Map<string, VaultRow>();
    for (const m of meshes) {
      const memberRows = await listVaultsInMesh(db, m.rid);
      const homeRefs: VaultRef[] = [];
      const subscribedRefs: VaultRef[] = [];
      for (const mv of memberRows) {
        const v = await getVaultByRid(db, mv.vaultRid);
        if (v === null) continue;
        seenVaultRids.set(v.ridHex, v);
        const ref: VaultRef = { name: v.name, ridHex: v.ridHex };
        if (mv.role === "home") homeRefs.push(ref);
        else subscribedRefs.push(ref);
      }
      homeRefs.sort(byNameAsc);
      subscribedRefs.sort(byNameAsc);

      const outgoingEdges = await listEdgesByRefMesh(db, m.rid);
      const incomingSubs = await listSubscriptionsForMesh(db, m.rid);

      meshContexts.push({
        mesh: m,
        homeRefs,
        subscribedRefs,
        // Edge ridHex list — name-resolution + sort happens in a 2nd
        // pass after meshNameByRidHex is built, so wikilinks emit in
        // mesh-NAME order (per release review fix; the prior code
        // sorted by ridHex which gave visually-arbitrary order).
        outgoingEdgeMeshRids: outgoingEdges.map((e) => e.homeMeshRidHex),
        incomingSubMeshNames: incomingSubs.map((s) => s.externalMeshName).sort(),
      });
    }

    // Resolve writability for every enumerated vault. The G.2 derivation
    // hits gh once per non-orphan vault (in-process cache de-dups across
    // generator invocations); orphan vaults short-circuit.
    const writabilityByVaultRid = new Map<string, WritabilityVerdict>();
    for (const v of seenVaultRids.values()) {
      try {
        writabilityByVaultRid.set(v.ridHex, await deriveVaultWritable(v, db));
      } catch {
        writabilityByVaultRid.set(v.ridHex, {
          writable: "unknown",
          reason: "gh-unavailable",
        });
      }
    }

    // Idempotency: regen against an existing pod-map vault must not
    // leave orphan notes from now-removed meshes/vaults. Strategy: scan
    // existing meshes/ + vaults/ dirs, compute the target filename set,
    // remove any .md file not in the target set. New files land via
    // writeFileSync below. atomicWrite pattern (write to .tmp then
    // rename) keeps each note crash-safe.
    mkdirSync(paths.lytDir, { recursive: true });
    mkdirSync(paths.meshesDir, { recursive: true });
    mkdirSync(paths.vaultsDir, { recursive: true });

    // Vault note set: emitted as one note per registered vault, named by
    // slugified vault name. Vault name may be `<owner>/<repo>`; the
    // slugifier collapses `/` to `-`.
    const targetVaultNoteNames = new Set<string>();
    const sortedVaults = [...seenVaultRids.values()].sort(byNameAsc);
    for (const v of sortedVaults) {
      targetVaultNoteNames.add(`${slugifyVaultName(v.name)}.md`);
    }
    pruneOrphans(paths.vaultsDir, targetVaultNoteNames);

    // Mesh note set: emitted as one note per mesh, named by slugified
    // mesh name (mesh names are bare slugs per validateMeshName; no
    // slash collapse needed but slugifier kept for defence).
    const targetMeshNoteNames = new Set<string>();
    for (const ctx of meshContexts) {
      targetMeshNoteNames.add(`${slugifyVaultName(ctx.mesh.name)}.md`);
    }
    pruneOrphans(paths.meshesDir, targetMeshNoteNames);

    // Write .lyt/vault.yon with vault.kind discriminator (the Pod
    // Manager plugin reads this to decide it should activate; the
    // generator is the sole writer; G.2 writability machinery treats
    // unregistered vaults as no-op).
    const vaultYonContent = renderPodMapVaultYon(args.owner, nowIso);
    atomicWriteFile(join(paths.lytDir, "vault.yon"), vaultYonContent);

    // Build a meshName-by-ridHex index so vault notes can wikilink to
    // their parent mesh in slug form (the mesh notes file names are
    // slugified too).
    const meshNameByRidHex = new Map<string, string>();
    for (const ctx of meshContexts) {
      meshNameByRidHex.set(ctx.mesh.ridHex, ctx.mesh.name);
    }
    // Index vaults to find their parent mesh (the mesh where role=home).
    const homeMeshByVaultRid = new Map<string, string>();
    for (const ctx of meshContexts) {
      for (const v of ctx.homeRefs) {
        if (!homeMeshByVaultRid.has(v.ridHex)) {
          homeMeshByVaultRid.set(v.ridHex, ctx.mesh.name);
        }
      }
    }

    let notesEmitted = 0;

    // mesh.mainVaultRid → vault.name lookup (for mesh-home-vault
    // frontmatter field per release review; fall back to first
    // homeRef when mainVaultRid is unset OR the row was pruned).
    const mainVaultNameByMeshRidHex = new Map<string, string>();
    for (const ctx of meshContexts) {
      if (ctx.mesh.mainVaultRid !== null) {
        const main = await getVaultByRid(db, ctx.mesh.mainVaultRid);
        if (main !== null) {
          mainVaultNameByMeshRidHex.set(ctx.mesh.ridHex, main.name);
          continue;
        }
      }
      if (ctx.homeRefs.length > 0) {
        mainVaultNameByMeshRidHex.set(ctx.mesh.ridHex, ctx.homeRefs[0]!.name);
      }
    }

    // Emit mesh notes. Outgoing-edge wikilinks resolve ridHex → mesh
    // name → sort by name ASC (a review finding fix; the prior code sorted by
    // ridHex which gave visually-arbitrary alphabetisation).
    for (const ctx of meshContexts) {
      const memberVaultLinks = [...ctx.homeRefs, ...ctx.subscribedRefs]
        .map((v) => slugifyVaultName(v.name))
        .sort();
      const outgoingEdgeTargets = ctx.outgoingEdgeMeshRids
        .map((rid) => meshNameByRidHex.get(rid))
        .filter((n): n is string => n !== undefined)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((n) => slugifyVaultName(n));
      const incomingSubLinks = ctx.incomingSubMeshNames.map((n) => slugifyVaultName(n));
      const meshNoteName = slugifyVaultName(ctx.mesh.name);
      const meshNoteContent = renderMeshNote({
        meshName: ctx.mesh.name,
        meshRidHex: ctx.mesh.ridHex,
        meshHomeVault: mainVaultNameByMeshRidHex.get(ctx.mesh.ridHex),
        memberCount: ctx.homeRefs.length + ctx.subscribedRefs.length,
        nowIso,
        memberVaultLinks,
        outgoingEdgeTargets,
        incomingSubLinks,
      });
      atomicWriteFile(join(paths.meshesDir, `${meshNoteName}.md`), meshNoteContent);
      notesEmitted += 1;
    }

    // Emit vault notes.
    for (const v of sortedVaults) {
      const homeMeshName = homeMeshByVaultRid.get(v.ridHex);
      const verdict = writabilityByVaultRid.get(v.ridHex) ?? {
        writable: "unknown",
        reason: "orphan-vault",
      };
      const vaultNoteName = slugifyVaultName(v.name);
      const vaultNoteContent = renderVaultNote({
        vaultName: v.name,
        vaultRidHex: v.ridHex,
        homeMeshName,
        writable: verdict.writable,
        writableReason: verdict.reason,
        nowIso,
      });
      atomicWriteFile(join(paths.vaultsDir, `${vaultNoteName}.md`), vaultNoteContent);
      notesEmitted += 1;
    }

    // Emit README (orientation copy per the ratified default — 5-10 lines). NOT counted
    // toward notesEmitted (it's documentation, not a topology node).
    atomicWriteFile(
      join(paths.root, "README.md"),
      renderReadme(args.owner, meshes.length, sortedVaults.length, nowIso),
    );

    return {
      ok: true,
      vaultPath: paths.root,
      paths,
      meshCount: meshes.length,
      vaultCount: sortedVaults.length,
      notesEmitted,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `internal: ${msg}`,
      vaultPath: paths.root,
      paths,
      meshCount: 0,
      vaultCount: 0,
      notesEmitted: 0,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (!callerSuppliedRegistry) await closeRegistry(db);
  }
}

// ---------------------------------------------------------------------------
// Plugin install — exported for wizard P9b consumption (the ratified default Phase 1
// wizard-install + condition 4 conflict-handling).
// ---------------------------------------------------------------------------

export interface InstallPluginArgs {
  pluginInstallDir: string;
  pluginSourceDir: string;
}

export interface InstallPluginResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
}

/**
 * Copy the Pod Manager plugin folder into the pod-map vault's
 * `.obsidian/plugins/lyt-pod-manager/` directory. Per the ratified default condition 4,
 * if a community-store-installed copy already exists (detected via
 * existing manifest.json), the wizard install is SKIPPED — defers to
 * the user-controlled store install so semver doesn't drift.
 *
 * Source dir contract: must contain `manifest.json` and `main.js`. The
 * caller (wizard P9b) is responsible for pointing this at the built
 * artifact under `packages/lyt-vault/obsidian-plugins/lyt-pod-manager/`.
 */
export function installPodManagerPlugin(args: InstallPluginArgs): InstallPluginResult {
  const existingManifest = join(args.pluginInstallDir, "manifest.json");
  if (existsSync(existingManifest)) {
    return {
      ok: true,
      skipped: true,
      reason: `plugin already installed at ${args.pluginInstallDir} (community-store or prior wizard run); skipping copy to preserve semver lockstep (the ratified default condition 4).`,
    };
  }
  const sourceManifest = join(args.pluginSourceDir, "manifest.json");
  if (!existsSync(sourceManifest)) {
    return {
      ok: false,
      skipped: false,
      reason: `plugin source dir ${args.pluginSourceDir} is missing manifest.json — build the plugin first (cd ${args.pluginSourceDir} && npm install && npm run build).`,
    };
  }
  // Symlink defence on the install target before cpSync follows links
  // recursively (cpSync's `dereference: false` keeps symlinks as
  // symlinks but we explicitly refuse a symlinked install dir).
  if (existsSync(args.pluginInstallDir) && lstatSync(args.pluginInstallDir).isSymbolicLink()) {
    return {
      ok: false,
      skipped: false,
      reason: `plugin install dir is a symlink: ${args.pluginInstallDir} (refusing for destination-write-symlink-follow defence).`,
    };
  }
  mkdirSync(args.pluginInstallDir, { recursive: true });
  // Copy manifest.json + main.js + data.json (if present) + any other
  // top-level files from the source dir. Recursive=false keeps the copy
  // shallow — plugin source is flat.
  for (const entry of readdirSync(args.pluginSourceDir, { withFileTypes: true })) {
    if (entry.isFile()) {
      const src = join(args.pluginSourceDir, entry.name);
      const dst = join(args.pluginInstallDir, entry.name);
      cpSync(src, dst);
    }
  }
  return { ok: true, skipped: false };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface VaultRef {
  name: string;
  ridHex: string;
}

interface MeshContext {
  mesh: MeshRow;
  homeRefs: VaultRef[];
  subscribedRefs: VaultRef[];
  outgoingEdgeMeshRids: string[];
  incomingSubMeshNames: string[];
}

function derivePodMapPaths(vaultsRoot: string, ownerSlug: string): PodMapVaultPaths {
  if (ownerSlug.length === 0) {
    return emptyPaths();
  }
  // the pod-map vault sits FLAT under `vaults/` at
  // `~/lyt/vaults/lyt-pod-map/` — the `<owner>` path segment is dropped so it
  // matches regular vaults (`~/lyt/vaults/<name>` per paths.ts resolveVaultPath)
  // and resolves the mesh-vs-owner grouping inconsistency. `owner` is still
  // required (the empty-string check above is the handle-unknown gate) and is
  // still threaded into content/display (renderPodMapVaultYon id, README).
  const root = pathResolve(vaultsRoot, "lyt-pod-map");
  return {
    root,
    lytDir: join(root, ".lyt"),
    meshesDir: join(root, "meshes"),
    vaultsDir: join(root, "vaults"),
    obsidianDir: join(root, ".obsidian"),
    obsidianPluginsDir: join(root, ".obsidian", "plugins"),
    pluginInstallDir: join(root, ".obsidian", "plugins", "lyt-pod-manager"),
  };
}

function emptyPaths(): PodMapVaultPaths {
  return {
    root: "",
    lytDir: "",
    meshesDir: "",
    vaultsDir: "",
    obsidianDir: "",
    obsidianPluginsDir: "",
    pluginInstallDir: "",
  };
}

function checkSymlinks(candidates: readonly string[]): string | null {
  for (const p of candidates) {
    if (p.length === 0) continue;
    if (!existsSync(p)) continue;
    try {
      if (lstatSync(p).isSymbolicLink()) {
        return `symlink-refused: ${p}`;
      }
    } catch (err) {
      return `lstat-failed: ${p} (${(err as Error).message})`;
    }
  }
  return null;
}

function pruneOrphans(dir: string, keepNames: ReadonlySet<string>): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    if (keepNames.has(entry.name)) continue;
    try {
      unlinkSync(join(dir, entry.name));
    } catch {
      // best-effort
    }
  }
}

// Atomic write — mirrors canvas-federation.ts:415-422 (write tmp +
// rename). Cross-platform safe (rename is atomic on POSIX + Windows for
// same-volume writes; pod-map vault is one tree so all writes are same
// volume by construction).
function atomicWriteFile(targetPath: string, contents: string): void {
  const parentSep = Math.max(targetPath.lastIndexOf("/"), targetPath.lastIndexOf("\\"));
  if (parentSep > 0) {
    mkdirSync(targetPath.slice(0, parentSep), { recursive: true });
  }
  const tmpPath = `${targetPath}.${process.pid}-${nextTmpCounter()}.tmp`;
  writeFileSync(tmpPath, contents, "utf8");
  // Rename (atomic). On Windows, the destination must not exist; rmSync
  // first if it does (idempotent regen — we WANT to replace).
  if (existsSync(targetPath)) {
    try {
      rmSync(targetPath, { force: true });
    } catch {
      // best-effort; rename will surface the real error
    }
  }
  renameSync(tmpPath, targetPath);
}

let tmpCounterValue = 0;
function nextTmpCounter(): number {
  tmpCounterValue += 1;
  return tmpCounterValue;
}

function byNameAsc<T extends { name: string }>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Frontmatter renderers
// ---------------------------------------------------------------------------

function renderPodMapVaultYon(owner: string, nowIso: string): string {
  return (
    `@DOC ver=1 | id=pod-map-${slugifyHandle(owner)} | created_by=${GENERATOR_TAG} | last_regenerated=${nowIso}\n` +
    `@VAULT kind=${POD_MAP_VAULT_KIND} | owner=${owner} | writable=false | generator-managed=true\n`
  );
}

interface MeshNoteArgs {
  meshName: string;
  meshRidHex: string;
  meshHomeVault?: string | undefined;
  memberCount: number;
  nowIso: string;
  memberVaultLinks: readonly string[];
  outgoingEdgeTargets: readonly string[];
  incomingSubLinks: readonly string[];
}

function renderMeshNote(args: MeshNoteArgs): string {
  // release review fix: mesh-home-vault field bridges the per-mesh
  // canonical anchor (mesh.mainVaultRid → vault.name) to the markdown.
  // Empty/missing falls back to "(none)" so handlers see explicit
  // absence rather than a blank value.
  const homeVaultValue =
    args.meshHomeVault !== undefined && args.meshHomeVault.length > 0
      ? args.meshHomeVault
      : "(none)";
  const fm =
    `---\n` +
    `vault.kind: pod-map-mesh-note\n` +
    `mesh-name: ${args.meshName}\n` +
    `mesh-rid: ${args.meshRidHex}\n` +
    `mesh-home-vault: ${homeVaultValue}\n` +
    `member-count: ${args.memberCount}\n` +
    `created-by: ${GENERATOR_TAG}\n` +
    `last-regenerated: ${args.nowIso}\n` +
    `---\n\n`;
  const body =
    `# Mesh: ${args.meshName}\n\n` +
    `Member vaults:\n\n` +
    (args.memberVaultLinks.length === 0
      ? `- _(no member vaults registered)_\n`
      : args.memberVaultLinks.map((n) => `- [[../vaults/${n}]]`).join("\n") + "\n") +
    `\nOutgoing edges (this mesh references):\n\n` +
    (args.outgoingEdgeTargets.length === 0
      ? `- _(none)_\n`
      : args.outgoingEdgeTargets.map((n) => `- [[../meshes/${n}]]`).join("\n") + "\n") +
    `\nIncoming subscriptions (this mesh is subscribed by):\n\n` +
    (args.incomingSubLinks.length === 0
      ? `- _(none)_\n`
      : args.incomingSubLinks.map((n) => `- [[../meshes/${n}]]`).join("\n") + "\n");
  return fm + body;
}

interface VaultNoteArgs {
  vaultName: string;
  vaultRidHex: string;
  homeMeshName?: string | undefined;
  writable: WritabilityVerdict["writable"];
  writableReason: WritabilityVerdict["reason"];
  nowIso: string;
}

function renderVaultNote(args: VaultNoteArgs): string {
  const writableValue =
    args.writable === true ? "true" : args.writable === false ? "false" : "unknown";
  const fm =
    `---\n` +
    `vault.kind: pod-map-vault-note\n` +
    `vault-name: ${args.vaultName}\n` +
    `vault-rid: ${args.vaultRidHex}\n` +
    `mesh-membership: ${args.homeMeshName ?? "(orphan)"}\n` +
    `vault.writable: ${writableValue}\n` +
    `vault.writable-determination: ${args.writableReason}\n` +
    `created-by: ${GENERATOR_TAG}\n` +
    `last-regenerated: ${args.nowIso}\n` +
    `---\n\n`;
  const meshLink =
    args.homeMeshName !== undefined && args.homeMeshName.length > 0
      ? `Member of: [[../meshes/${slugifyVaultName(args.homeMeshName)}]]\n`
      : `Member of: _(orphan vault — not assigned to any mesh)_\n`;
  const body =
    `# Vault: ${args.vaultName}\n\n` +
    meshLink +
    `\nWritable: \`${writableValue}\` (${args.writableReason})\n`;
  return fm + body;
}

function renderReadme(
  owner: string,
  meshCount: number,
  vaultCount: number,
  nowIso: string,
): string {
  return (
    `# Pod-map for \`${owner}\`\n\n` +
    `> Generated by \`lyt-pod-map-generator\` at ${nowIso}. ` +
    `${meshCount} mesh(es), ${vaultCount} vault(s).\n\n` +
    `This vault visualises your pod's federation topology. ` +
    `Each \`meshes/\` note represents one mesh; each \`vaults/\` note represents ` +
    `one vault. Wikilinks encode federation edges. **Open this vault in Obsidian ` +
    `and switch to graph view** to render the topology natively; install the ` +
    `Pod Manager community plugin (bundled under \`.obsidian/plugins/lyt-pod-manager/\`) ` +
    `for mesh-boundary coloring and 🔒 read-only badges.\n\n` +
    `_This vault is generator-managed (\`vault.kind: pod-map\` + \`writable: false\`). ` +
    `Do not edit notes here — they are overwritten on every \`lyt init --wizard\` re-run ` +
    `or future \`/lyt-sync\` regen hook. **Do not place new files under \`meshes/\` or ` +
    `\`vaults/\` — orphan files are silently removed on next regen** (release review)._\n`
  );
}
