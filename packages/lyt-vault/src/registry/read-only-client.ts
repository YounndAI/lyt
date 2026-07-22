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

import type {
  DestinationKind,
  DestinationTargetKind,
  VaultDestinationSource,
} from "./destination-policy.js";
import { MIGRATIONS } from "./migrations.js";
import type { VaultSource, VaultStatus } from "./repo.js";
import { computeDisplayName, resolveVault } from "./vault-addressing.js";
import { getMeshByRid } from "./meshes-repo.js";
import { getRegistryPath } from "./client.js";
import {
  openSqliteReadOnly,
  type ReadOnlySqliteDatabase,
  type ReadOnlySqliteQueryClient,
} from "../sqlite/read-only-client.js";

export class RegistryUpgradeRequiredError extends Error {
  readonly errorCode = "registry-upgrade-required";
  readonly registryPath: string;
  readonly expectedVersions: readonly number[];
  readonly observedVersions: readonly number[];
  readonly detail: string | null;

  constructor(
    registryPath: string,
    expected: readonly number[],
    observed: readonly number[],
    detail: string | null = null,
  ) {
    super(
      `Registry schema at ${registryPath} is not compatible with this Lyt build. ` +
        `Run a mutating Lyt command that performs registry migration before retrying the read-only check.` +
        (detail === null ? "" : ` (${detail})`),
    );
    this.name = "RegistryUpgradeRequiredError";
    this.registryPath = registryPath;
    this.expectedVersions = Object.freeze([...expected]);
    this.observedVersions = Object.freeze([...observed]);
    this.detail = detail;
  }
}

export interface ReadOnlyRegistryMissing {
  readonly kind: "missing";
  readonly path: string;
}

/**
 * A deliberately narrow adapter. The underlying handle is never exposed and
 * every statement must pass the shared single-SELECT guard.
 */
export interface ReadOnlyRegistryClient {
  readonly kind: "open";
  readonly path: string;
  readonly client: ReadOnlySqliteQueryClient;
  close(): void;
}

export type ReadonlyRegistryQueryClient = ReadOnlySqliteQueryClient;

export type ReadOnlyRegistryOpenResult = ReadOnlyRegistryMissing | ReadOnlyRegistryClient;

export interface VaultSnapshot {
  readonly rid: string;
  readonly canonicalName: string;
  readonly storedName: string;
  readonly path: string;
  readonly status: VaultStatus;
  readonly source: VaultSource;
  readonly homeMesh: Readonly<{
    rid: string;
    name: string;
  }> | null;
  readonly destination: Readonly<{
    kind: DestinationKind | null;
    source: VaultDestinationSource | null;
    target: string | null;
    targetKind: DestinationTargetKind | null;
    repositoryName: string | null;
  }>;
  readonly gitUrl: string | null;
}

export type ResolveVaultSnapshotResult =
  | ReadOnlyRegistryMissing
  | Readonly<{ kind: "not-found"; path: string; handle: string }>
  | Readonly<{ kind: "resolved"; path: string; vault: VaultSnapshot }>;

function readAppliedVersions(database: ReadOnlySqliteDatabase): readonly number[] {
  try {
    const rows = database.queryAll<{ version: number | bigint }>(
      "SELECT version FROM schema_migrations ORDER BY version ASC",
    );
    return rows.map((row) => Number(row.version));
  } catch {
    return [];
  }
}

function assertCompatibleSchema(database: ReadOnlySqliteDatabase, path: string): void {
  const expected = MIGRATIONS.map((migration) => migration.version).sort((a, b) => a - b);
  const observed = readAppliedVersions(database);
  if (
    observed.length !== expected.length ||
    observed.some((version, index) => version !== expected[index])
  ) {
    throw new RegistryUpgradeRequiredError(path, expected, observed);
  }

  const requiredColumns: Readonly<Record<string, readonly string[]>> = {
    vaults: [
      "rid",
      "name",
      "leaf",
      "path",
      "home_mesh_rid",
      "status",
      "source",
      "git_url",
      "destination_kind",
      "destination_source",
      "destination_target",
      "destination_target_kind",
      "destination_repository_name",
    ],
    meshes: ["rid", "name", "push_target", "push_kind", "own_created"],
    vault_aliases: ["alias", "vault_rid"],
  };
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const tableExists = database.queryOne(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
      [table],
    );
    const observedColumns =
      tableExists !== undefined
        ? new Set(
            // `table` is from the closed literal map above, never caller input.
            // Some SQLite/libSQL builds do not bind pragma_table_xinfo's table
            // argument, so use the vetted literal here.
            database
              .queryAll<{ name: string }>(`SELECT name FROM pragma_table_xinfo('${table}')`)
              .map((row) => String(row.name)),
          )
        : new Set<string>();
    const missing = columns.filter((column) => !observedColumns.has(column));
    if (missing.length > 0) {
      throw new RegistryUpgradeRequiredError(
        path,
        expected,
        observed,
        `${table} missing ${missing.join(",")}`,
      );
    }
  }
}

export function openRegistryReadOnly(opts?: { path?: string }): ReadOnlyRegistryOpenResult {
  const path = opts?.path ?? getRegistryPath();
  const opened = openSqliteReadOnly(path);
  if (opened.kind === "missing") return opened;
  try {
    assertCompatibleSchema(opened.database, opened.path);
    return Object.freeze({
      kind: "open" as const,
      path: opened.path,
      client: opened.database.client,
      close: () => opened.database.close(),
    });
  } catch (error) {
    opened.database.close();
    throw error;
  }
}

function freezeSnapshot(snapshot: VaultSnapshot): VaultSnapshot {
  if (snapshot.homeMesh !== null) Object.freeze(snapshot.homeMesh);
  Object.freeze(snapshot.destination);
  return Object.freeze(snapshot);
}

/** Resolve once, project only the selected vault, then close before inspection. */
export async function resolveVaultSnapshotReadOnly(
  handle: string,
  opts?: { path?: string },
): Promise<ResolveVaultSnapshotResult> {
  const opened = openRegistryReadOnly(opts);
  if (opened.kind === "missing") return opened;

  try {
    // The canonical resolver consumes only Client.execute. Keep the public
    // capability narrow rather than pretending the adapter implements the
    // complete libSQL Client surface (transactions/batches are unavailable).
    const queryClient = opened.client as unknown as Client;
    const vault = await resolveVault(queryClient, handle);
    if (vault === null) {
      return Object.freeze({ kind: "not-found" as const, path: opened.path, handle });
    }
    const home =
      vault.homeMeshRid === null ? null : await getMeshByRid(queryClient, vault.homeMeshRid);
    const canonicalName = await computeDisplayName(queryClient, vault);
    const snapshot = freezeSnapshot({
      rid: vault.ridHex,
      canonicalName,
      storedName: vault.name,
      path: vault.path,
      status: vault.status,
      source: vault.source,
      homeMesh: home === null ? null : { rid: home.ridHex, name: home.name },
      destination: {
        kind: vault.destinationKind,
        source: vault.destinationSource,
        target: vault.destinationTarget,
        targetKind: vault.destinationTargetKind,
        repositoryName: vault.destinationRepositoryName,
      },
      gitUrl: vault.gitUrl,
    });
    return Object.freeze({ kind: "resolved" as const, path: opened.path, vault: snapshot });
  } finally {
    opened.close();
  }
}
