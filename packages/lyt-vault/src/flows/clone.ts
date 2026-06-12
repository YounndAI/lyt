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

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { addVaultToMesh } from "../registry/mesh-vaults-repo.js";
import { getMeshByName, getMeshByRid, insertMesh, type MeshRow } from "../registry/meshes-repo.js";
import {
  getVaultByName,
  getVaultByPath,
  getVaultByRid,
  setVaultHomeMesh,
  type VaultRow,
} from "../registry/repo.js";
import { appendMeshHomeToFile } from "../registry/vault-home-mesh-helpers.js";
import { newUuidv7Bytes, uuid7BytesToDashedString } from "../util/uuid7.js";
import { parseVaultRepoName } from "../util/federation-paths.js";
import { getDefaultVaultsRoot } from "../util/paths.js";
import { rmWithRetry } from "../scaffold/delete.js";
import { renderVaultYon } from "../yon/vault.js";
import { parseVaultYon } from "../yon/parse.js";
import { hexToUuid7Bytes } from "../util/uuid7.js";
import { joinVaultFlow, type JoinResult } from "./join.js";

// v1.B.3 — `lyt vault clone` extended with a `--to-mesh <name>` option.
//
// Default (no --to-mesh): URL-based clone into ~/lyt/vaults, registered as
// a new rid via joinVaultFlow. Bit-identical to v1.B.2 HEAD.
//
// With --to-mesh <mesh-name>: the cloned vault gets a FRESH UUIDv7 rid
// (NOT the source rid — per master-plan §526 "new rid; original preserved")
// and the target mesh.yon gains a @MESH_HOME row. The source vault is
// untouched. Use cases: graduating a public template into your own pod;
// importing reference content with provenance to your own mesh.
//
// Acceptance (brief A6): when --to-mesh is omitted, behavior is bit-
// identical to v1.B.2 HEAD; when --to-mesh is set, the target rid is a
// fresh UUIDv7 (NOT copied from source).

export interface CloneOptions {
  url: string;
  name?: string | undefined;
  parentDir?: string | undefined;
  // v1.B.3 — when set, the cloned vault is freshly-rid'd, written with
  // @VAULT_HOME_MESH pointing at this mesh, and the mesh's main vault's
  // mesh.yon gains a @MESH_HOME row. Mesh must already exist in the local
  // registry — clone --to-mesh does NOT auto-create the target mesh
  // (Plan-D1: explicit mesh-init for non-personal namespaces).
  toMesh?: string | undefined;
  // Open-once seam — when omitted the flow opens its own registry; caller
  // owns lifecycle when supplied.
  registryDb?: Client | undefined;
  // Override the assigned_at timestamp; defaults to `new Date().toISOString()`.
  // Tests pin for deterministic round-trip assertions.
  nowIso?: string | undefined;
  // Track C Wave 3 F8 + release review — CALLER INTENT, never automatic.
  // true = the clone is a NEW standalone vault (the `lyt vault clone
  // --to-mesh` graduate-a-template case): detach the inherited `origin` (the
  // SOURCE vault's repo) + drop the inherited gitUrl, so the new vault
  // starts remote-less and earns its own repo at first publish. Pre-fix the
  // unconditional keep pushed one vault's tree onto another vault's remote
  // (live incident); but an unconditional DETACH breaks the OTHER --to-mesh
  // callers — subscribeFlow's clone-on-subscribe and mesh-adopt's member
  // clones MUST keep origin to pull upstream (release review). Default
  // false = keep origin (subscriber/adopt semantics; the writable verdict
  // gates pushes).
  detachOrigin?: boolean | undefined;
  // hardening pass (subscriber-onboarding fix-pass, 2026-06-11) — SUBSCRIBER INTENT.
  // When true and the --to-mesh target is not registered locally, register an
  // external-mesh RECORD (a meshes row with main_vault_rid NULL — no
  // scaffolded `<foreign>/main` vault, no foreign mesh.yon) and proceed. A
  // consumer must never be told to `lyt mesh init` another owner's mesh.
  // Default false: the standalone `vault clone --to-mesh` path keeps refusing
  // on an unregistered target (Plan-D1 — explicit mesh-init for meshes the
  // user OWNS). subscribeFlow's clone-on-subscribe passes true.
  autoRegisterExternalMesh?: boolean | undefined;
}

export interface CloneResult extends JoinResult {
  cloneTargetPath: string;
  // v1.B.3 — set when --to-mesh applied; null otherwise. Carries the
  // home-mesh assignment that landed in vault.yon + mesh.yon.
  meshAssignment: {
    meshRidHex: string;
    meshName: string;
    freshRidApplied: boolean;
    // true when the target mesh did not exist locally and an
    // external-mesh record (main_vault_rid NULL) was auto-registered.
    externalMeshAutoRegistered: boolean;
  } | null;
  // Track C Wave 3 F8 — true when the clone's git `origin` (the SOURCE
  // vault's repo) was detached per the caller's detachOrigin intent. null
  // when detach was not requested (default URL-clone, subscribe-on-clone,
  // adopt member clones — keeping origin is the point there: subscriber
  // semantics; the writable verdict gates pushes).
  originDetached: boolean | null;
}

// Structured error: --to-mesh target not registered. CLI surfaces as exit 2.
export class CloneTargetMeshNotFoundError extends Error {
  readonly errorCode = "clone-target-mesh-not-found";
  readonly meshName: string;
  constructor(meshName: string) {
    // release review — the mesh-init advice carries
    // the YOUR-mesh hedge so this surface never re-issues the banned
    // "scaffold someone else's mesh" instruction.
    super(
      `lyt vault clone --to-mesh: no usable mesh registered with name '${meshName}'. ` +
        `If '${meshName}' is YOUR mesh, run 'lyt mesh init ${meshName}' first, then re-clone. ` +
        `To consume another owner's vault, use ` +
        `'lyt mesh subscribe --vault <mesh>/<vault> --from-mesh <your-mesh>' instead — ` +
        `never scaffold another owner's mesh locally.`,
    );
    this.name = "CloneTargetMeshNotFoundError";
    this.meshName = meshName;
  }
}

export async function cloneVaultFlow(opts: CloneOptions): Promise<CloneResult> {
  const name = opts.name ?? deriveNameFromUrl(opts.url);
  const parent = resolve(opts.parentDir ?? getDefaultVaultsRoot());
  const target = join(parent, name);

  // hardening pass release review — claim the target EXCLUSIVELY before cloning
  // (non-recursive mkdir throws EEXIST on a race). git clones happily into an
  // existing EMPTY dir, and from here on every dir this flow may remove is
  // provably one THIS call created — never a concurrent process's in-flight
  // clone that slipped between an existsSync probe and the clone.
  if (existsSync(target)) {
    throw cloneTargetExistsError(target);
  }
  mkdirSync(dirname(target), { recursive: true });
  try {
    mkdirSync(target);
  } catch {
    throw cloneTargetExistsError(target);
  }

  try {
    execFileSync("git", ["clone", opts.url, target], { stdio: "inherit" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // We claimed the dir above, so it is ours to sweep (no
    // half-state may block the retry).
    await removeFailedCloneDir(target);
    throw new Error(`git clone failed for ${opts.url}: ${msg}`);
  }

  // cleanup-on-failure: the dir was created by THIS call; if
  // registration fails after a successful git clone (the live hardening pass
  // shapes), remove it so the retry doesn't dead-end on
  // "Clone target already exists". The upstream repo still has everything.
  try {
    // v1.B.3 — when --to-mesh is set, mutate the cloned vault.yon BEFORE the
    // joinVaultFlow registers it: rewrite @VAULT.rid to a fresh UUIDv7, set
    // @VAULT.name to the clone-target name (so it doesn't collide with the
    // source's name in the registry), and add a @VAULT_HOME_MESH block
    // pointing at the target mesh. joinVaultFlow then re-parses the rewritten
    // vault.yon and registers the fresh (rid, name) pair.
    if (opts.toMesh !== undefined && opts.toMesh.length > 0) {
      const result = await cloneIntoTargetMesh({
        target,
        name,
        toMeshName: opts.toMesh,
        registryDb: opts.registryDb,
        nowIso: opts.nowIso ?? new Date().toISOString(),
        detachOrigin: opts.detachOrigin === true,
        autoRegisterExternalMesh: opts.autoRegisterExternalMesh === true,
      });
      return result;
    }

    // Default path: no --to-mesh; v1.B.2-identical behavior.
    const join_ = await joinVaultFlow(target);
    return { ...join_, cloneTargetPath: target, meshAssignment: null, originDetached: null };
  } catch (err) {
    // release review — scope the cleanup to failures AT-OR-BEFORE
    // registration. If the vault row already landed (a late best-effort step
    // died: initVaultDbs, pattern relink, the @MESH_HOME append), deleting
    // the dir would mint the INVERSE half-state — a registry row pointing at
    // nothing. Invariant: never remove a dir the registry references; the
    // retry then resolves via the already-registered path.
    if (!(await isVaultPathRegistered(target, opts.registryDb))) {
      await removeFailedCloneDir(target);
    }
    throw err;
  }
}

// the leftover-dir refusal names its remedies (the dir is NOT ours
// to delete: it predates this call or belongs to a concurrent clone).
// Post-fix-pass a FAILED clone removes its own claimed dir, so this fires
// only on genuinely pre-existing/raced dirs.
function cloneTargetExistsError(target: string): Error {
  return new Error(
    `Clone target already exists: ${target}. ` +
      `If it is a previous clone of the same vault, register it with ` +
      `'lyt vault join ${target}'; otherwise remove or rename the directory and re-run.`,
  );
}

// a review finding — cleanup gate: true when the registry already references this
// path. Conservative on probe failure (returns true → keep the dir; a
// surviving dir degrades to the actionable already-exists refusal).
async function isVaultPathRegistered(
  target: string,
  registryDb: Client | undefined,
): Promise<boolean> {
  const callerSupplied = registryDb !== undefined;
  let db: Client | null = null;
  try {
    db = registryDb ?? (await openRegistry());
    return (await getVaultByPath(db, target)) !== null;
  } catch {
    return true;
  } finally {
    if (!callerSupplied && db !== null) await closeRegistry(db);
  }
}

// best-effort removal of a clone dir THIS call created (claimed via
// the exclusive mkdir above). L0 destructive-delete conformance — the
// guarantee is RM-SEMANTICS-BASED, not git-config-based (release review
// a review finding): a cloned tree CAN contain symlinks when the user globally
// enabled core.symlinks (a Git-for-Windows installer option), so the
// load-bearing protections are (1) Node's rm lstats entries and UNLINKS
// reparse points/symlinks rather than descending them, and (2) the top-level
// lstat bail below. Do NOT replace rmWithRetry with a shell `rm -rf` — that
// is the exact 2026-06-03 junction-traversal incident vector. Removal rides
// the shared rmWithRetry 180s Windows budget (scaffold/delete.ts — per-vault
// libsql lock-release lag); in the common refusal paths no vault db was ever
// opened (joinVaultFlow registers BEFORE initVaultDbs) so attempt 1 wins.
// Cleanup failures are swallowed — the ORIGINAL error is the one the caller
// must see; a surviving dir degrades to the actionable already-exists
// refusal above.
async function removeFailedCloneDir(target: string): Promise<void> {
  try {
    if (!existsSync(target)) return;
    if (lstatSync(target).isSymbolicLink()) return;
    await rmWithRetry(target);
  } catch {
    // best-effort
  }
}

interface CloneIntoTargetMeshArgs {
  target: string;
  name: string;
  toMeshName: string;
  registryDb: Client | undefined;
  nowIso: string;
  detachOrigin: boolean;
  autoRegisterExternalMesh: boolean;
}

async function cloneIntoTargetMesh(args: CloneIntoTargetMeshArgs): Promise<CloneResult> {
  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());

  try {
    let meshRow: MeshRow | null = await getMeshByName(db, args.toMeshName);
    let externalMeshAutoRegistered = false;
    if (meshRow === null) {
      if (!args.autoRegisterExternalMesh) {
        throw new CloneTargetMeshNotFoundError(args.toMeshName);
      }
      // register the external mesh RECORD only: a meshes row with
      // main_vault_rid NULL. No `<foreign>/main` vault is scaffolded and no
      // foreign mesh.yon is written (asymmetric awareness — the vault's home
      // mesh never learns about its subscribers). Prefer the foreign mesh's
      // canonical rid from the cloned vault.yon's @VAULT_HOME_MESH when its
      // name matches (keeps subscription rows pointing at the mesh's true
      // federation identity); fall back to a fresh UUIDv7.
      //
      // release review — a published repo that is not a Lyt vault must
      // refuse actionably here, not leak a raw ENOENT from the read below.
      const sourceYonPath = join(args.target, ".lyt", "vault.yon");
      if (!existsSync(sourceYonPath)) {
        throw new Error(
          `The cloned repository at ${args.target} is not a Lyt vault ` +
            `(no .lyt/vault.yon). Only Lyt-published vaults can be subscribed; ` +
            `for a plain repo, clone it with git and run 'lyt vault adopt <path>' instead.`,
        );
      }
      const sourceParsed = parseVaultYon(readFileSync(sourceYonPath, "utf8"));
      let externalRid: Uint8Array | null = null;
      if (sourceParsed.homeMesh !== null && sourceParsed.homeMesh.meshName === args.toMeshName) {
        const candidate = hexToUuid7Bytes(sourceParsed.homeMesh.meshRid);
        if ((await getMeshByRid(db, candidate)) === null) {
          externalRid = candidate;
        }
      }
      try {
        await insertMesh(db, {
          rid: externalRid ?? newUuidv7Bytes(),
          name: args.toMeshName,
          mainVaultRid: null,
        });
      } catch {
        // release review — check-then-insert race: a concurrent
        // subscribe of another vault from the same foreign mesh can win the
        // insert between our getMeshByName probe and here. Converge on the
        // winner's row (re-read below) instead of surfacing raw
        // SQLITE_CONSTRAINT.
      }
      meshRow = await getMeshByName(db, args.toMeshName);
      if (meshRow === null) {
        throw new CloneTargetMeshNotFoundError(args.toMeshName); // defensive
      }
      externalMeshAutoRegistered = true;
    }
    // External mesh records carry no main vault — there is no local mesh.yon
    // to append @MESH_HOME to (and writing the FOREIGN mesh.yon is forbidden
    // by asymmetric awareness). Subscriber clones therefore skip the append.
    // A mesh whose main_vault_rid is SET but dangling stays a refusal on BOTH
    // paths (release review — that is local corruption, not an external
    // mesh; 'lyt repair' owns the heal).
    let mainVault: VaultRow | null = null;
    if (meshRow.mainVaultRid !== null) {
      mainVault = await getVaultByRid(db, meshRow.mainVaultRid);
      if (mainVault === null) {
        throw new CloneTargetMeshNotFoundError(args.toMeshName);
      }
    }
    if (mainVault === null && !args.autoRegisterExternalMesh) {
      throw new CloneTargetMeshNotFoundError(args.toMeshName);
    }

    // Track C Wave 3 F8 (+ release review/a review finding) — detach ONLY on caller
    // intent: a standalone fresh-rid clone pushes to its SOURCE otherwise
    // (live incident: writable:true on your own source + D49 self-heal
    // persisting the source URL → automator push landed one vault's tree on
    // another vault's remote). Subscribe/adopt clones pass detachOrigin:false
    // — they NEED origin to pull upstream. A real removal failure throws
    // (proceeding silently would leave the hazard live); only the benign
    // "No such remote" is absorbed.
    let originDetached: boolean | null = null;
    if (args.detachOrigin) {
      originDetached = false;
      try {
        execFileSync("git", ["remote", "remove", "origin"], { cwd: args.target, stdio: "pipe" });
        originDetached = true;
      } catch (err) {
        const stderr =
          err !== null && typeof err === "object" && "stderr" in err
            ? String((err as { stderr: unknown }).stderr ?? "")
            : "";
        if (/no such remote/i.test(stderr)) {
          // Already detached / cloned without origin — hazard absent.
          originDetached = true;
        } else {
          throw new Error(
            `clone --to-mesh: failed to detach the source origin at ${args.target} — ` +
              `refusing to register a standalone clone still pointing at its source repo ` +
              `(pushes would land on the SOURCE vault's remote). Underlying: ${stderr || String(err)}`,
          );
        }
      }
    }

    // Rewrite the cloned vault.yon: fresh rid + @VAULT_HOME_MESH block.
    const vaultYonPath = join(args.target, ".lyt", "vault.yon");
    const oldContent = readFileSync(vaultYonPath, "utf8");
    const parsed = parseVaultYon(oldContent);

    const freshRid = newUuidv7Bytes();
    const freshRidStr = uuid7BytesToDashedString(freshRid);
    const oldRidStr = parsed.rid;

    // Replace the rid string verbatim everywhere it appears in the file
    // (@DOC id=, @VAULT rid=, any other reference). vault.yon emits the
    // dashed-UUIDv7 form in two places (@DOC.id + @VAULT.rid); a literal
    // replace is safe because UUIDv7 strings don't appear as substrings of
    // other content.
    let rewritten = oldContent.split(oldRidStr).join(freshRidStr);

    // Insert/replace the @VAULT_HOME_MESH block. Easiest: re-parse the
    // rewritten content (with new rid), then re-render via renderVaultYon
    // using the parsed shape + the new homeMesh.
    const reparsed = parseVaultYon(rewritten);
    // Re-render via the canonical writer to get a clean @VAULT_HOME_MESH
    // block + canonical key order. We need to translate the parsed shape
    // back to the renderer's input shape; minor reconstruction here.
    const memscopeBytes = reparsed.memscopeRid ? hexToUuid7Bytes(reparsed.memscopeRid) : undefined;
    const parentBytes = reparsed.parentVault ? hexToUuid7Bytes(reparsed.parentVault) : undefined;
    rewritten = renderVaultYon({
      vault: {
        rid: freshRid,
        // v1.B.3 — clone --to-mesh sets vault.yon's @VAULT.name to the
        // clone-target name (args.name) so the registry's UNIQUE name
        // constraint doesn't collide with the source vault when both are
        // registered locally.
        name: args.name,
        ...(reparsed.desc !== null ? { desc: reparsed.desc } : {}),
        ...(parentBytes !== undefined ? { parentVault: parentBytes } : {}),
        ...(reparsed.tierHint !== null ? { tierHint: reparsed.tierHint } : {}),
        ...(memscopeBytes !== undefined ? { memscope: memscopeBytes } : {}),
        createdAt: reparsed.createdAt ?? args.nowIso,
        version: reparsed.version ?? "0.1",
      },
      // F8 — when detaching, never carry the SOURCE vault's gitUrl into the
      // fresh-rid clone's vault.yon: paired with the origin detach above,
      // the new vault starts remote-less and earns its own repo at first
      // publish. Subscribe/adopt clones (detachOrigin:false) keep it — it IS
      // their upstream.
      ...(!args.detachOrigin && reparsed.gitUrl !== null ? { gitUrl: reparsed.gitUrl } : {}),
      primaryOwner: reparsed.primaryOwner ?? "github:unknown",
      lifecycle:
        reparsed.lifecycle === "active" ||
        reparsed.lifecycle === "archived" ||
        reparsed.lifecycle === "frozen"
          ? reparsed.lifecycle
          : "active",
      topics: reparsed.topics,
      ...(reparsed.agentTemplateVersion !== null
        ? { agentTemplateVersion: reparsed.agentTemplateVersion }
        : {}),
      homeMesh: {
        vaultRid: freshRid,
        meshRid: meshRow.rid,
        meshName: meshRow.name,
        assignedAt: args.nowIso,
      },
    });

    writeFileSync(vaultYonPath, rewritten, "utf8");

    // Now register via join — joinVaultFlow re-reads the rewritten
    // vault.yon and INSERTs vaults row with the fresh rid + home_mesh_rid
    // primed via register.ts's @VAULT_HOME_MESH parse path.
    const join_ = await joinVaultFlow(args.target);

    // Belt-and-braces: ensure vaults.home_mesh_rid is set, INSERT
    // mesh_vaults role='home', append @MESH_HOME to the target mesh's
    // mesh.yon.
    const vaultRow = await getVaultByName(db, join_.name);
    if (vaultRow === null) {
      throw new Error(
        `cloneVaultFlow: registered vault '${join_.name}' did not land in the registry (defensive).`,
      );
    }
    await setVaultHomeMesh(db, vaultRow.rid, meshRow.rid);
    await addVaultToMesh(db, meshRow.rid, vaultRow.rid, "home");
    if (mainVault !== null) {
      appendMeshHomeToFile({
        mainVaultPath: mainVault.path,
        meshRid: meshRow.rid,
        vaultRid: vaultRow.rid,
        vaultName: join_.name,
      });
    }

    return {
      ...join_,
      cloneTargetPath: args.target,
      meshAssignment: {
        meshRidHex: meshRow.ridHex,
        meshName: meshRow.name,
        freshRidApplied: true,
        externalMeshAutoRegistered,
      },
      originDetached,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}

export function deriveNameFromUrl(url: string): string {
  let s = url
    .trim()
    .replace(/\.git$/i, "")
    .replace(/[\\/]+$/, "");
  if (s.length === 0) throw new Error(`Cannot derive vault name from URL: ${url}`);

  let pathPart: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    // protocol://host/path — http(s), ssh, git, file
    const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+(.*)$/i);
    pathPart = m?.[1] ?? "";
  } else if (/^[^@/\\]+@[^:]+:/.test(s)) {
    // user@host:path SSH shorthand
    pathPart = s.replace(/^[^@/\\]+@[^:]+:/, "");
  } else {
    pathPart = s;
  }

  pathPart = pathPart.replace(/^[\\/]+/, "");
  const segments = pathPart.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) throw new Error(`Cannot derive vault name from URL: ${url}`);
  // a convention repo name (`lyt-vault-<mesh>--<leaf>`) normalizes to
  // its `{mesh}/{vault}` NAME at the derive chokepoint, so subscribed/cloned
  // vaults register under their vault name, not their repo name. The parse
  // inverse can't false-positive: vault-name segments never contain `--`.
  const leaf = segments[segments.length - 1]!;
  const parsedRepoName = parseVaultRepoName(leaf);
  if (parsedRepoName !== null) return parsedRepoName;
  if (segments.length === 1) return leaf;
  return `${segments[segments.length - 2]!}/${leaf}`;
}
