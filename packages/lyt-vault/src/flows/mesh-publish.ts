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

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getMeshByName } from "../registry/meshes-repo.js";
import { getVaultByRid } from "../registry/repo.js";
import { vaultRepoNameFromParts } from "../util/federation-paths.js";
import { detectLicenseFromContent, type DetectedLicense } from "../util/license-detect.js";
import { parseMeshYon } from "../yon/mesh-read.js";
import { renderMeshYon, type MeshDoc } from "../yon/mesh-write.js";
import { checkPublicMeshHygiene, type CheckResult } from "./doctor.js";
import { realPublishGhClient, type PublishGhClient } from "../util/gh-mesh-publish.js";

// v1.B.6 — `lyt mesh publish <mesh>` meta-verb. Composes four sub-actions
// per lyt-public-mesh §2.1:
// (a) Set GH topic `lyt-public` on the mesh main vault repo (via gh
// repo edit --add-topic). Skipped under --no-set-topic. Logs +
// continues on gh-unavail per the ratified default (--strict converts to hard fail).
// (b) Validate LICENSE file presence at the mesh main vault root.
// Warns on missing per the ratified default; --strict hard-fails.
// (c) Run public_mesh_hygiene scan via checkPublicMeshHygiene. --strict
// converts warns→fails inside the check.
// (d) Compose + emit the canonical discovery URL +
// brand-voice status message.
//
// Also writes @MESH_PUBLIC into the mesh's mesh.yon if it doesn't already
// exist (initial publish provisions the record with publisher-supplied
// description; subsequent re-publishes leave the existing record alone so
// human-edited metadata isn't blown away). The schema is in place
// from Commit 1; the writer is here.

export class PublishMeshNotFoundError extends Error {
  readonly errorCode = "mesh-publish-not-found";
  readonly meshName: string;
  constructor(meshName: string) {
    super(
      `lyt mesh publish: no mesh registered with name '${meshName}'. Run 'lyt mesh init ${meshName}' first.`,
    );
    this.name = "PublishMeshNotFoundError";
    this.meshName = meshName;
  }
}

export class PublishMeshStrictFailureError extends Error {
  readonly errorCode = "mesh-publish-strict-failure";
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(
      `lyt mesh publish --strict: ${reasons.length} sub-action(s) failed: ${reasons.join("; ")}`,
    );
    this.name = "PublishMeshStrictFailureError";
    this.reasons = reasons;
  }
}

export interface PublishMeshArgs {
  meshName: string;
  registryDb?: Client | undefined;
  ghClient?: PublishGhClient | undefined;
  // Override the publisher-declared description on first publish. When the
  // mesh already has @MESH_PUBLIC, this is a no-op (the existing record
  // wins to preserve human-curated metadata).
  description?: string | undefined;
  noSetTopic?: boolean | undefined;
  noLicenseCheck?: boolean | undefined;
  noHygiene?: boolean | undefined;
  strict?: boolean | undefined;
  nowIso?: string | undefined;
}

export type PublishSubActionStatus = "ok" | "skipped" | "warn" | "fail";

export interface PublishSubActionResult {
  action: "set-topic" | "license-check" | "hygiene" | "write-public-meta";
  status: PublishSubActionStatus;
  message: string;
}

export interface PublishMeshResult {
  meshName: string;
  meshRidHex: string;
  pushTarget: string | null;
  discoveryUrl: string | null;
  subActions: PublishSubActionResult[];
  hygieneFindings: CheckResult[];
  licensePosture: DetectedLicense;
  durationMs: number;
}

const PUBLIC_TOPIC = "lyt-public";

export async function publishMeshFlow(args: PublishMeshArgs): Promise<PublishMeshResult> {
  const startedAt = Date.now();
  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());
  const ghClient = args.ghClient ?? realPublishGhClient;
  const strict = args.strict === true;

  try {
    const mesh = await getMeshByName(db, args.meshName);
    if (mesh === null) throw new PublishMeshNotFoundError(args.meshName);
    if (mesh.mainVaultRid === null) {
      throw new Error(
        `lyt mesh publish: mesh '${args.meshName}' has no main_vault_rid; cannot resolve main vault.`,
      );
    }
    const mainVault = await getVaultByRid(db, mesh.mainVaultRid);
    if (mainVault === null) {
      throw new Error(
        `lyt mesh publish: mesh '${args.meshName}' main_vault_rid points at no vault row.`,
      );
    }
    if (!existsSync(mainVault.path)) {
      throw new Error(`lyt mesh publish: main vault path missing: ${mainVault.path}`);
    }

    const subActions: PublishSubActionResult[] = [];
    const strictReasons: string[] = [];

    // Sub-action 0 (always): write or preserve @MESH_PUBLIC.
    const meshYonPath = join(mainVault.path, ".lyt", "mesh.yon");
    if (!existsSync(meshYonPath)) {
      throw new Error(
        `lyt mesh publish: main vault is missing .lyt/mesh.yon — run 'lyt mesh rebuild-registry --mesh ${args.meshName}' to regenerate.`,
      );
    }
    const doc = parseMeshYon(readFileSync(meshYonPath, "utf8"));
    let metaWritten = false;
    if (doc.publicMeta === undefined) {
      if (args.description === undefined || args.description.length === 0) {
        throw new Error(
          `lyt mesh publish: mesh '${args.meshName}' has no @MESH_PUBLIC record yet. Pass --description "<text>" to provision it.`,
        );
      }
      const updated: MeshDoc = {
        ...doc,
        publicMeta: {
          meshRid: mesh.rid,
          description: args.description,
          createdAt: args.nowIso ?? new Date().toISOString(),
        },
      };
      const tmp = `${meshYonPath}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, renderMeshYon(updated), "utf8");
      renameSync(tmp, meshYonPath);
      metaWritten = true;
    }
    subActions.push({
      action: "write-public-meta",
      status: metaWritten ? "ok" : "skipped",
      message: metaWritten
        ? `@MESH_PUBLIC record provisioned`
        : `@MESH_PUBLIC record already present (preserving existing metadata)`,
    });

    // Sub-action (a): set GH topic.
    if (args.noSetTopic === true || mesh.pushTarget === null) {
      subActions.push({
        action: "set-topic",
        status: "skipped",
        message:
          mesh.pushTarget === null
            ? `mesh has no push_target (--no-push mesh); topic-set skipped`
            : `--no-set-topic`,
      });
    } else {
      // Brief B (scheme D) — the mesh main vault's repo name now routes
      // through the vaultRepoName chokepoint (lyt-vault-<mesh>--main), not the
      // former prefix-less `${meshName}-main`. SEE ALSO federation-paths.ts
      // vaultRepoNameFromParts + mesh-info.ts (same reconciliation).
      const repoName = vaultRepoNameFromParts(args.meshName, "main");
      const ok = await ghClient.setRepoTopic(mesh.pushTarget, repoName, PUBLIC_TOPIC);
      if (ok) {
        subActions.push({
          action: "set-topic",
          status: "ok",
          message: `gh repo edit ${mesh.pushTarget}/${repoName} --add-topic ${PUBLIC_TOPIC}`,
        });
      } else {
        subActions.push({
          action: "set-topic",
          status: "warn",
          message: `gh repo edit failed for ${mesh.pushTarget}/${repoName} (gh unavail?); --strict would fail`,
        });
        if (strict) strictReasons.push(`set-topic failed for ${mesh.pushTarget}/${repoName}`);
      }
    }

    // Sub-action (b): LICENSE validation.
    let licensePosture: DetectedLicense = { id: null, bucket: "unknown" };
    if (args.noLicenseCheck === true) {
      subActions.push({
        action: "license-check",
        status: "skipped",
        message: "--no-license-check",
      });
    } else {
      const licensePath = join(mainVault.path, "LICENSE");
      if (existsSync(licensePath)) {
        const txt = readFileSync(licensePath, "utf8");
        licensePosture = detectLicenseFromContent(txt);
        subActions.push({
          action: "license-check",
          status: "ok",
          message: `LICENSE present (detected: ${licensePosture.id ?? "unknown"}; bucket: ${licensePosture.bucket})`,
        });
      } else {
        subActions.push({
          action: "license-check",
          status: "warn",
          message: `LICENSE file missing at ${licensePath}; --strict would fail`,
        });
        if (strict) strictReasons.push("LICENSE file missing");
      }
    }

    // Sub-action (c): public_mesh_hygiene scan.
    let hygieneFindings: CheckResult[] = [];
    if (args.noHygiene === true) {
      subActions.push({
        action: "hygiene",
        status: "skipped",
        message: "--no-hygiene",
      });
    } else {
      hygieneFindings = await checkPublicMeshHygiene(db, { strict });
      // Filter for THIS mesh only (the doctor helper scans all public meshes).
      const meshSpecific = hygieneFindings.filter((f) => {
        if (f.detail === undefined) return false;
        return (f.detail as Record<string, unknown>)["meshName"] === args.meshName;
      });
      const matches = meshSpecific.filter((f) => f.status === "warn" || f.status === "fail");
      if (matches.length === 0) {
        subActions.push({
          action: "hygiene",
          status: "ok",
          message: "no hygiene matches in mesh content",
        });
      } else {
        subActions.push({
          action: "hygiene",
          status: strict ? "fail" : "warn",
          message: `${matches.length} hygiene match(es): ${matches
            .map((m) => m.id)
            .slice(0, 3)
            .join(", ")}${matches.length > 3 ? "…" : ""}`,
        });
        if (strict) strictReasons.push(`hygiene scan: ${matches.length} match(es)`);
      }
      hygieneFindings = meshSpecific;
    }

    if (strict && strictReasons.length > 0) {
      throw new PublishMeshStrictFailureError(strictReasons);
    }

    // Sub-action (d): discovery URL emit + brand-voice status.
    const discoveryUrl =
      mesh.pushTarget !== null
        ? `https://github.com/${mesh.pushTarget}/${vaultRepoNameFromParts(args.meshName, "main")}`
        : null;
    // Brand-voice status emission per lyt-brand-voice §2 lexicon.
    // Console.error so it doesn't pollute --json stdout.
    // eslint-disable-next-line no-console
    console.error(`Unfurling \`${args.meshName}\` to the world…`);
    if (discoveryUrl !== null) {
      // eslint-disable-next-line no-console
      console.error(`Discovery URL: ${discoveryUrl}`);
    }

    return {
      meshName: args.meshName,
      meshRidHex: mesh.ridHex,
      pushTarget: mesh.pushTarget,
      discoveryUrl,
      subActions,
      hygieneFindings,
      licensePosture,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}

// Helper used by tests + downstream callers — for completeness, the
// "is this mesh published?" query.
export async function isMeshPublic(db: Client, meshName: string): Promise<boolean> {
  const mesh = await getMeshByName(db, meshName);
  if (mesh === null || mesh.mainVaultRid === null) return false;
  const mainVault = await getVaultByRid(db, mesh.mainVaultRid);
  if (mainVault === null) return false;
  const meshYonPath = join(mainVault.path, ".lyt", "mesh.yon");
  if (!existsSync(meshYonPath)) return false;
  try {
    const parsed = parseMeshYon(readFileSync(meshYonPath, "utf8"));
    return parsed.publicMeta !== undefined;
  } catch {
    return false;
  }
}
