/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { getRegistryPath } from "../registry/client.js";
import { validateMeshName } from "../util/identity.js";
import { getDefaultVaultsRoot, resolveVaultPath } from "../util/paths.js";
import { getFederationRepoDir } from "../util/federation-paths.js";
import { assertNoSymlinkOnWritePath, assertSafeWritePath } from "../util/write-path-guard.js";
import { openSqliteReadOnly, type ReadOnlySqliteDatabase } from "../sqlite/read-only-client.js";
import type { CreationPlanV1 } from "./creation-plan.js";

/** Facts acquired without creating, migrating, or pragmatizing the registry. */
export interface MeshInitPreflight {
  mainVaultPath: string;
  meshYonPath: string;
  registryPath: string;
  meshExists: boolean;
  parentExists: boolean | null;
  podRid: string | null;
  podIdentity:
    | { state: "missing" }
    | { state: "present"; rid: string; handle: string; repositoryRoot: string }
    | { state: "conflict"; rids: readonly string[] };
}

/**
 * Whole-pod read-only bootstrap facts.  Root `lyt init` uses this before it
 * opens a migration-capable registry, so a fresh branch can plan before any
 * registry/database write occurs.
 */
export interface RegistryTopologyPreflight {
  registryPath: string;
  meshCount: number;
  vaultCount: number;
  podIdentities: readonly { handle: string; rid: string }[];
}

export function inspectRegistryTopologyPreflight(args?: {
  registryPath?: string;
}): RegistryTopologyPreflight {
  const registryPath = args?.registryPath ?? getRegistryPath();
  const opened = openSqliteReadOnly(registryPath);
  if (opened.kind === "missing") {
    return { registryPath, meshCount: 0, vaultCount: 0, podIdentities: [] };
  }
  try {
    const tables = new Set(
      opened.database
        .queryAll<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .map((row) => String(row.name)),
    );
    const scalar = (table: string): number => {
      if (!tables.has(table)) return 0;
      const row = opened.database.queryOne<{ count: number | bigint }>(
        `SELECT count(*) AS count FROM ${table}`,
      );
      return Number(row?.count ?? 0);
    };
    const podIdentities = tables.has("federation_state")
      ? opened.database.queryAll<{ handle: string; rid: string }>(
          "SELECT handle, lower(hex(fed_rid)) AS rid FROM federation_state ORDER BY handle",
        )
      : [];
    return {
      registryPath,
      meshCount: scalar("meshes"),
      vaultCount: scalar("vaults"),
      podIdentities: podIdentities.map((row) => ({
        handle: String(row.handle),
        rid: String(row.rid),
      })),
    };
  } finally {
    opened.database.close();
  }
}

/** Open an existing registry without granting the connection write capability. */
export function openMeshInitRegistryReadOnly(registryPath: string): ReadOnlySqliteDatabase {
  const opened = openSqliteReadOnly(registryPath);
  if (opened.kind === "missing") throw new Error(`registry does not exist: ${opened.path}`);
  return opened.database;
}

/**
 * The creation plan's last read boundary.  A missing registry is deliberately
 * an empty registry; opening it must not create a directory, database, cache,
 * or migration row. Existing files are accessed through the SELECT-only
 * capability.
 */
export async function inspectMeshInitPreflight(args: {
  name: string;
  parent?: string;
  registryPath?: string;
}): Promise<MeshInitPreflight> {
  validateMeshName(args.name);
  const mainVaultPath = resolveVaultPath(`${args.name}/main`);
  const registryPath = args.registryPath ?? getRegistryPath();
  const meshYonPath = join(mainVaultPath, ".lyt", "mesh.yon");
  const opened = openSqliteReadOnly(registryPath);
  try {
    if (opened.kind === "missing")
      return {
        mainVaultPath,
        meshYonPath,
        registryPath,
        meshExists: false,
        parentExists: args.parent ? false : null,
        podRid: null,
        podIdentity: { state: "missing" },
      };
    const tables = new Set(
      opened.database
        .queryAll<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .map((row) => String(row.name)),
    );
    const mesh = tables.has("meshes")
      ? opened.database.queryOne("SELECT 1 AS present FROM meshes WHERE name = ? LIMIT 1", [
          args.name,
        ])
      : undefined;
    const parent =
      args.parent === undefined || args.parent.length === 0
        ? null
        : tables.has("meshes") &&
          opened.database.queryOne("SELECT 1 AS present FROM meshes WHERE name = ? LIMIT 1", [
            args.parent,
          ]) !== undefined;
    const pods = !tables.has("federation_state")
      ? []
      : opened.database.queryAll<{ handle: string; rid: string }>(
          "SELECT handle, lower(hex(fed_rid)) AS rid FROM federation_state ORDER BY handle LIMIT 2",
        );
    const podIdentity =
      pods.length === 0
        ? ({ state: "missing" } as const)
        : pods.length === 1
          ? ({
              state: "present",
              rid: String(pods[0]!["rid"]),
              handle: String(pods[0]!["handle"]),
              repositoryRoot: getFederationRepoDir(String(pods[0]!["handle"])),
            } as const)
          : ({
              state: "conflict",
              rids: pods.map((pod: { rid: string }) => String(pod.rid)),
            } as const);
    return {
      mainVaultPath,
      meshYonPath,
      registryPath,
      meshExists: mesh !== undefined,
      parentExists: parent,
      podRid: pods.length === 1 ? String(pods[0]!["rid"]) : null,
      podIdentity,
    };
  } finally {
    if (opened.kind === "open") opened.database.close();
  }
}

/** Recheck target facts and every extant target parent immediately before writing. */
export function assertMeshInitWriteTarget(
  preflight: MeshInitPreflight,
  plan?: CreationPlanV1,
): void {
  if (preflight.meshExists) throw new Error("Mesh is already registered.");
  if (preflight.parentExists === false) throw new Error("Parent mesh is not registered.");
  if (preflight.podIdentity.state === "conflict") {
    throw new Error("Mesh creation refuses multiple or conflicting local pod identities.");
  }
  if (preflight.podIdentity.state === "missing") {
    if (plan?.intended_effects.identity.kind !== "create") {
      throw new Error(
        "First-mesh creation requires a plan that owns canonical pod identity creation.",
      );
    }
  } else if (
    plan !== undefined &&
    plan.intended_effects.identity.rid !== preflight.podIdentity.rid
  ) {
    throw new Error("Mesh creation identity effect does not match the existing local pod.");
  }
  if (existsSync(preflight.mainVaultPath)) throw new Error("Main vault path already exists.");
  assertNoSymlinkOnWritePath(getDefaultVaultsRoot(), preflight.mainVaultPath);
  assertSafeWritePath(preflight.registryPath);
  assertSafeWritePath(dirname(preflight.registryPath));
}

export function assertMeshYonWriteTarget(preflight: MeshInitPreflight): void {
  assertNoSymlinkOnWritePath(preflight.mainVaultPath, preflight.meshYonPath);
}
