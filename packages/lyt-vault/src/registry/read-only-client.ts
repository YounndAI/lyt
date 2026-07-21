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

import { existsSync } from "node:fs";

import type { Client, InArgs, InStatement, ResultSet } from "@libsql/client";
import BetterSqlite3 from "better-sqlite3";

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

type SqlValue = string | number | bigint | Uint8Array | null;

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
 * A deliberately narrow adapter. The database handle is opened by SQLite with
 * both `readonly` and `fileMustExist`; the SQL guard is defense-in-depth so a
 * future resolver edit cannot even attempt a write through this capability.
 */
export interface ReadOnlyRegistryClient {
  readonly kind: "open";
  readonly path: string;
  readonly client: ReadonlyRegistryQueryClient;
  close(): void;
}

export interface ReadonlyRegistryQueryClient {
  execute(statement: InStatement | string, args?: InArgs): Promise<ResultSet>;
  close(): void;
}

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

function assertReadStatement(sql: string): void {
  const normalized = sql.trimStart().replace(/^(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*/u, "");
  if (!/^SELECT\b/iu.test(normalized)) {
    throw new Error("read-only registry capability accepts SELECT statements only");
  }
}

function valuesFromArgs(args: InArgs | undefined): readonly SqlValue[] | Record<string, SqlValue> {
  if (args === undefined) return [];
  return args as readonly SqlValue[] | Record<string, SqlValue>;
}

function makeClient(db: BetterSqlite3.Database): ReadonlyRegistryQueryClient {
  const execute = async (statement: InStatement | string, args?: InArgs): Promise<ResultSet> => {
    const sql = typeof statement === "string" ? statement : statement.sql;
    const values =
      typeof statement === "string" ? valuesFromArgs(args) : valuesFromArgs(statement.args);
    assertReadStatement(sql);
    const stmt = db.prepare(sql);
    const rows = (Array.isArray(values) ? stmt.all(...values) : stmt.all(values)) as Record<
      string,
      SqlValue
    >[];
    const columns = rows.length === 0 ? [] : Object.keys(rows[0]!);
    return {
      columns,
      columnTypes: [],
      rows,
      rowsAffected: 0,
      lastInsertRowid: undefined,
      toJSON() {
        return { columns, rows };
      },
    } as unknown as ResultSet;
  };

  return {
    execute,
    close: () => db.close(),
  };
}

function readAppliedVersions(db: BetterSqlite3.Database): readonly number[] {
  try {
    const rows = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
      .all() as Array<{ version: number | bigint }>;
    return rows.map((row) => Number(row.version));
  } catch {
    return [];
  }
}

function assertCompatibleSchema(db: BetterSqlite3.Database, path: string): void {
  const expected = MIGRATIONS.map((migration) => migration.version).sort((a, b) => a - b);
  const observed = readAppliedVersions(db);
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
    const tableExists = db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    const observedColumns = tableExists
      ? new Set(
          // `table` is from the closed literal map above, never caller input.
          // Some SQLite/libSQL builds do not bind pragma_table_xinfo's table
          // argument, so use the vetted literal here.
          (
            db.prepare(`SELECT name FROM pragma_table_xinfo('${table}')`).all() as Array<{
              name: string;
            }>
          ).map((row) => row.name),
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
  if (!existsSync(path)) return Object.freeze({ kind: "missing" as const, path });

  // Do not use SQLite's immutable URI mode here: immutable databases ignore a
  // live WAL, which would make a scoped check observe an inconsistent snapshot.
  // These flags instead require SQLite to open the existing database read-only;
  // this adapter never executes a pragma, migration, journal-mode change, or
  // write probe. The focused fixture plants write-denied journal/WAL/SHM
  // sentinels and watches for sidecar events as observable evidence, without
  // claiming a portable proof about OS-level byte-range locks.
  const db = new BetterSqlite3(path, {
    readonly: true,
    fileMustExist: true,
    timeout: 0,
  });
  try {
    assertCompatibleSchema(db, path);
    const client = makeClient(db);
    return Object.freeze({
      kind: "open" as const,
      path,
      client,
      close: () => client.close(),
    });
  } catch (error) {
    db.close();
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
