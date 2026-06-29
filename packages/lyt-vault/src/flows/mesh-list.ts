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

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByRid } from "../registry/repo.js";
import { isUuidv7Bytes, uuid7BytesToHex } from "../util/uuid7.js";
import type { MeshPushKind } from "../yon/mesh-write.js";

// v1.B.1 — `lyt mesh list [--json]` flow.
//
// Source: Brief @TASK step 5 + Brief acceptance clause (e) + lyt-federation-design.md
// §6 line 266 + lyt-master-plan.md §5 v1.B.1 acceptance item 3.
//
// SELECT rid, name, push_target, push_kind, main_vault_rid, created_at FROM meshes
// ORDER BY created_at, name (deterministic; created_at is the natural primary
// sort, name is a stable tiebreak in the unlikely case two meshes share a
// timestamp).
//
// For each mesh, joins to mesh_vaults to enumerate home + subscribed roles;
// for each home/subscribed vault, joins to vaults for the display name. The
// `★ {mesh-name}/main` marker is rendered by commands/mesh.ts based on
// `mainVault.ridHex === homeVault.ridHex`.

export interface MeshListVaultRef {
  rid: Uint8Array;
  ridHex: string;
  name: string;
}

export interface MeshListEntry {
  rid: Uint8Array;
  ridHex: string;
  name: string;
  pushTarget: string | null;
  pushKind: MeshPushKind | null;
  mainVault: MeshListVaultRef | null;
  homeVaults: MeshListVaultRef[];
  subscribedVaults: MeshListVaultRef[];
}

export interface MeshListResult {
  meshes: MeshListEntry[];
}

export interface MeshListOptions {
  registryPath?: string | undefined;
}

export async function meshListFlow(opts: MeshListOptions = {}): Promise<MeshListResult> {
  const db = await openRegistry(
    opts.registryPath !== undefined ? { path: opts.registryPath } : undefined,
  );
  try {
    return await meshListUsingDb(db);
  } finally {
    await closeRegistry(db);
  }
}

// Exported for tests that want to drive the projection against a pre-opened
// db (no implicit open/close).
export async function meshListUsingDb(db: Client): Promise<MeshListResult> {
  const meshRows = await db.execute(
    "SELECT rid, name, push_target, push_kind, main_vault_rid, created_at FROM meshes ORDER BY created_at ASC, name ASC",
  );

  const out: MeshListEntry[] = [];
  for (const row of meshRows.rows) {
    const r = row as unknown as Record<string, unknown>;
    const ridRaw = r["rid"];
    if (!isUuidv7Bytes(ridRaw)) continue;
    const rid = ridRaw instanceof Uint8Array ? ridRaw : new Uint8Array(ridRaw as ArrayBuffer);
    const ridHex = uuid7BytesToHex(rid);
    const name = String(r["name"]);
    const pushTarget = r["push_target"] == null ? null : String(r["push_target"]);
    const pushKindRaw = r["push_kind"];
    const pushKind: MeshPushKind | null =
      pushKindRaw === "handle" || pushKindRaw === "org" ? pushKindRaw : null;

    const mainVaultRidRaw = r["main_vault_rid"];
    let mainVault: MeshListVaultRef | null = null;
    if (isUuidv7Bytes(mainVaultRidRaw)) {
      const mainRid =
        mainVaultRidRaw instanceof Uint8Array
          ? mainVaultRidRaw
          : new Uint8Array(mainVaultRidRaw as ArrayBuffer);
      const mainVaultRow = await getVaultByRid(db, mainRid);
      if (mainVaultRow !== null) {
        mainVault = {
          rid: mainVaultRow.rid,
          ridHex: mainVaultRow.ridHex,
          name: mainVaultRow.name,
        };
      }
    }

    // mesh_vaults: enumerate home + subscribed roles for this mesh. Order
    // by role (home first, then subscribed) then by vault_rid for stable
    // --json output.
    const mvRows = await db.execute({
      sql: "SELECT vault_rid, role FROM mesh_vaults WHERE mesh_rid = ? ORDER BY role ASC, vault_rid ASC",
      args: [rid],
    });
    const homeVaults: MeshListVaultRef[] = [];
    const subscribedVaults: MeshListVaultRef[] = [];
    for (const mvRow of mvRows.rows) {
      const m = mvRow as unknown as Record<string, unknown>;
      const vRidRaw = m["vault_rid"];
      if (!isUuidv7Bytes(vRidRaw)) continue;
      const vRid = vRidRaw instanceof Uint8Array ? vRidRaw : new Uint8Array(vRidRaw as ArrayBuffer);
      const vaultRow = await getVaultByRid(db, vRid);
      if (vaultRow === null) continue;
      const ref: MeshListVaultRef = {
        rid: vaultRow.rid,
        ridHex: vaultRow.ridHex,
        name: vaultRow.name,
      };
      const role = String(m["role"]);
      if (role === "home") {
        homeVaults.push(ref);
      } else if (role === "subscribed") {
        subscribedVaults.push(ref);
      }
    }

    out.push({
      rid,
      ridHex,
      name,
      pushTarget,
      pushKind,
      mainVault,
      homeVaults,
      subscribedVaults,
    });
  }

  return { meshes: out };
}
