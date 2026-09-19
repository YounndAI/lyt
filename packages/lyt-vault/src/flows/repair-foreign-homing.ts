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

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { ensureBucketMesh } from "../registry/meshes-repo.js";
import {
  addVaultToMesh,
  listMeshesForVault,
  removeVaultFromMesh,
} from "../registry/mesh-vaults-repo.js";
import {
  getVaultByRid,
  listVaults,
  setVaultHomeMesh,
  updateVaultPath,
  type VaultRow,
} from "../registry/repo.js";
import {
  canonicalizeCoordinate,
  gitUrlToCoordinate,
  vaultLeaf,
  vaultOriginCoordinate,
} from "../registry/vault-addressing.js";
import {
  bucketMeshName,
  bucketVaultRelDir,
  entryModeForSource,
  parseBucketRelDir,
  SHARED_BUCKET_MESH,
  SUBSCRIPTION_BUCKET_MESH,
} from "../util/bucket-mesh.js";
import { slugifyHandle } from "../util/federation-paths.js";
import { readGitRemoteOriginUrl } from "../util/git.js";
import { canonicalizeVaultPath, getDefaultVaultsRoot } from "../util/paths.js";
import { hexToUuid7Bytes, ridsEqual, uuid7BytesToHex } from "../util/uuid7.js";
import { isGitRepo } from "../util/git-run.js";
import {
  foldFedVaultWinners,
  listFedVaultShards,
  readAllFedVaultRecords,
} from "../yon/federation-vault-ledger-read.js";
import { liveSubscriptions } from "../yon/subscription-ledger-read.js";
import { parseVaultYon } from "../yon/parse.js";
import { snapshotVaultFlow } from "./snapshot.js";
import { registerVaultFromYon } from "./register.js";

// Inc-2 Phase B / IDEMPOTENT LAZY REPAIR for already-commingled foreign
// vaults. Before a foreign vault could be homed on-disk inside the user's
// own `vaults/{mesh}/…` tree (the collides-only rule only bucketed on a name
// collision). This flow relocates any foreign vault (source ∈ {shared,subscribed})
// that is sitting in the WRONG tree into its correct owner-keyed bucket home
// (`subscriptions/{owner}` | `shared/{owner}`), and heals its registry pointer +
// home mesh. Designed to be called best-effort on `sync` / `reindex --all`.
//
// SAFETY CONTRACT (MED break-risk — migration/pathing):
//   - SNAPSHOT (best-effort ADVISORY recovery aid, NOT a gate): when the vault is
//     a git repo a snapshot branch of the pre-move working tree is taken before a
//     move, as a convenience recovery point. A snapshot failure (no git identity,
//     not a repo, etc.) NEVER blocks the move — the rename is non-destructive on
//     its own; the snapshot is advisory, never a precondition.
//   - IDEMPOTENT: a vault already under its correct bucket tree is a no-op; a
//     second run relocates nothing.
//   - NO-ORPHAN: the registry pointer is only ever repointed to a directory that
//     EXISTS on disk. If the source dir is gone, or BOTH the old and new dirs
//     exist (ambiguous), the vault is SKIPPED (never left unreachable, never
//     clobbered). On a registry-only heal (the dir is already at the bucket tree)
//     the target's `.lyt/vault.yon` rid MUST match the vault's rid before we
//     repoint — so a same-owner/same-leaf collision can never point one vault at
//     another's dir.
//   - JUNCTION-SAFE: the move is a single `fs.renameSync` (a directory-entry
//     relink), which NEVER recurses into the tree — so it cannot traverse a
//     junction/symlink into a source-of-truth outside the move root (the L0
//     destructive-delete concern is a RECURSIVE-DELETE concern; rename does no
//     recursion and no delete). A write-path symlink guard additionally refuses
//     if any EXISTING component of the target's parent chain is a reparse point.

export interface RepairForeignHomingArgs {
  // Open-once seam — the flow opens its own registry when omitted.
  registryDb?: Client | undefined;
  // Test override for the vaults root the bucket tree is computed under.
  vaultsRoot?: string | undefined;
  // Snapshot-first toggle. Default TRUE (snapshot before every move). Set false
  // only in tests that deliberately exercise the non-git path.
  snapshot?: boolean | undefined;
}

export interface RelocatedForeignVault {
  vaultRidHex: string;
  name: string;
  source: "shared" | "subscribed";
  fromPath: string;
  toPath: string;
  bucketMesh: string;
  // The git snapshot branch taken before the move, or null when none could be
  // taken (not a git repo, or a registry-only heal with no move).
  snapshotBranch: string | null;
  // true = a directory was physically relocated; false = a registry-only heal
  // (the dir was already at the bucket tree; only the stale pointer was fixed).
  moved: boolean;
}

export interface RepairForeignHomingResult {
  scanned: number;
  relocated: RelocatedForeignVault[];
  skipped: { name: string; reason: string }[];
  durationMs: number;
}

// WRITE-PATH SYMLINK GUARD (standing directive). Walks from `root` (the
// vaults root, inclusive) down to the target's parent and refuses if any EXISTING
// component is a reparse point (symlink / Windows junction) — never follows it.
// A missing ancestor is fine (created fresh by our own mkdir). Mirrors the
// clone-flow guard so a bucket parent swapped for a junction can't redirect the
// move outside the vaults root.
function assertNoSymlinkOnWritePath(root: string, target: string): void {
  const rootR = resolve(root);
  const chain: string[] = [];
  let cur = resolve(dirname(target));
  for (;;) {
    chain.push(cur);
    if (cur === rootR) break;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  for (const p of chain) {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      throw new Error(
        `Refusing to relocate a foreign vault into ${target}: the write-path component ` +
          `${JSON.stringify(p)} is a symlink/junction. A reparse point on the target's parent ` +
          `chain could redirect the move outside the vaults root. Remove or replace the link ` +
          `with a real directory and retry.`,
      );
    }
  }
}

// extract the OWNER segment from a vault's origin coordinate. The
// coordinate is `lyt:vault:<host>/<owner>/<repo>`; the owner is the 2nd path
// segment after the `lyt:vault:` prefix. Returns null when the vault has no
// resolvable origin (a foreign vault with no coordinate cannot be owner-homed).
//
// EXPORTED (Inc-2 Phase C #6 release review R1) so the `lyt mesh prune` bucket-backing
// guard REUSES the exact owner-derivation the resurrection path (this flow's
// insertMesh bucket re-creation below) uses — the same anti-drift discipline
// coordinateOwner already gets. A prune guard that re-implemented the extractor
// could drift from repair and delete a bucket that repair then resurrects.
export function foreignVaultOwner(vault: VaultRow): string | null {
  const coord = vaultOriginCoordinate(vault);
  if (coord === null) return null;
  const TYPED_PREFIX = "lyt:vault:";
  const bare = coord.startsWith(TYPED_PREFIX) ? coord.slice(TYPED_PREFIX.length) : coord;
  const segs = bare.split("/").filter((s) => s.length > 0);
  if (segs.length < 3) return null;
  const owner = segs[1]!;
  return owner.length > 0 ? slugifyHandle(owner) : null;
}

// read the `.lyt/vault.yon` rid of an on-disk vault dir. Returns the rid
// bytes, or null if the file is absent/unparseable. Used by the registry-only
// heal branch below to CONFIRM a pre-existing bucket-tree dir actually IS this
// vault before repointing the registry at it (identity guard — never repoint one
// vault at another vault's dir on a same-owner/same-leaf collision).
function readVaultYonRid(vaultDir: string): Uint8Array | null {
  try {
    const content = readFileSync(join(vaultDir, ".lyt", "vault.yon"), "utf8");
    const parsed = parseVaultYon(content);
    return hexToUuid7Bytes(parsed.rid);
  } catch {
    return null;
  }
}

export async function repairForeignHomingFlow(
  args: RepairForeignHomingArgs = {},
): Promise<RepairForeignHomingResult> {
  const startedAt = Date.now();
  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());
  const vaultsRoot = resolve(args.vaultsRoot ?? getDefaultVaultsRoot());
  const doSnapshot = args.snapshot !== false;

  const relocated: RelocatedForeignVault[] = [];
  const skipped: { name: string; reason: string }[] = [];
  let scanned = 0;

  try {
    const foreign = (await listVaults(db)).filter((v) => v.source !== "own");
    for (const vault of foreign) {
      scanned += 1;
      const source = vault.source as "shared" | "subscribed";

      const owner = foreignVaultOwner(vault);
      if (owner === null) {
        skipped.push({ name: vault.name, reason: "no-owner-coordinate" });
        continue;
      }

      const relDir = bucketVaultRelDir(source, owner, vaultLeaf(vault.name));
      const expectedAbs = resolve(join(vaultsRoot, relDir));
      const currentAbs = resolve(vault.path);

      // IDEMPOTENT — already correctly homed (registry points at the bucket tree).
      if (canonicalizeVaultPath(currentAbs) === canonicalizeVaultPath(expectedAbs)) {
        skipped.push({ name: vault.name, reason: "already-homed" });
        continue;
      }

      const currentExists = existsSync(currentAbs);
      const expectedExists = existsSync(expectedAbs);

      // NO-ORPHAN discriminator over the (currentExists, expectedExists) matrix:
      //   (T,T) ambiguous — both dirs present → skip (never clobber the target).
      //   (F,F) the vault dir is gone entirely → skip (never repoint at nothing).
      //   (F,T) the dir is already at the bucket tree but the registry pointer is
      //         stale → registry-only heal (no move).
      //   (T,F) the canonical case → snapshot, then move, then heal.
      if (currentExists && expectedExists) {
        skipped.push({ name: vault.name, reason: "target-exists-conflict" });
        continue;
      }
      if (!currentExists && !expectedExists) {
        skipped.push({ name: vault.name, reason: "vault-dir-missing" });
        continue;
      }

      let snapshotBranch: string | null = null;
      let moved = false;

      if (currentExists && !expectedExists) {
        // SNAPSHOT (best-effort, advisory) — a git snapshot branch of the pre-move
        // working tree. The .git moves WITH the vault on rename, so the branch
        // survives the relocation and remains a recovery point. NOT a gate.
        if (doSnapshot && (await isGitRepo(currentAbs))) {
          try {
            const snap = await snapshotVaultFlow({ name: vault.name, label: "d146-rehome" });
            snapshotBranch = snap.branch;
          } catch {
            // best-effort — a snapshot failure (no identity, etc.) does not block
            // the non-destructive rename below.
            snapshotBranch = null;
          }
        }
        // Write-path symlink guard on the target's parent chain, then claim the
        // parent and relink the directory entry (rename = no recursion, no delete).
        assertNoSymlinkOnWritePath(vaultsRoot, expectedAbs);
        mkdirSync(dirname(expectedAbs), { recursive: true });
        // EXDEV/EPERM per-vault isolation — a cross-volume rename (the bucket tree
        // on a different filesystem than the commingled dir) throws EXDEV; a
        // locked/permission-denied entry throws EPERM. Skip ONLY this vault and
        // let the pass continue for the rest. DELIBERATELY no recursive copy+delete
        // fallback: that would be a recursive delete near possibly-junctioned trees
        // (destructive-delete L0). Skip-and-log is the correct posture.
        try {
          renameSync(currentAbs, expectedAbs);
        } catch (renameErr) {
          const code = (renameErr as NodeJS.ErrnoException).code ?? "UNKNOWN";
          if (code === "EXDEV" || code === "EPERM") {
            console.warn(
              `repairForeignHomingFlow: skipping ${JSON.stringify(vault.name)} — ` +
                `cross-volume/permission rename (${code}) from ${JSON.stringify(currentAbs)} ` +
                `to ${JSON.stringify(expectedAbs)}. Relocate this vault manually; the pass continues.`,
            );
            skipped.push({ name: vault.name, reason: `move-failed-${code.toLowerCase()}` });
            continue;
          }
          throw renameErr;
        }
        moved = true;
      } else {
        // (!currentExists && expectedExists) — registry-only heal: the dir is
        // already at the bucket tree; only the stale pointer + home mesh are fixed.
        // IDENTITY GUARD (#6): we are about to repoint the registry at a
        // pre-existing dir we did NOT just create. Confirm it actually IS this
        // vault — its `.lyt/vault.yon` rid must match. A same-owner/same-leaf
        // collision (two vaults resolving to the SAME bucket relDir) would
        // otherwise repoint/alias one vault at another's directory. On mismatch or
        // unreadable vault.yon, SKIP (never repoint at a foreign/unverifiable dir).
        const targetRid = readVaultYonRid(expectedAbs);
        if (targetRid === null || !ridsEqual(targetRid, vault.rid)) {
          console.warn(
            `repairForeignHomingFlow: skipping ${JSON.stringify(vault.name)} — the bucket-tree ` +
              `dir ${JSON.stringify(expectedAbs)} does not carry this vault's rid in its ` +
              `.lyt/vault.yon (rid mismatch or unreadable). Not repointing one vault at another's dir.`,
          );
          skipped.push({ name: vault.name, reason: "target-rid-mismatch" });
          continue;
        }
      }

      // Ensure the reserved owner-bucket mesh exists, then rehome + repoint under
      // one txn so the vault never lands half-homed. removeVaultFromMesh clears
      // any prior home-role membership first (the one-home-per-vault partial
      // unique index forbids a second home row).
      // via the SHARED find-or-create so this repair, the ledger
      // reconstitution, and the from-disk re-registration mint an owner bucket
      // through one implementation.
      const bucketMesh = bucketMeshName(entryModeForSource(source), owner);
      const bucket = (await ensureBucketMesh(db, bucketMesh)).mesh;

      await db.execute("BEGIN");
      try {
        const homeRows = (await listMeshesForVault(db, vault.rid)).filter((r) => r.role === "home");
        for (const h of homeRows) {
          if (!ridsEqual(h.meshRid, bucket.rid)) await removeVaultFromMesh(db, h.meshRid, vault.rid);
        }
        await setVaultHomeMesh(db, vault.rid, bucket.rid);
        await addVaultToMesh(db, bucket.rid, vault.rid, "home");
        await updateVaultPath(db, vault.rid, expectedAbs);
        await db.execute("COMMIT");
      } catch (innerErr) {
        try {
          await db.execute("ROLLBACK");
        } catch {
          /* best-effort */
        }
        throw innerErr;
      }

      relocated.push({
        vaultRidHex: vault.ridHex,
        name: vault.name,
        source,
        fromPath: currentAbs,
        toPath: expectedAbs,
        bucketMesh,
        snapshotBranch,
        moved,
      });
    }

    return {
      scanned,
      relocated,
      skipped,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}

// the COMPANION heal to repairForeignHomingFlow above.
//
// repairForeignHomingFlow iterates `listVaults(db)`: it can only fix a foreign
// vault that still HAS a registry row. The live pod failure is the case with no
// row at all — three foreign vaults present on disk under their correct bucket
// directories, zero rows in `vaults`, and plain publisher-named meshes minted by
// the old by-name fallback. Nothing that iterates the registry can see those
// vaults, so nothing healed them.
//
// This flow scans the two bucket TREES ON DISK instead, finds every
// `<subscriptions|shared>/{owner}/{leaf}` directory that carries a
// `.lyt/vault.yon` with NO corresponding registry row, and re-registers it
// through the (now bucket-aware) registerVaultFromYon — which homes it into
// `<subscriptions|shared>/{owner}` and marks its `source` from the bucket
// prefix, all without touching the byte-unchanged committed vault.yon.
//
// Contract:
//   - DRY-RUN by default (mirrors `lyt repair`'s safer write posture).
//   - IDEMPOTENT: a vault whose rid already has a registry row is skipped, so a
//     second apply is a no-op.
//   - Bounded, link-safe scan: exactly owner level then leaf level, classified
//     from the readdir DIRENT (never `statSync`), so a symlink/junction planted
//     in a bucket tree is skipped rather than followed.
//   - NON-DESTRUCTIVE: it only ever INSERTs a missing row. It moves nothing,
//     deletes nothing, and writes nothing inside the vault.
export interface StrandedForeignVault {
  path: string;
  ridHex: string;
  name: string;
  source: "shared" | "subscribed";
  owner: string;
  leaf: string;
  bucketMesh: string;
}

export interface ReregisterStrandedForeignVaultsArgs {
  // Open-once seam — the flow opens its own registry when omitted.
  registryDb?: Client | undefined;
  mode?: "dry-run" | "apply" | undefined;
  // Restrict the walk to ONE vault directory (absolute path). Used by
  // `lyt repair --target`, so a scoped repair heals exactly its finding.
  onlyPath?: string | undefined;
}

export interface ReregisterStrandedForeignVaultsResult {
  mode: "dry-run" | "apply";
  // Bucket-tree directories that carried a `.lyt/vault.yon`.
  scanned: number;
  // Those with NO registry row — the findings.
  stranded: StrandedForeignVault[];
  // Rows actually created (always empty under dry-run).
  registered: StrandedForeignVault[];
  skipped: { path: string; reason: string }[];
  // F1 — false when this pod has NO @FED_VAULT ledger shard at all. The forget
  // tombstone check cannot run there, so the flow falls back to re-registering
  // from the directory alone (see the fallback note in the flow body).
  federationLedgerPresent: boolean;
  durationMs: number;
}

// Bounded, link-safe enumeration of `<root>/<subscriptions|shared>/*/*`.
// Deliberately mirrors the rebuild-scan shape (flows/rebuild.ts) — same two
// levels, same dirent-based link handling — so the two candidate sets agree.
//
// EXPORTED (fix-pass, cold review) so `lyt mesh prune`'s bucket-backing
// guard scans the DISK with the EXACT enumerator this resurrection path uses -
// the same anti-drift discipline `foreignVaultOwner` already carries. A prune
// guard with its own scanner could disagree about which directories count as
// bucket vaults, delete a bucket this flow then resurrects, and re-open the
// looks-fixed-but-isn't hole.
export function listBucketVaultDirs(vaultsRoot: string): string[] {
  const out: string[] = [];
  for (const bucketPrefix of [SUBSCRIPTION_BUCKET_MESH, SHARED_BUCKET_MESH]) {
    const bucketRoot = join(vaultsRoot, bucketPrefix);
    if (!existsSync(bucketRoot)) continue;
    let ownerEntries;
    try {
      ownerEntries = readdirSync(bucketRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ownerEntry of ownerEntries) {
      if (ownerEntry.isSymbolicLink() || !ownerEntry.isDirectory()) continue;
      const ownerDir = join(bucketRoot, ownerEntry.name);
      let leafEntries;
      try {
        leafEntries = readdirSync(ownerDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const leafEntry of leafEntries) {
        if (leafEntry.isSymbolicLink() || !leafEntry.isDirectory()) continue;
        out.push(resolve(join(ownerDir, leafEntry.name)));
      }
    }
  }
  return out;
}

// fix-pass (cold review, F1) — compare a rid across the registry (dashed
// UUIDv7 hex) and the ledger (whatever hex form the writer emitted) on ONE
// normal form: lowercase, dashes stripped. A malformed value simply never
// matches.
function normalizeRidHex(hex: string): string {
  return hex.replace(/-/g, "").toLowerCase();
}

// F4 — the STORED provenance a LIVE @SUBSCRIPTION asserts for the upstream this
// directory points at, or null when there is no coordinate / no live record.
// Coordinate comparison is on the canonical form both sides normalize through
// (canonicalizeCoordinate), so a bare-vs-typed, cased, or `.git`-suffixed url
// still matches the ledger key. The entry_mode to source mapping is the exact
// inverse of `entryModeForSource` (util/bucket-mesh.ts).
function resolveLedgerSource(
  gitUrl: string | null,
  subs: readonly { coordinate: string; entryMode: string }[],
): "shared" | "subscribed" | null {
  if (gitUrl === null || gitUrl.length === 0) return null;
  const coord = gitUrlToCoordinate(gitUrl);
  if (coord === null) return null;
  const canon = canonicalizeCoordinate(coord);
  const hit = subs.find((sub) => canonicalizeCoordinate(sub.coordinate) === canon);
  if (hit === undefined) return null;
  return hit.entryMode === "shared" ? "shared" : "subscribed";
}

export async function reregisterStrandedForeignVaultsFlow(
  args: ReregisterStrandedForeignVaultsArgs = {},
): Promise<ReregisterStrandedForeignVaultsResult> {
  const startedAt = Date.now();
  const mode = args.mode ?? "dry-run";
  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());
  // NOTE: deliberately NOT parameterised (unlike repairForeignHomingFlow's
  // `vaultsRoot` test override). registerVaultFromYon recovers the bucket
  // coordinates from `getDefaultVaultsRoot()`, so a scan rooted anywhere else
  // would surface directories this flow could not then register correctly. One
  // root, both halves. Tests scope it with LYT_HOME.
  const vaultsRoot = resolve(getDefaultVaultsRoot());

  const stranded: StrandedForeignVault[] = [];
  const registered: StrandedForeignVault[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let scanned = 0;

  // FORGET TOMBSTONES (fix-pass, cold review, F1). `lyt vault forget`
  // (default, WITHOUT `--tombstone`) DELETES the registry row and LEAVES the
  // directory on disk (flows/forget.ts) — byte-identical to the stranded state
  // this flow heals. Without this check `lyt reindex --all` (which runs the heal
  // in APPLY mode unconditionally) would RESURRECT every forgotten foreign vault
  // on the next pass. forget also appends a `state=tombstoned` @FED_VAULT record
  // to the writer's own shard, so the ledger carries the durable "the handler
  // removed this" fact the directory does not. A rid whose FOLDED @FED_VAULT
  // winner is tombstoned is therefore SKIPPED (reason `forgotten`), never
  // re-registered.
  //
  // NON-FEDERATED POD FALLBACK: a pod with no @FED_VAULT ledger at all (no
  // shards on disk) yields zero records and therefore zero tombstones, so this
  // flow keeps its pre-fix behaviour there and re-registers from the directory
  // alone. That is the correct degrade — there is no durable retraction channel
  // to consult — and it is stated in the result via `federationLedgerPresent`.
  const federationLedgerPresent = listFedVaultShards().length > 0;
  const forgottenRids = new Set<string>();
  for (const winner of foldFedVaultWinners(readAllFedVaultRecords()).values()) {
    if (winner.state === "tombstoned") forgottenRids.add(normalizeRidHex(winner.vaultRid));
  }

  // LEDGER-OVER-DISK (fix-pass, cold review, F4). The disk PREFIX
  // (`subscriptions/` vs `shared/`) is a receiver-owned fact, but it is a
  // SNAPSHOT of the entry mode at receive time; the @SUBSCRIPTION ledger is the
  // durable, git-synced source of truth for that relationship and is what
  // rebuildFederationCacheFlow re-homes from. When the two disagree the LEDGER
  // wins, so a heal and a cache rebuild cannot land the same vault in two
  // different buckets. Read once for the whole pass.
  const subs = liveSubscriptions();

  try {
    for (const vaultDir of listBucketVaultDirs(vaultsRoot)) {
      if (args.onlyPath !== undefined && resolve(args.onlyPath) !== vaultDir) continue;
      if (!existsSync(join(vaultDir, ".lyt", "vault.yon"))) continue;
      scanned += 1;

      const coords = parseBucketRelDir(relative(vaultsRoot, vaultDir));
      if (coords === null) {
        // Unreachable given the enumeration shape; defensive.
        skipped.push({ path: vaultDir, reason: "not-a-bucket-vault-dir" });
        continue;
      }

      let parsed;
      try {
        parsed = parseVaultYon(readFileSync(join(vaultDir, ".lyt", "vault.yon"), "utf8"));
      } catch (err) {
        skipped.push({
          path: vaultDir,
          reason: `unreadable-vault-yon: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      let ridBytes: Uint8Array;
      try {
        ridBytes = hexToUuid7Bytes(parsed.rid);
      } catch {
        skipped.push({ path: vaultDir, reason: "unparseable-rid" });
        continue;
      }

      // F1 — a forgotten vault (row deleted, directory deliberately left behind)
      // is NOT stranded. Skip before it can become a finding, so neither the
      // `lyt repair` dry-run nor the unconditional reindex apply resurrects it.
      if (forgottenRids.has(normalizeRidHex(uuid7BytesToHex(ridBytes)))) {
        skipped.push({ path: vaultDir, reason: "forgotten" });
        continue;
      }

      // IDEMPOTENCE + NO-CLOBBER: a rid already present is either this vault's
      // own row (repairForeignHomingFlow owns re-homing it) or a genuine
      // conflict — either way this flow does not touch it.
      if ((await getVaultByRid(db, ridBytes)) !== null) {
        skipped.push({ path: vaultDir, reason: "already-registered" });
        continue;
      }

      // F4 — LEDGER OVER DISK PREFIX. Resolve this directory's ORIGIN coordinate
      // the way register.ts:141 already does (vault.yon's @META git_url, else
      // `.git/config` remote.origin.url) and look for a LIVE @SUBSCRIPTION for it.
      // A live record's `entry_mode` is the durable statement of the relationship
      // (`shared` = a granted private vault, `subscribe` = a self-subscribed public
      // one); the disk prefix is only the receive-time snapshot of it. When the two
      // disagree the LEDGER wins, and the vault is registered AND homed under the
      // bucket the ledger implies — the same bucket rebuildFederationCacheFlow
      // would re-mint for that subscription — so the two derivations can never land
      // one vault in two buckets. With no coordinate or no live record, the disk
      // prefix stands.
      const gitUrl = parsed.gitUrl ?? readGitRemoteOriginUrl(vaultDir);
      const ledgerSource = resolveLedgerSource(gitUrl, subs);
      const source = ledgerSource ?? coords.source;
      const bucketMesh =
        source === coords.source
          ? coords.bucketMesh
          : bucketMeshName(entryModeForSource(source), coords.owner);

      const finding: StrandedForeignVault = {
        path: vaultDir,
        ridHex: uuid7BytesToHex(ridBytes),
        name: parsed.name,
        source,
        owner: coords.owner,
        leaf: coords.leaf,
        bucketMesh,
      };
      stranded.push(finding);

      if (mode === "dry-run") continue;

      // F6 — ONE TRANSACTION over the bucket mesh + the row + the membership,
      // matching the sibling repairForeignHomingFlow's BEGIN/COMMIT. The bucket
      // mesh is minted INSIDE the txn, so a failure anywhere after it rolls the
      // mesh back too and never leaves an EMPTY bucket mesh behind (which would
      // then trip doctor's structural-invariant warn and invite a prune of a mesh
      // this very flow would resurrect).
      try {
        await db.execute("BEGIN");
        try {
          const bucket = await ensureBucketMesh(db, bucketMesh);
          // `source` and the home mesh are passed EXPLICITLY rather than left to
          // register's own path-derived bucket arm: the ledger may have overridden
          // the disk prefix above, and an explicit caller value wins there
          // (register.ts homeMeshRidOverride / args.source). trustedReconstruction
          // marks the identity-preserving from-disk restore axis (the rail registry
          // rebuild already uses); the publisher's rid + name are kept and nothing
          // is written back into vault.yon.
          await registerVaultFromYon(db, {
            vaultPath: vaultDir,
            trustedReconstruction: true,
            // Final review — the heal is one of the three FROM-DISK
            // reconstruction callers permitted to open register's bucket arm.
            // (It passes an explicit `homeMeshRidOverride`, so the arm is not
            // actually taken here; the flag states the authority truthfully and
            // keeps the caller set legible.)
            fromDiskReconstruction: true,
            source,
            homeMeshRidOverride: bucket.mesh.rid,
          });
          // Mirror repairForeignHomingFlow: the mesh_vaults 'home' membership row
          // is the mesh-side view of the same binding and is not written by
          // register.
          const homeRows = (await listMeshesForVault(db, ridBytes)).filter(
            (r) => r.role === "home",
          );
          if (!homeRows.some((r) => ridsEqual(r.meshRid, bucket.mesh.rid))) {
            for (const h of homeRows) await removeVaultFromMesh(db, h.meshRid, ridBytes);
            await addVaultToMesh(db, bucket.mesh.rid, ridBytes, "home");
          }
          await db.execute("COMMIT");
        } catch (innerErr) {
          try {
            await db.execute("ROLLBACK");
          } catch {
            /* best-effort */
          }
          throw innerErr;
        }
        registered.push(finding);
      } catch (err) {
        skipped.push({
          path: vaultDir,
          reason: `register-failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    return {
      mode,
      scanned,
      stranded,
      registered,
      skipped,
      federationLedgerPresent,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}
