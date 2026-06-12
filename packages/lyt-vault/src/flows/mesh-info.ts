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
import { realPublishGhClient, type PublishGhClient } from "../util/gh-mesh-publish.js";

// v1.B.6 — `lyt mesh info <mesh> [--remote] [--json]`. Surfaces the @MESH
// + @MESH_PUBLIC + @UPDATE_CADENCE metadata from the registered mesh's
// mesh.yon SoT (local mode) or — under --remote — peeks at the published
// mesh.yon WITHOUT cloning, via gh api repos/<owner>/<mesh-main>/contents/
// .lyt/mesh.yon. Graceful-fails to remote-gh-unavailable when gh-down.
//
// Output shape (per OD-8 nested):
// { mesh, publicMeta?, updateCadences, homeVaults }
//
// Local-mode resolves by mesh name in the registry. --remote-mode requires
// either a pushTarget on a registered mesh OR --owner explicit override
// (v1.B.6 ships local-resolution-only; --owner extension deferred to a
// future commit when the discovery surface needs it).

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

export interface MeshInfoArgs {
  meshName: string;
  registryDb?: Client | undefined;
  ghClient?: PublishGhClient | undefined;
  remote?: boolean | undefined;
}

export interface MeshInfoPublicMeta {
  description: string;
  topics?: string | undefined;
  maintainerContact?: string | undefined;
  maintainerHandle?: string | undefined;
  licenseOverride?: string | undefined;
  acceptContributions?: boolean | undefined;
  contributionUrl?: string | undefined;
  homepageUrl?: string | undefined;
  chatUrl?: string | undefined;
  createdAt?: string | undefined;
}

export interface MeshInfoUpdateCadence {
  vaultRid: string;
  vaultRidHex: string;
  cadenceType: "cron" | "interval" | "on-demand";
  cron?: string | undefined;
  intervalSeconds?: number | undefined;
  timezone?: string | undefined;
  peakHours?: string | undefined;
  onDemandAllowed?: boolean | undefined;
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
    defaultVaultUpdateCadence: string | null;
  };
  publicMeta: MeshInfoPublicMeta | null;
  updateCadences: MeshInfoUpdateCadence[];
  homeVaults: MeshInfoHomeVault[];
}

export async function meshInfoFlow(args: MeshInfoArgs): Promise<MeshInfoResult> {
  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());
  const ghClient = args.ghClient ?? realPublishGhClient;

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
      // Brief B (OD-B1 scheme D) — mesh main vault repo via the vaultRepoName
      // chokepoint (lyt-vault-<mesh>--main). SEE ALSO mesh-publish.ts.
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

    const publicMeta: MeshInfoPublicMeta | null =
      parsed.publicMeta === undefined
        ? null
        : {
            description: parsed.publicMeta.description,
            ...(parsed.publicMeta.topics !== undefined ? { topics: parsed.publicMeta.topics } : {}),
            ...(parsed.publicMeta.maintainerContact !== undefined
              ? { maintainerContact: parsed.publicMeta.maintainerContact }
              : {}),
            ...(parsed.publicMeta.maintainerHandle !== undefined
              ? { maintainerHandle: parsed.publicMeta.maintainerHandle }
              : {}),
            ...(parsed.publicMeta.licenseOverride !== undefined
              ? { licenseOverride: parsed.publicMeta.licenseOverride }
              : {}),
            ...(parsed.publicMeta.acceptContributions !== undefined
              ? { acceptContributions: parsed.publicMeta.acceptContributions }
              : {}),
            ...(parsed.publicMeta.contributionUrl !== undefined
              ? { contributionUrl: parsed.publicMeta.contributionUrl }
              : {}),
            ...(parsed.publicMeta.homepageUrl !== undefined
              ? { homepageUrl: parsed.publicMeta.homepageUrl }
              : {}),
            ...(parsed.publicMeta.chatUrl !== undefined
              ? { chatUrl: parsed.publicMeta.chatUrl }
              : {}),
            ...(parsed.publicMeta.createdAt !== undefined
              ? { createdAt: parsed.publicMeta.createdAt }
              : {}),
          };

    const updateCadences: MeshInfoUpdateCadence[] = parsed.updateCadences.map((c) => ({
      vaultRid: `vault:${uuid7BytesToDashedString(c.vaultRid)}`,
      vaultRidHex: uuid7BytesToHex(c.vaultRid),
      cadenceType: c.cadenceType,
      ...(c.cron !== undefined ? { cron: c.cron } : {}),
      ...(c.intervalSeconds !== undefined ? { intervalSeconds: c.intervalSeconds } : {}),
      ...(c.timezone !== undefined ? { timezone: c.timezone } : {}),
      ...(c.peakHours !== undefined ? { peakHours: c.peakHours } : {}),
      ...(c.onDemandAllowed !== undefined ? { onDemandAllowed: c.onDemandAllowed } : {}),
    }));

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
        defaultVaultUpdateCadence: parsed.mesh.defaultVaultUpdateCadence ?? null,
      },
      publicMeta,
      updateCadences,
      homeVaults,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}
