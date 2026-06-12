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

import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getMeshByRid } from "../registry/meshes-repo.js";
import { getVaultByName, getVaultByRid, listVaults, type VaultRow } from "../registry/repo.js";
import { deriveVaultWritable, type WritabilityVerdict } from "./writability.js";
import type { GhExecutor } from "../util/gh-discover.js";
import { detectLicenseFromContent, type DetectedLicense } from "../util/license-detect.js";
import { ridsEqual } from "../util/uuid7.js";
import { parseMeshYon } from "../yon/mesh-read.js";

// v1.A.1b: mesh_edges no longer carries (sourceVaultRid, edgeType,
// targetVaultRid) — share_with collapsed to mesh subscriptions (v1.C.1)
// and the mesh-aware parent edges land in v1.B.1. The handler-visible
// `vault info` surface continues to expose inboundEdges in the legacy
// edgeType-shaped form via a vaults.parent_vault BLOB FK projection — a
// child whose parent_vault FK points at this vault is one inbound
// "parent_vault" edge. Mesh-aware traversal lands in v1.B.1.
export interface InboundEdgeProjection {
  sourceVaultRid: string; // dashed-UUIDv7 hex
  targetVaultRid: string; // dashed-UUIDv7 hex (this vault)
  edgeType: "parent_vault";
}

export interface VaultLicensePosture {
  public: boolean;
  license: string | null;
  bucket: DetectedLicense["bucket"];
}

export interface InfoFlowResult {
  vault: {
    rid: string;
    name: string;
    path: string;
    status: VaultRow["status"];
    tierHint: string | null;
    parentVault: string | null;
    memscopeRid: string | null;
    homeMeshRid: string | null;
    gitUrl: string | null;
    createdAt: string | null;
    registeredAt: string;
    lastVerifiedAt: string | null;
    verifyFailCount: number;
    // v1.G.2 — tri-state writability derived on-demand from
    // (mesh_vaults.role, gh viewerPermission). Path C: no schema column;
    // value is recomputed per call (in-process 1-min cache).
    writable: WritabilityVerdict["writable"];
    writableDetermination: WritabilityVerdict["reason"];
  };
  // v1.A.1b: outbound edges from this vault — empty until v1.B.1's
  // mesh-aware writes land; structurally kept for forward-compat.
  edges: InboundEdgeProjection[];
  // Inbound = vaults whose parent_vault FK references this vault.
  inboundEdges: InboundEdgeProjection[];
  sizeBytes: number;
  fileCount: number;
  // v1.B.6 — license posture for the vault. `public` = the vault's home
  // mesh has @MESH_PUBLIC declared (publicly published). `license` is
  // detected from the LICENSE file at the vault root via license-detect
  // heuristic; null when LICENSE absent or unrecognised. `bucket` is the
  // permissive/copyleft/unknown grouping.
  licensePosture: VaultLicensePosture;
}

export interface InfoVaultFlowOpts {
  // v1.G.2 — injectable gh executor for the writability probe. Tests
  // pass a fake GhExecutor; production defaults to spawning the real
  // `gh` CLI via util/gh-discover.ts's default executor.
  gh?: GhExecutor;
}

export async function infoVaultFlow(
  name: string,
  opts: InfoVaultFlowOpts = {},
): Promise<InfoFlowResult> {
  const db = await openRegistry();
  try {
    const vault = await getVaultByName(db, name);
    if (!vault) {
      throw new Error(`No vault registered with name '${name}'. Try 'lyt vault list'.`);
    }
    const all = await listVaults(db);
    const inboundEdges: InboundEdgeProjection[] = all
      .filter((child) => child.parentVault && ridsEqual(child.parentVault, vault.rid))
      .map((child) => ({
        sourceVaultRid: child.ridHex,
        targetVaultRid: vault.ridHex,
        edgeType: "parent_vault" as const,
      }));
    const { sizeBytes, fileCount } =
      vault.status === "tombstoned"
        ? { sizeBytes: 0, fileCount: 0 }
        : await measureVault(vault.path);

    // v1.B.6 — license posture detection. `public` flag derived from the
    // vault's home mesh's mesh.yon @MESH_PUBLIC presence. License id +
    // bucket derived from the LICENSE file at the vault root.
    let isPublic = false;
    if (vault.homeMeshRid !== null) {
      const mesh = await getMeshByRid(db, vault.homeMeshRid);
      if (mesh !== null && mesh.mainVaultRid !== null) {
        const mainVault = await getVaultByRid(db, mesh.mainVaultRid);
        if (mainVault !== null && existsSync(mainVault.path)) {
          const meshYonPath = join(mainVault.path, ".lyt", "mesh.yon");
          if (existsSync(meshYonPath)) {
            try {
              const parsed = parseMeshYon(readFileSync(meshYonPath, "utf8"));
              isPublic = parsed.publicMeta !== undefined;
            } catch {
              // parse-failure case already surfaces via doctor; keep info silent.
            }
          }
        }
      }
    }
    let licenseId: string | null = null;
    let licenseBucket: DetectedLicense["bucket"] = "unknown";
    if (vault.status !== "tombstoned" && existsSync(vault.path)) {
      const licensePath = join(vault.path, "LICENSE");
      if (existsSync(licensePath)) {
        const detected = detectLicenseFromContent(readFileSync(licensePath, "utf8"));
        licenseId = detected.id;
        licenseBucket = detected.bucket;
      }
    }

    const writability = await deriveVaultWritable(
      vault,
      db,
      opts.gh !== undefined ? { gh: opts.gh } : {},
    );

    // V-A-10: deriveVaultWritable self-heals a null git_url from the live
    // origin and persists it. `vault` was loaded before that heal, so re-read
    // the healed value when it was null — otherwise this first call would emit
    // writable:true alongside a stale gitUrl:null in the same payload.
    const gitUrlOut = vault.gitUrl ?? (await getVaultByRid(db, vault.rid))?.gitUrl ?? null;

    return {
      vault: {
        rid: vault.ridHex,
        name: vault.name,
        path: vault.path,
        status: vault.status,
        tierHint: vault.tierHint,
        parentVault: vault.parentVaultHex,
        memscopeRid: vault.memscopeRidHex,
        homeMeshRid: vault.homeMeshRidHex,
        gitUrl: gitUrlOut,
        createdAt: vault.createdAt,
        registeredAt: vault.registeredAt,
        lastVerifiedAt: vault.lastVerifiedAt,
        verifyFailCount: vault.verifyFailCount,
        writable: writability.writable,
        writableDetermination: writability.reason,
      },
      edges: [],
      inboundEdges,
      sizeBytes,
      fileCount,
      licensePosture: {
        public: isPublic,
        license: licenseId,
        bucket: licenseBucket,
      },
    };
  } finally {
    await closeRegistry(db);
  }
}

async function measureVault(path: string): Promise<{ sizeBytes: number; fileCount: number }> {
  if (!existsSync(path)) return { sizeBytes: 0, fileCount: 0 };
  let sizeBytes = 0;
  let fileCount = 0;
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        await walk(full);
      } else if (entry.isFile()) {
        try {
          sizeBytes += statSync(full).size;
          fileCount += 1;
        } catch {
          // ignore unreadable files
        }
      }
    }
  }
  await walk(path);
  return { sizeBytes, fileCount };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
