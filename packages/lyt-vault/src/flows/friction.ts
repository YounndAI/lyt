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

import { recordAudit } from "../registry/audit-write.js";
import {
  AUDIT_ACTIONS,
  FRICTION_CATEGORIES,
  type FrictionCategory,
} from "../registry/vault-db-migrations.js";
import { closeVaultDb, openAuditDb } from "../registry/vault-db.js";
import { getIdentity } from "../util/identity.js";
import { hexToUuid7Bytes, newUuidv7Bytes, uuid7BytesToHex } from "../util/uuid7.js";
import { resolveSingleVault, resolveVaults } from "../util/vault-resolve.js";

// Arc §10.1: provisional threshold — ≥3 distinct unresolved sync.friction.*
// incidents in a 28d window triggers the Tier A plugin window. Recalibrate
// after week-1 incident-density data lands.
export const FRICTION_TIER_A_THRESHOLD = 3;
export const FRICTION_REPORT_DEFAULT_WINDOW_MS = 28 * 24 * 60 * 60 * 1000;

export interface FrictionNoteArgs {
  description: string;
  category?: FrictionCategory;
  vault?: string;
  nowMs?: number;
}

export interface FrictionNoteResult {
  vaultName: string;
  idHex: string;
  action: string;
  category: FrictionCategory;
  actor: string;
  ts: number;
}

export interface FrictionReportArgs {
  vault?: string;
  windowMs?: number;
  excludeFalsePositive?: boolean;
  nowMs?: number;
}

export interface FrictionRowSummary {
  idHex: string;
  ts: number;
  category: string;
  actor: string;
  description: string;
  resolved: boolean;
  falsePositive: boolean;
}

export interface FrictionReportResult {
  windowMs: number;
  windowStartMs: number;
  windowEndMs: number;
  vaultsScanned: string[];
  byCategory: Record<string, number>;
  totalUnresolved: number;
  tierATriggered: boolean;
  rows: FrictionRowSummary[];
}

export interface FrictionMutateArgs {
  idHex: string;
  note?: string;
  vault?: string;
  nowMs?: number;
}

export interface FrictionMutateResult {
  vaultName: string;
  idHex: string;
  shippedFixIdHex?: string;
}

// Writes a `sync.friction.<category>` row to the per-vault audit_log.
// Default category is `propagation.gap` (arc §10.2: handler-supplied note
// without auto-detected sync event). Actor = current identity.
export async function frictionNoteFlow(args: FrictionNoteArgs): Promise<FrictionNoteResult> {
  if (args.description.trim().length === 0) {
    throw new Error("`lyt friction note <description>` requires a non-empty description.");
  }
  const category: FrictionCategory = args.category ?? "propagation.gap";
  if (!FRICTION_CATEGORIES.includes(category)) {
    throw new Error(
      `Unknown friction category: ${JSON.stringify(category)}. Valid: ${FRICTION_CATEGORIES.join(", ")}`,
    );
  }

  const vault = await resolveSingleVault(args.vault);
  const action = `sync.friction.${category}`;
  const actor = getIdentity();
  const ts = args.nowMs ?? Date.now();
  const id = newUuidv7Bytes();

  const db = await openAuditDb(vault.path);
  try {
    // v1.A.2 Lock 0.2 — YON SoT, .db cache. recordAudit appends to
    // <vault>/.lyt/ledgers/audit.yon first (fatal-on-fail), then upserts
    // the audit_log row (log-on-fail).
    await recordAudit(vault.path, db, {
      id,
      ts,
      actor,
      action,
      targetType: "vault",
      targetId: vault.ridHex,
      result: "success",
      details: { description: args.description, category, friction_result: "noted" },
      stampSrc: "flows/friction.note",
    });
  } finally {
    await closeVaultDb(db);
  }

  return {
    vaultName: vault.name,
    idHex: uuid7BytesToHex(id),
    action,
    category,
    actor,
    ts,
  };
}

// Counts distinct unresolved sync.friction.* rows in the window across one
// vault (--vault) or every registered non-tombstoned vault. Tier A threshold
// per arc §10.1 (provisional).
export async function frictionReportFlow(
  args: FrictionReportArgs = {},
): Promise<FrictionReportResult> {
  const windowMs = args.windowMs ?? FRICTION_REPORT_DEFAULT_WINDOW_MS;
  const nowMs = args.nowMs ?? Date.now();
  const windowStartMs = nowMs - windowMs;
  const vaults = await resolveVaults(args.vault);

  const byCategory: Record<string, number> = {};
  const rows: FrictionRowSummary[] = [];

  for (const v of vaults) {
    if (!existsSync(v.path)) continue;
    const db = await openAuditDb(v.path);
    try {
      const r = await db.execute({
        sql:
          "SELECT id, ts, actor, action, details_json FROM audit_log" +
          " WHERE action LIKE 'sync.friction.%'" +
          " AND ts >= ? AND ts <= ?" +
          " ORDER BY ts ASC",
        args: [windowStartMs, nowMs],
      });
      for (const row of r.rows) {
        const action = String(row["action"]);
        const detailsRaw = row["details_json"] == null ? null : String(row["details_json"]);
        let details: Record<string, unknown> = {};
        if (detailsRaw) {
          try {
            details = JSON.parse(detailsRaw) as Record<string, unknown>;
          } catch {
            // ignore — treat as no details
          }
        }
        const resolved = details["resolved"] === true;
        const falsePositive = details["false_positive"] === true;
        // `fix.shipped` rows are internal byproducts of resolve(); they aren't
        // unresolved-incident candidates themselves.
        if (action === AUDIT_ACTIONS.SYNC_FRICTION_FIX_SHIPPED) continue;
        if (resolved) continue;
        if (args.excludeFalsePositive && falsePositive) continue;
        const category = action.slice("sync.friction.".length);
        byCategory[category] = (byCategory[category] ?? 0) + 1;
        rows.push({
          idHex: uuid7BytesToHex(row["id"] as Uint8Array | ArrayBuffer),
          ts: Number(row["ts"]),
          category,
          actor: String(row["actor"]),
          description:
            typeof details["description"] === "string" ? (details["description"] as string) : "",
          resolved,
          falsePositive,
        });
      }
    } finally {
      await closeVaultDb(db);
    }
  }

  const totalUnresolved = rows.length;
  return {
    windowMs,
    windowStartMs,
    windowEndMs: nowMs,
    vaultsScanned: vaults.map((v) => v.name),
    byCategory,
    totalUnresolved,
    tierATriggered: totalUnresolved >= FRICTION_TIER_A_THRESHOLD,
    rows,
  };
}

// JS-side JSON merge (plan Open Q3 lock): SQLite json_patch() isn't in every
// libSQL build; reading + merging + writing back is portable and survives
// the in-process driver shape constraints.
export async function frictionResolveFlow(args: FrictionMutateArgs): Promise<FrictionMutateResult> {
  const vault = await resolveSingleVault(args.vault);
  const ts = args.nowMs ?? Date.now();
  const idBytes = hexToUuid7Bytes(args.idHex);

  const db = await openAuditDb(vault.path);
  let shippedFixIdHex: string | undefined;
  try {
    const existing = await fetchAuditRow(db, idBytes);
    if (!existing)
      throw new Error(`No audit_log row with id ${args.idHex} in vault '${vault.name}'.`);
    if (!existing.action.startsWith("sync.friction.")) {
      throw new Error(
        `Row ${args.idHex} has action '${existing.action}' — only sync.friction.* rows can be resolved.`,
      );
    }
    // release review: idempotency pre-check. Resolving twice would emit a
    // duplicate `sync.friction.fix.shipped` companion row + silently overwrite
    // resolved_at / resolution_note. Refuse with a guided error instead.
    if (existing.details["resolved"] === true) {
      const resolvedAt = describeTimestamp(existing.details["resolved_at"]);
      const priorNote =
        typeof existing.details["resolution_note"] === "string"
          ? ` (note: ${JSON.stringify(existing.details["resolution_note"])})`
          : "";
      throw new Error(
        `friction ${args.idHex} already resolved at ${resolvedAt}${priorNote}. ` +
          `Use \`lyt friction false-positive ${args.idHex}\` if you meant to flag it as a false positive instead.`,
      );
    }
    if (existing.details["false_positive"] === true) {
      const falseAt = describeTimestamp(existing.details["false_positive_at"]);
      throw new Error(
        `friction ${args.idHex} already flagged false-positive at ${falseAt}. ` +
          `A row cannot be both false-positive and resolved; clear the flag manually if this is incorrect.`,
      );
    }
    const details = mergeDetails(existing.details, {
      resolved: true,
      resolved_at: ts,
      ...(args.note ? { resolution_note: args.note } : {}),
    });
    await db.execute({
      sql: "UPDATE audit_log SET details_json = ? WHERE id = ?",
      args: [JSON.stringify(details), idBytes],
    });

    // Emit the bookkeeping `sync.friction.fix.shipped` companion row via
    // recordAudit so it lands in audit.yon SoT (v1.A.2 Lock 0.2).
    const shippedId = newUuidv7Bytes();
    await recordAudit(vault.path, db, {
      id: shippedId,
      ts,
      actor: getIdentity(),
      action: AUDIT_ACTIONS.SYNC_FRICTION_FIX_SHIPPED,
      targetType: "audit_log",
      targetId: args.idHex,
      result: "success",
      details: { resolved_audit_id: args.idHex, note: args.note ?? null },
      stampSrc: "flows/friction.resolve",
    });
    shippedFixIdHex = uuid7BytesToHex(shippedId);
  } finally {
    await closeVaultDb(db);
  }

  return {
    vaultName: vault.name,
    idHex: args.idHex,
    ...(shippedFixIdHex !== undefined ? { shippedFixIdHex } : {}),
  };
}

export async function frictionFalsePositiveFlow(
  args: FrictionMutateArgs,
): Promise<FrictionMutateResult> {
  if (!args.note || args.note.trim().length === 0) {
    throw new Error("`lyt friction false-positive` requires --note <text> explaining the call.");
  }
  const vault = await resolveSingleVault(args.vault);
  const ts = args.nowMs ?? Date.now();
  const idBytes = hexToUuid7Bytes(args.idHex);

  const db = await openAuditDb(vault.path);
  try {
    const existing = await fetchAuditRow(db, idBytes);
    if (!existing)
      throw new Error(`No audit_log row with id ${args.idHex} in vault '${vault.name}'.`);
    if (!existing.action.startsWith("sync.friction.")) {
      throw new Error(
        `Row ${args.idHex} has action '${existing.action}' — only sync.friction.* rows can be flagged false-positive.`,
      );
    }
    // release review: idempotency pre-check. Re-flagging silently overwrites
    // false_positive_at / false_positive_note; a row already resolved would lose
    // its resolution metadata mid-merge. Refuse with a guided error.
    if (existing.details["false_positive"] === true) {
      const falseAt = describeTimestamp(existing.details["false_positive_at"]);
      const priorNote =
        typeof existing.details["false_positive_note"] === "string"
          ? ` (note: ${JSON.stringify(existing.details["false_positive_note"])})`
          : "";
      throw new Error(
        `friction ${args.idHex} already flagged false-positive at ${falseAt}${priorNote}. ` +
          `No further action needed.`,
      );
    }
    if (existing.details["resolved"] === true) {
      const resolvedAt = describeTimestamp(existing.details["resolved_at"]);
      throw new Error(
        `friction ${args.idHex} already resolved at ${resolvedAt}. ` +
          `A row cannot be both resolved and false-positive; use \`lyt friction resolve\` semantics if this needs amending.`,
      );
    }
    const details = mergeDetails(existing.details, {
      false_positive: true,
      false_positive_at: ts,
      false_positive_note: args.note,
    });
    await db.execute({
      sql: "UPDATE audit_log SET details_json = ? WHERE id = ?",
      args: [JSON.stringify(details), idBytes],
    });
  } finally {
    await closeVaultDb(db);
  }

  return { vaultName: vault.name, idHex: args.idHex };
}

interface AuditRowSnapshot {
  action: string;
  details: Record<string, unknown>;
}

async function fetchAuditRow(
  db: Awaited<ReturnType<typeof openAuditDb>>,
  idBytes: Uint8Array,
): Promise<AuditRowSnapshot | null> {
  const r = await db.execute({
    sql: "SELECT action, details_json FROM audit_log WHERE id = ?",
    args: [idBytes],
  });
  if (r.rows.length === 0) return null;
  const action = String(r.rows[0]!["action"]);
  const raw = r.rows[0]!["details_json"] == null ? null : String(r.rows[0]!["details_json"]);
  let details: Record<string, unknown> = {};
  if (raw) {
    try {
      // A.4.5 polish #2: JSON.parse('null') returns null (no throw); the
      // earlier cast `as Record<string, unknown>` didn't narrow null away,
      // so a downstream `existing.details["resolved"]` would TypeError on a
      // row whose details_json column held the literal string 'null'.
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        details = parsed as Record<string, unknown>;
      }
    } catch {
      details = {};
    }
  }
  return { action, details };
}

function mergeDetails(
  existing: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  return { ...existing, ...overlay };
}

function describeTimestamp(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "<unknown>";
  // A.4.5 polish #3: JS Date valid range is ±8.64e15 ms; outside that,
  // `new Date(v).toISOString()` throws RangeError. A friction row with a
  // pathological details_json containing `resolved_at: 1e18` would surface
  // a stack trace instead of the guided error message we built in a review finding.
  if (Math.abs(value) > 8.64e15) return "<unknown>";
  return new Date(value).toISOString();
}
