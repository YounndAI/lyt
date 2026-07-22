/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { lstatSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createClient,
  type Client,
  type InArgs,
  type InStatement,
  type ResultSet,
} from "@libsql/client";
import Database from "libsql";

type SqlValue = string | number | bigint | Uint8Array | null;

export interface ReadOnlySqliteQueryClient {
  execute(statement: InStatement | string, args?: InArgs): Promise<ResultSet>;
  close(): void;
}

export interface ReadOnlySqliteDatabase {
  readonly client: ReadOnlySqliteQueryClient;
  queryAll<T extends Record<string, unknown>>(sql: string, args?: InArgs): T[];
  queryOne<T extends Record<string, unknown>>(sql: string, args?: InArgs): T | undefined;
  close(): void;
}

export type ReadOnlySqliteOpenResult =
  | Readonly<{ kind: "missing"; path: string }>
  | Readonly<{ kind: "open"; path: string; database: ReadOnlySqliteDatabase }>;

function stripLeadingComments(sql: string): string {
  return sql.trimStart().replace(/^(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*/u, "");
}

function assertSingleSelect(sql: string): void {
  const normalized = stripLeadingComments(sql);
  if (!/^SELECT\b/iu.test(normalized) || normalized.includes(";")) {
    throw new Error("read-only SQLite capability accepts one SELECT statement only");
  }
}

function assertExistingRegularPathWithoutReparsePoints(requestedPath: string): string {
  const absolute = resolve(requestedPath);
  const root = parse(absolute).root;
  const chain: string[] = [];
  for (let current = absolute; current !== root; current = dirname(current)) chain.push(current);
  chain.push(root);

  for (const component of chain.reverse()) {
    let stat;
    try {
      stat = lstatSync(component);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw Object.assign(new Error(`read-only SQLite database does not exist: ${absolute}`), {
          code: "ENOENT",
        });
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`read-only SQLite path contains a symlink or junction: ${component}`);
    }
    if (component === absolute && !stat.isFile()) {
      throw new Error(`read-only SQLite path is not a regular file: ${absolute}`);
    }
  }
  return absolute;
}

function valuesFromArgs(args: InArgs | undefined): readonly SqlValue[] | Record<string, SqlValue> {
  return (args ?? []) as readonly SqlValue[] | Record<string, SqlValue>;
}

function prepareRows<T extends Record<string, unknown>>(
  db: Database.Database,
  sql: string,
  args?: InArgs,
): T[] {
  assertSingleSelect(sql);
  const statement = db.prepare(sql);
  const values = valuesFromArgs(args);
  return (Array.isArray(values) ? statement.all(...values) : statement.all(values)) as T[];
}

function capabilityClient(client: Client, close: () => void): ReadOnlySqliteQueryClient {
  return Object.freeze({
    async execute(statement: InStatement | string, args?: InArgs): Promise<ResultSet> {
      const sql = typeof statement === "string" ? statement : statement.sql;
      assertSingleSelect(sql);
      const guardedArgs = typeof statement === "string" ? (args ?? []) : (statement.args ?? []);
      return client.execute({ sql, args: guardedArgs });
    },
    close,
  });
}

function capabilityDatabase(db: Database.Database, queryClient: Client): ReadOnlySqliteDatabase {
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    let firstError: unknown;
    try {
      queryClient.close();
    } catch (error) {
      firstError = error;
    }
    try {
      db.close();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError !== undefined) throw firstError;
  };
  const queryAll = <T extends Record<string, unknown>>(sql: string, args?: InArgs): T[] =>
    prepareRows<T>(db, sql, args);
  const queryOne = <T extends Record<string, unknown>>(sql: string, args?: InArgs): T | undefined =>
    queryAll<T>(sql, args)[0];
  const client = capabilityClient(queryClient, close);
  return Object.freeze({
    client,
    queryAll,
    queryOne,
    close,
  });
}

/**
 * Open an existing local database behind a SELECT-only libSQL capability.
 *
 * The libSQL runtime does not expose a physically read-only open. Its handle is
 * therefore never returned; all SQL must pass the single-SELECT guard first.
 */
export function openSqliteReadOnly(path: string): ReadOnlySqliteOpenResult {
  let absolute: string;
  try {
    absolute = assertExistingRegularPathWithoutReparsePoints(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.freeze({ kind: "missing" as const, path: resolve(path) });
    }
    throw error;
  }

  const db = new Database(absolute, { timeout: 0 });
  try {
    const queryClient = createClient({ url: pathToFileURL(absolute).href });
    return Object.freeze({
      kind: "open" as const,
      path: absolute,
      database: capabilityDatabase(db, queryClient),
    });
  } catch (error) {
    db.close();
    throw error;
  }
}
