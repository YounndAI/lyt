/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import BetterSqlite3 from "better-sqlite3";

import { getRegistryPath } from "../registry/client.js";
import {
  destinationPolicyKey,
  type DestinationPolicyRecordV1,
  type DestinationPolicyValue,
} from "../registry/destination-policy.js";
import {
  getFederationRepoDir,
  getFederationRoot,
  vaultRepoName,
} from "../util/federation-paths.js";
import { resolveVaultPath } from "../util/paths.js";
import { parseCanonicalDestinationTarget } from "../registry/destination-policy.js";
import { assertSafeWritePath } from "../util/write-path-guard.js";
import {
  resolveCreationPlanV1,
  type CreationPlanV1,
  type DestinationRequest,
} from "./creation-plan.js";
import {
  foldDestinationPolicyWinners,
  readAllDestinationPolicyRecords,
} from "./federation/destination-policy-ledger.js";

export interface VaultInitPreflight {
  meshEnabled: boolean;
  effectiveName: string;
  vaultPath: string;
  registryPath: string;
  vaultExists: boolean;
  existingVault: { rid: string; path: string; policy: DestinationPolicyValue | null } | null;
  podRid: string | null;
  podIdentity:
    | { state: "missing" }
    | { state: "present"; rid: string; handle: string; repositoryRoot: string }
    | { state: "conflict"; rids: readonly string[] };
  mesh: {
    rid: string;
    name: string;
    mainVaultPath: string;
    policy: DestinationPolicyValue | null;
  } | null;
}

export interface VaultCreationBinding {
  destinationRequest: DestinationRequest;
  creationPlan: CreationPlanV1;
  attemptId: string;
}

/** Resolve the name/path that apply will use without opening or creating state. */
export function resolveVaultInitTarget(args: {
  name: string;
  path?: string;
  meshEnabled: boolean;
  defaultMeshName?: string;
}): { effectiveName: string; vaultPath: string; meshName: string | null } {
  const slash = args.name.indexOf("/");
  const meshName = args.meshEnabled
    ? slash === -1
      ? (args.defaultMeshName ?? "personal")
      : args.name.slice(0, slash)
    : null;
  const effectiveName = args.meshEnabled && slash === -1 ? `${meshName}/${args.name}` : args.name;
  return {
    effectiveName,
    vaultPath: resolveVaultPath(effectiveName, args.path),
    meshName,
  };
}

/**
 * Physically read-only creation preflight. A missing registry is an empty
 * registry. Existing files are opened with SQLite's read-only flag and never
 * receive migrations, PRAGMAs, caches, or identity writes.
 */
export function inspectVaultInitPreflight(args: {
  name: string;
  path?: string;
  meshEnabled: boolean;
  defaultMeshName?: string;
  registryPath?: string;
}): VaultInitPreflight {
  const target = resolveVaultInitTarget(args);
  const registryPath = args.registryPath ?? getRegistryPath();
  if (!existsSync(registryPath)) {
    return {
      effectiveName: target.effectiveName,
      meshEnabled: args.meshEnabled,
      vaultPath: target.vaultPath,
      registryPath,
      vaultExists: false,
      existingVault: null,
      podRid: null,
      podIdentity: { state: "missing" },
      mesh: null,
    };
  }

  const db = new BetterSqlite3(registryPath, { readonly: true, fileMustExist: true });
  try {
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    const existingVault = tables.has("vaults")
      ? (db
          .prepare("SELECT lower(hex(rid)) AS rid, path FROM vaults WHERE name = ? LIMIT 1")
          .get(target.effectiveName) as { rid: string; path: string } | undefined)
      : undefined;
    const podRows = tables.has("federation_state")
      ? (db
          .prepare(
            "SELECT handle, lower(hex(fed_rid)) AS rid FROM federation_state ORDER BY handle LIMIT 2",
          )
          .all() as Array<{ handle: string; rid: string }>)
      : [];
    const meshRow =
      target.meshName !== null && tables.has("meshes")
        ? (db
            .prepare(
              `SELECT lower(hex(m.rid)) AS rid, m.name, m.own_created, m.destination_kind,
                      m.destination_source, m.push_target, m.push_kind, v.path AS main_vault_path
                 FROM meshes m
                 LEFT JOIN vaults v ON v.rid = m.main_vault_rid
                WHERE m.name = ? LIMIT 1`,
            )
            .get(target.meshName) as Record<string, unknown> | undefined)
        : undefined;
    const podRid = podRows.length === 1 ? String(podRows[0]!.rid) : null;
    const podIdentity =
      podRows.length === 0
        ? ({ state: "missing" } as const)
        : podRows.length === 1
          ? ({
              state: "present",
              rid: String(podRows[0]!.rid),
              handle: String(podRows[0]!.handle),
              repositoryRoot: getFederationRepoDir(String(podRows[0]!.handle)),
            } as const)
          : ({ state: "conflict", rids: podRows.map((row) => String(row.rid)) } as const);
    const canonicalMeshPolicy =
      meshRow === undefined || podRid === null
        ? undefined
        : canonicalOwnedMeshPolicy(podRid, String(meshRow["rid"]));
    return {
      effectiveName: target.effectiveName,
      meshEnabled: args.meshEnabled,
      vaultPath: target.vaultPath,
      registryPath,
      vaultExists: existingVault !== undefined,
      existingVault:
        existingVault === undefined
          ? null
          : {
              rid: String(existingVault.rid),
              path: String(existingVault.path),
              policy:
                podRid === null
                  ? null
                  : (canonicalVaultPolicy(podRid, String(existingVault.rid)) ?? null),
            },
      podRid,
      podIdentity,
      mesh:
        meshRow === undefined
          ? null
          : {
              rid: String(meshRow["rid"]),
              name: String(meshRow["name"]),
              mainVaultPath: String(meshRow["main_vault_path"] ?? ""),
              // A present canonical winner (including a tombstone) always
              // outranks stale compatibility columns. Columns remain only a
              // legacy fallback when no ledger record exists yet.
              policy:
                canonicalMeshPolicy === undefined ? ownedMeshPolicy(meshRow) : canonicalMeshPolicy,
            },
    };
  } finally {
    db.close();
  }
}

function canonicalVaultPolicy(
  podRid: string,
  vaultRid: string,
): DestinationPolicyValue | null | undefined {
  const winner = foldDestinationPolicyWinners(
    readAllDestinationPolicyRecords(podRid, getFederationRoot()),
  ).get(destinationPolicyKey("vault", vaultRid));
  if (winner === undefined) return undefined;
  if (winner.state !== "active") return null;
  return {
    destinationKind: winner.destinationKind,
    targetOwner: winner.targetOwner,
    targetKind: winner.targetKind,
    repositoryName: winner.repositoryName,
    source: winner.source,
  };
}

function canonicalOwnedMeshPolicy(
  podRid: string,
  meshRid: string,
): DestinationPolicyValue | null | undefined {
  const winner = foldDestinationPolicyWinners(
    readAllDestinationPolicyRecords(podRid, getFederationRoot()),
  ).get(destinationPolicyKey("mesh", meshRid));
  if (winner === undefined) return undefined;
  if (winner.state !== "active") return null;
  return meshPolicyFromRecord(winner);
}

function meshPolicyFromRecord(record: DestinationPolicyRecordV1): DestinationPolicyValue | null {
  if (record.source !== "explicit" && record.source !== "authenticated-default") return null;
  if (record.destinationKind === "local") {
    return {
      destinationKind: "local",
      targetOwner: null,
      targetKind: null,
      source: record.source,
    };
  }
  if (record.targetOwner === null || record.targetKind === null) return null;
  return {
    destinationKind: "github",
    targetOwner: record.targetOwner,
    targetKind: record.targetKind,
    source: record.source,
  };
}

/** Validate request, attempt, subject, inheritance, and the exact pure plan. */
export function assertVaultCreationBinding(
  preflight: VaultInitPreflight,
  binding: VaultCreationBinding,
): void {
  if (
    binding.attemptId.length === 0 ||
    binding.creationPlan.attempt.attempt_id !== binding.attemptId
  ) {
    throw new Error("Vault creation plan is not bound to this attempt.");
  }
  assertVaultIdentityEffect(preflight, binding.creationPlan);
  if (!preflight.meshEnabled) {
    const effects = binding.creationPlan.intended_effects;
    if (
      effects.mesh.kind !== "none" ||
      effects.topology_bindings.length !== 0 ||
      effects.registry_rows.some((row) => row.table === "meshes" || row.table === "mesh_vaults") ||
      binding.creationPlan.children.length !== 0
    ) {
      throw new Error(
        "Vault creation plan contains mesh, topology, or child effects while mesh self-heal is disabled.",
      );
    }
  }
  const primaryVault = binding.creationPlan.intended_effects.vaults.find(
    (vault) => vault.rid === binding.creationPlan.intended_effects.primary_vault_rid,
  );
  if (primaryVault === undefined || primaryVault.name !== preflight.effectiveName) {
    throw new Error("Vault creation effect name does not match this preflight.");
  }
  if (primaryVault.root !== preflight.vaultPath) {
    throw new Error("Vault creation effect root does not match this preflight.");
  }
  if (
    preflight.mesh !== null &&
    (binding.creationPlan.intended_effects.mesh.rid !== preflight.mesh.rid ||
      binding.creationPlan.intended_effects.mesh.kind !== "existing")
  ) {
    throw new Error("Vault creation effect does not bind the preflight mesh.");
  }
  if (
    preflight.meshEnabled &&
    preflight.mesh === null &&
    (binding.creationPlan.intended_effects.mesh.kind !== "create" ||
      binding.creationPlan.children.length !== 1)
  ) {
    throw new Error(
      "A missing home mesh requires exactly one bound mesh-main child creation plan.",
    );
  }
  if (
    preflight.meshEnabled &&
    preflight.mesh !== null &&
    binding.creationPlan.children.length !== 0
  ) {
    throw new Error("An existing home mesh may not carry a synthetic mesh creation child.");
  }
  if (binding.creationPlan.attempt.active_actor.attempt_id !== binding.attemptId) {
    throw new Error("Vault creation actor observation is not bound to this attempt.");
  }
  if (
    binding.creationPlan.attempt.permission_observation !== null &&
    binding.creationPlan.attempt.permission_observation.attempt_id !== binding.attemptId
  ) {
    throw new Error("Vault creation permission observation is not bound to this attempt.");
  }
  const expectedRepositoryName = vaultRepoName(preflight.effectiveName);
  if (
    binding.creationPlan.subject.kind !== "vault" ||
    binding.creationPlan.subject.repositoryName !== expectedRepositoryName ||
    binding.creationPlan.publication !== "not-published" ||
    binding.creationPlan.online_action !== "none"
  ) {
    throw new Error("Vault creation plan subject or effect boundary does not match this vault.");
  }
  if (preflight.mesh !== null && binding.destinationRequest.kind === "auto") {
    throw new Error(
      "An existing mesh requires an inherited destination or an explicit vault override.",
    );
  }

  const inherited =
    binding.destinationRequest.kind === "inherit" &&
    preflight.mesh !== null &&
    preflight.mesh.policy !== null
      ? { meshRid: preflight.mesh.rid, policy: preflight.mesh.policy }
      : null;
  const resolved = resolveCreationPlanV1({
    request: binding.destinationRequest,
    subject: { kind: "vault", repositoryName: expectedRepositoryName },
    actor: binding.creationPlan.attempt.active_actor,
    intendedEffects: binding.creationPlan.intended_effects,
    inherited,
    permission: binding.creationPlan.attempt.permission_observation,
    ...(binding.creationPlan.children.length === 0
      ? {}
      : { children: binding.creationPlan.children }),
  });
  if (resolved.kind !== "plan" || !isDeepStrictEqual(resolved.plan, binding.creationPlan)) {
    throw new Error(
      "Vault creation plan drifted from the current request, attempt, or inherited mesh policy.",
    );
  }
}

/** Revalidate every write target immediately before the writable apply seam. */
export function assertVaultInitWriteTarget(
  preflight: VaultInitPreflight,
  binding?: VaultCreationBinding,
): void {
  if (preflight.vaultExists)
    throw new Error(`Vault '${preflight.effectiveName}' is already registered.`);
  if (preflight.podIdentity.state === "conflict") {
    throw new Error("Vault creation refuses multiple or conflicting local pod identities.");
  }
  if (preflight.podIdentity.state === "missing") {
    if (binding === undefined) {
      throw new Error(
        "First-vault creation requires a plan that owns canonical pod identity creation.",
      );
    }
    assertVaultIdentityEffect(preflight, binding.creationPlan);
  }
  if (existsSync(preflight.vaultPath))
    throw new Error(`Vault path already exists: ${preflight.vaultPath}`);
  assertSafeWritePath(preflight.vaultPath);
  assertSafeWritePath(preflight.registryPath);
}

function assertVaultIdentityEffect(preflight: VaultInitPreflight, plan: CreationPlanV1): void {
  const effect = plan.intended_effects.identity;
  if (preflight.podIdentity.state === "conflict") {
    throw new Error("Vault creation refuses multiple or conflicting local pod identities.");
  }
  if (preflight.podIdentity.state === "missing" && effect.kind !== "create") {
    throw new Error("A missing pod identity must be an explicit planned create effect.");
  }
  if (preflight.podIdentity.state === "present" && effect.rid !== preflight.podIdentity.rid) {
    throw new Error("Vault creation identity effect does not match the existing local pod.");
  }
}

function ownedMeshPolicy(row: Record<string, unknown>): DestinationPolicyValue | null {
  if (Number(row["own_created"] ?? 0) !== 1) return null;
  const source = row["destination_source"];
  if (source !== "explicit" && source !== "authenticated-default") return null;
  if (row["destination_kind"] === "local") {
    return { destinationKind: "local", targetOwner: null, targetKind: null, source };
  }
  if (row["destination_kind"] !== "github" || row["push_target"] == null) return null;
  const parsed = parseCanonicalDestinationTarget(
    `github:${row["push_kind"] === "org" ? "org" : "user"}/${String(row["push_target"])}`,
  );
  return parsed === null ? null : { ...parsed, source };
}
