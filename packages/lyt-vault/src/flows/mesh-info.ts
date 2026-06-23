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
import { join } from "node:path";

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getMeshByName } from "../registry/meshes-repo.js";
import { getVaultByRid } from "../registry/repo.js";
import { vaultRepoNameFromParts } from "../util/federation-paths.js";
import { uuid7BytesToDashedString, uuid7BytesToHex } from "../util/uuid7.js";
import { parseMeshYon } from "../yon/mesh-read.js";

// v1.B.6 — `lyt mesh info <mesh> [--remote] [--json]`. Surfaces @MESH +
// @MESH_HOME metadata from the registered mesh's mesh.yon SoT (local mode)
// or — under --remote — peeks at the published mesh.yon WITHOUT cloning,
// via gh api repos/<owner>/<mesh-main>/contents/.lyt/mesh.yon.
// Graceful-fails to remote-gh-unavailable when gh-down.
//
// Fed-v2 Slice 1b (#13 DELETE): @MESH_PUBLIC @UPDATE_CADENCE surface
// removed. publicMeta and updateCadences fields are gone from MeshInfoResult;
// defaultVaultUpdateCadence is gone from the mesh sub-object.
// The --remote path uses a minimal GH client interface (no longer imports
// from the deleted gh-mesh-publish.ts).

export class MeshInfoNotFoundError extends Error {
  readonly errorCode = "mesh-info-not-found";
  readonly meshName: string;
  constructor(meshName: string) {
    super(
      `lyt mesh info: no mesh registered with name '${meshName}'. Use 'lyt mesh list' to see registered meshes.`,
    );
    this.name = "MeshInfoNotFoundError";
    this.meshName = meshName;
  }
}

export class MeshInfoRemoteGhUnavailableError extends Error {
  readonly errorCode = "remote-gh-unavailable";
  readonly meshName: string;
  constructor(meshName: string, cause: string) {
    super(
      `lyt mesh info --remote: gh unavailable or remote mesh.yon unreachable for mesh '${meshName}'. Reason: ${cause}`,
    );
    this.name = "MeshInfoRemoteGhUnavailableError";
    this.meshName = meshName;
  }
}

export class MeshInfoRemoteMeshYonMissingError extends Error {
  readonly errorCode = "remote-mesh-yon-missing";
  readonly meshName: string;
  constructor(meshName: string) {
    super(
      `lyt mesh info --remote: remote repo for mesh '${meshName}' does not have .lyt/mesh.yon (404 from gh api).`,
    );
    this.name = "MeshInfoRemoteMeshYonMissingError";
    this.meshName = meshName;
  }
}

// Minimal GH client interface for the --remote path. Separated from the
// (deleted) gh-mesh-publish.ts to avoid bringing in the full publish surface.
export interface MeshInfoGhClient {
  getRemoteFileContent(handle: string, repo: string, path: string): Promise<string | null>;
}

import { execFileSync } from "node:child_process";
import { inspectGhError } from "../util/gh-federation.js";

const isWindows = process.platform === "win32";

export const realMeshInfoGhClient: MeshInfoGhClient = {
  async getRemoteFileContent(handle, repo, path): Promise<string | null> {
    try {
      const stdout = execFileSync(
        "gh",
        ["api", `/repos/${handle}/${repo}/contents/${path}`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: isWindows },
      );
      const payload = JSON.parse(stdout) as { content?: string; encoding?: string };
      if (payload.encoding !== "base64" || typeof payload.content !== "string") {
        throw new Error(
          `lyt mesh info --remote: gh api returned unexpected content shape (encoding=${payload.encoding ?? "<missing>"})`,
        );
      }
      return Buffer.from(payload.content, "base64").toString("utf8");
    } catch (err) {
      const { is404, summary } = inspectGhError(err);
      if (is404) return null;
      throw new Error(`realMeshInfoGhClient.getRemoteFileContent(${handle}/${repo}/${path}): ${summary}`);
    }
  },
};

export interface MeshInfoArgs {
  meshName: string;
  registryDb?: Client | undefined;
  ghClient?: MeshInfoGhClient | undefined;
  remote?: boolean | undefined;
}

export interface MeshInfoHomeVault {
  vaultRid: string;
  vaultRidHex: string;
  vaultName: string;
}

export interface MeshInfoResult {
  source: "local" | "remote";
  mesh: {
    rid: string;
    ridHex: string;
    name: string;
    pushTarget: string | null;
    pushKind: string | null;
    mainVaultRid: string;
    createdAt: string;
  };
  homeVaults: MeshInfoHomeVault[];
}

export async function meshInfoFlow(args: MeshInfoArgs): Promise<MeshInfoResult> {
  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());
  const ghClient = args.ghClient ?? realMeshInfoGhClient;

  try {
    const mesh = await getMeshByName(db, args.meshName);
    if (mesh === null) throw new MeshInfoNotFoundError(args.meshName);

    let content: string;
    let source: "local" | "remote";
    if (args.remote === true) {
      if (mesh.pushTarget === null) {
        throw new MeshInfoRemoteGhUnavailableError(
          args.meshName,
          "mesh has no push_target (--no-push); --remote needs a remote to peek at",
        );
      }
      const repoName = vaultRepoNameFromParts(args.meshName, "main");
      let fetched: string | null;
      try {
        fetched = await ghClient.getRemoteFileContent(mesh.pushTarget, repoName, ".lyt/mesh.yon");
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new MeshInfoRemoteGhUnavailableError(args.meshName, cause);
      }
      if (fetched === null) {
        throw new MeshInfoRemoteMeshYonMissingError(args.meshName);
      }
      content = fetched;
      source = "remote";
    } else {
      if (mesh.mainVaultRid === null) {
        throw new Error(
          `lyt mesh info: mesh '${args.meshName}' has no main_vault_rid; cannot resolve mesh.yon path.`,
        );
      }
      const mainVault = await getVaultByRid(db, mesh.mainVaultRid);
      if (mainVault === null || !existsSync(mainVault.path)) {
        throw new Error(`lyt mesh info: mesh '${args.meshName}' main vault is missing on disk.`);
      }
      const meshYonPath = join(mainVault.path, ".lyt", "mesh.yon");
      if (!existsSync(meshYonPath)) {
        throw new Error(
          `lyt mesh info: mesh '${args.meshName}' is missing .lyt/mesh.yon. Run 'lyt mesh rebuild-registry --mesh ${args.meshName}'.`,
        );
      }
      content = readFileSync(meshYonPath, "utf8");
      source = "local";
    }

    const parsed = parseMeshYon(content);

    const homeVaults: MeshInfoHomeVault[] = parsed.homeVaults.map((h) => ({
      vaultRid: `vault:${uuid7BytesToDashedString(h.vaultRid)}`,
      vaultRidHex: uuid7BytesToHex(h.vaultRid),
      vaultName: h.vaultName,
    }));

    return {
      source,
      mesh: {
        rid: `mesh:${uuid7BytesToDashedString(parsed.mesh.rid)}`,
        ridHex: uuid7BytesToHex(parsed.mesh.rid),
        name: parsed.mesh.name,
        pushTarget: parsed.mesh.pushTarget ?? null,
        pushKind: parsed.mesh.pushKind ?? null,
        mainVaultRid: `vault:${uuid7BytesToDashedString(parsed.mesh.mainVaultRid)}`,
        createdAt: parsed.mesh.createdAt,
      },
      homeVaults,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}
