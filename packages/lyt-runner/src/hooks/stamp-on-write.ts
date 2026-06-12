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

// Pre-write @STAMP hook — auto-injects provenance + audit_log entries
// whenever an automator writes to a vault filesystem path.
//
// Per arc-thoughts §11.4 (LOCKED 2026-05-27), every automator-driven write
// follows the 6-step contract:
// 1. Compute content hash (sha256) of what's about to be written
// 2. Build the provenance entry (src + method + confidence + hash +
// tokens + cost + model)
// 3. Markdown writes → update `last_provenance:` frontmatter scalar
// YON declaration writes → prepend an inline `@STAMP` record
// 4. Write the file
// 5. INSERT the provenance row into the per-vault libSQL `provenance` table
// 6. INSERT an `audit_log` row with `action='automator.write'`,
// `target_id = provenance.id` (hex)
//
// Per arc-thoughts §11.6 the hook fires ONLY under an active automator-run
// context — handler-written notes (e.g. /lyt-capture, manual edits) pass
// `runContext: null` and the hook then performs an inert fs write with no
// provenance recording. This is the "don't @STAMP every keystroke" guard.
//
// The hook DOES NOT monkey-patch fs. Automator bodies invoke the
// `writeMarkdownWithStamp` / `writeYonWithStamp` helpers explicitly; if a
// body calls `fs.writeFileSync` directly it bypasses the hook (and the
// brief tolerates that — the body is misbehaving and won't get
// provenance). This keeps the hook scoped + testable per arc §11.6.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, sep, posix } from "node:path";

import type { Client } from "@libsql/client";
import {
  appendLedgerRecord,
  closeVaultDb,
  incrementVaultWritesCount,
  insertAutomatorWriteAuditLog,
  newUuidv7Bytes,
  openLedgerDb,
  recordProvenance,
  type ProvenanceWriteTargetType,
} from "@younndai/lyt-vault";

import type { LytRunContext } from "../protocol/run-context.js";
import { upsertLastProvenance } from "./frontmatter.js";

// v1.A.2 Lock 0.2 — emit `@AUDIT` companion record to ledger
// when the hook fires under a vaultRoot-aware run. Mirror of
// `flows/friction.ts` shape. Direct ledger append (not via `recordAudit`)
// because we have no audit_log row to mirror — the audit row is emitted by
// `insertAutomatorWriteAuditLog` separately.
//
// v1.A.2c DB SPLIT: post-split, the `vaultDb` parameter is semantically the
// lyt.db client (carries automator_runs / automator_run_events for the
// incrementVaultWritesCount call). The hook opens audit.db + provenance.db
// internally per write call — this is the simplest signature-compatible
// migration but pays a Windows file-lock cost (~400ms × open/close pair)
// per fired stamp. Threading three clients through the hook signature is
// a v1.A.3 optimisation candidate (faster batch performance, larger
// signature change).
import { join as pathJoin } from "node:path";

export interface StampMeta {
  // Required: who wrote this. Conventionally `automator:<name>/v<ver>`,
  // matching the src field shape in arc-thoughts §11.4 + the
  // metadata-filler example at yai-domain L399.
  src: string;
  // Optional provenance carriers. method is the archetype-ish label
  // (filler, rollup, ingest, etc.); confidence is [0..1]; tokens/costUsd/
  // model populate from the LLM-call site if any.
  method?: string;
  confidence?: number;
  tokens?: number;
  costUsd?: number;
  model?: string;
  // Caller-supplied extra context that gets stashed in
  // provenance.details_json. Useful for "fields_changed=[topic,purpose]"
  // metadata or "input_note_hash" provenance breadcrumbs.
  details?: Record<string, unknown>;
}

export interface WriteWithStampArgs {
  // Absolute filesystem path to write. Must be inside the vault root for
  // the relative-path computation to be useful in provenance.target_id.
  path: string;
  // File content (TypeScript caller has already serialized to UTF-8).
  content: string;
  // Provenance metadata bundle.
  stamp: StampMeta;
  // Used to build provenance.target_id as a vault-relative path. When
  // omitted, target_id is the absolute path verbatim (functional but
  // less queryable cross-machine).
  vaultRoot?: string;
  // v1.A.3 (CR-4 / OPT-1) hook-perf optimisation: when caller already
  // holds open ledger clients (audit.db + provenance.db) — typically a
  // long-lived automator run — passing them via `ledgerClients` skips
  // the per-call openLedgerDb open/close pair (≈ 400ms × 2 on Windows
  // file-lock). All-or-nothing: pass BOTH or NEITHER. The caller owns
  // lifecycle of pre-opened clients — the hook does not close them.
  // When omitted, the hook opens + closes its own per-call pair (the
  // back-compat path).
  ledgerClients?: {
    auditDb: Client;
    provenanceDb: Client;
  };
}

export interface WriteWithStampResult {
  // The provenance row id (BLOB UUIDv7) written for this call. Null when
  // the hook was a no-op (no active run context).
  provenanceId: Uint8Array | null;
  // The sha256 hex of the content written.
  hash: string;
  // The ISO 8601 timestamp the stamp carries (matches provenance.ts).
  ts: string;
  // True if the hook fired and recorded provenance; false if it short-
  // circuited because runContext was null.
  fired: boolean;
}

// ---------------------------------------------------------------------------
// Markdown writer — upserts `last_provenance:` frontmatter scalar.
// ---------------------------------------------------------------------------

export async function writeMarkdownWithStamp(
  runContext: LytRunContext | null,
  vaultDb: Client | null,
  args: WriteWithStampArgs,
): Promise<WriteWithStampResult> {
  const hash = sha256(args.content);
  const tsMs = runContext?.startedAt ?? Date.now();
  const ts = new Date(tsMs).toISOString();

  // §11.6 guard — handler-written notes get an inert pass-through.
  if (runContext === null || vaultDb === null) {
    ensureParentDir(args.path);
    writeFileSync(args.path, args.content, "utf8");
    return { provenanceId: null, hash, ts, fired: false };
  }

  // Step 3a — upsert last_provenance: line into the frontmatter.
  const mutated = upsertLastProvenance(args.content, {
    src: args.stamp.src,
    ts,
    ...(args.stamp.method !== undefined ? { method: args.stamp.method } : {}),
    ...(args.stamp.confidence !== undefined ? { confidence: args.stamp.confidence } : {}),
    hash: `sha256:${hash}`,
  });

  // Step 4 — write the file.
  ensureParentDir(args.path);
  writeFileSync(args.path, mutated, "utf8");

  // Steps 5+6 — record provenance + audit via the split-DB primitive.
  const provenanceId = newUuidv7Bytes();
  const targetId = computeTargetId(args.path, args.vaultRoot);
  await emitProvenanceAndAudit({
    runContext,
    vaultDb,
    args,
    provenanceId,
    targetId,
    targetKind: "note",
    targetType: "note",
    hash,
    ts,
    tsMs,
  });

  return { provenanceId, hash, ts, fired: true };
}

// ---------------------------------------------------------------------------
// YON declaration writer — prepends an inline `@STAMP` record.
// ---------------------------------------------------------------------------

export async function writeYonWithStamp(
  runContext: LytRunContext | null,
  vaultDb: Client | null,
  args: WriteWithStampArgs,
): Promise<WriteWithStampResult> {
  const hash = sha256(args.content);
  const tsMs = runContext?.startedAt ?? Date.now();
  const ts = new Date(tsMs).toISOString();

  if (runContext === null || vaultDb === null) {
    ensureParentDir(args.path);
    writeFileSync(args.path, args.content, "utf8");
    return { provenanceId: null, hash, ts, fired: false };
  }

  // Step 3b — prepend an inline @STAMP record. Per arc §11.4 step 4 the
  // stamp goes BEFORE the new top-level tag. We treat the content payload
  // as the "new top-level tag" — emit @STAMP first, then the content.
  const stampLine = formatYonStampRecord({
    ts,
    src: args.stamp.src,
    ...(args.stamp.method !== undefined ? { method: args.stamp.method } : {}),
    ...(args.stamp.confidence !== undefined ? { confidence: args.stamp.confidence } : {}),
    hash: `sha256:${hash}`,
    ...(args.stamp.tokens !== undefined ? { tokens: args.stamp.tokens } : {}),
    ...(args.stamp.costUsd !== undefined ? { costUsd: args.stamp.costUsd } : {}),
    ...(args.stamp.model !== undefined ? { model: args.stamp.model } : {}),
  });
  const mutated = `${stampLine}\n\n${args.content}`;

  ensureParentDir(args.path);
  writeFileSync(args.path, mutated, "utf8");

  const provenanceId = newUuidv7Bytes();
  const targetId = computeTargetId(args.path, args.vaultRoot);
  await emitProvenanceAndAudit({
    runContext,
    vaultDb,
    args,
    provenanceId,
    targetId,
    targetKind: "declaration",
    targetType: "declaration",
    hash,
    ts,
    tsMs,
  });

  return { provenanceId, hash, ts, fired: true };
}

// ---------------------------------------------------------------------------
// Shared post-write emitter. v1.A.2c DB SPLIT: opens audit.db + provenance.db
// per call from `args.vaultRoot`, runs the YON-first / .db-second sequence,
// closes the per-ledger clients in reverse-acquire order. Throws if
// `vaultRoot` is missing — the no-vaultRoot back-compat shim was dropped
// per [[feedback_prerelease_clean_slate]] (clean-slate before v1 ships).
// ---------------------------------------------------------------------------

interface EmitProvenanceAndAuditArgs {
  runContext: LytRunContext;
  vaultDb: Client; // semantically the lyt.db client (carries automator_runs)
  args: WriteWithStampArgs;
  provenanceId: Uint8Array;
  targetId: string;
  targetKind: "note" | "declaration";
  targetType: ProvenanceWriteTargetType;
  hash: string;
  ts: string;
  tsMs: number;
}

async function emitProvenanceAndAudit(p: EmitProvenanceAndAuditArgs): Promise<void> {
  const {
    runContext,
    vaultDb,
    args,
    provenanceId,
    targetId,
    targetKind,
    targetType,
    hash,
    ts,
    tsMs,
  } = p;
  const vaultRoot = args.vaultRoot;
  if (vaultRoot === undefined || vaultRoot.length === 0) {
    throw new Error(
      "lyt-runner pre-write hook requires args.vaultRoot post-v1.A.2c DB SPLIT (no libSQL-only fallback).",
    );
  }

  const provenanceArgs = {
    id: provenanceId,
    targetType,
    targetId,
    ts: tsMs,
    src: args.stamp.src,
    ...(args.stamp.method !== undefined ? { method: args.stamp.method } : {}),
    ...(args.stamp.confidence !== undefined ? { confidence: args.stamp.confidence } : {}),
    hash: `sha256:${hash}`,
    ...(args.stamp.tokens !== undefined ? { tokens: args.stamp.tokens } : {}),
    ...(args.stamp.costUsd !== undefined ? { costUsd: args.stamp.costUsd } : {}),
    ...(args.stamp.model !== undefined ? { model: args.stamp.model } : {}),
    ...(args.stamp.details !== undefined ? { details: args.stamp.details } : {}),
  };

  // v1.A.3 (CR-3 / ALT5 + CR-4 / OPT-1): when the caller threaded open
  // ledger clients via args.ledgerClients, reuse them and skip the
  // per-call open/close pair (~400ms × 2 saved on Windows file-lock).
  // Otherwise fall back to opening + closing our own pair via the
  // registry-routed openLedgerDb factory. The provenance + audit
  // emission itself stays content-coupled (audit row carries
  // provenance id_hex as target_id) — only the DB lifecycle is
  // optimised.
  const threaded = args.ledgerClients;
  const provenanceDb =
    threaded !== undefined ? threaded.provenanceDb : await openLedgerDb(vaultRoot, "provenance");
  const auditDb =
    threaded !== undefined ? threaded.auditDb : await openLedgerDb(vaultRoot, "audit");
  try {
    // Provenance: YON-first (recordProvenance wrapper enforces Lock 0.2).
    await recordProvenance(vaultRoot, provenanceDb, {
      ...provenanceArgs,
      stampSrc: "lyt-runner/pre-write-hook",
    });

    // Audit: also YON-first per Lock 0.2 (v1.A.2d release review fold — the
    // previous order ran insertAutomatorWriteAuditLog BEFORE
    // appendLedgerRecord, which would orphan a row in audit.db if the YON
    // append failed; rebuild-index --ledger audit walks YON and would
    // never re-inject the orphan). YON failure is fatal; audit.db upsert
    // failure (next step) is logged + non-fatal — symmetric with
    // recordProvenance / recordAudit semantics.
    const provenanceIdHex = Buffer.from(provenanceId).toString("hex");
    appendLedgerRecord({
      ledgerPath: pathJoin(vaultRoot, ".lyt", "ledgers", "audit.yon"),
      ledgerName: "audit",
      recordType: "AUDIT",
      fields: [
        ["ts", ts],
        ["actor", args.stamp.src],
        ["action", "automator.write"],
        ["target_type", "provenance"],
        ["target_id", provenanceIdHex],
        ["result", "success"],
        [
          "details_json",
          JSON.stringify({
            target_path: targetId,
            target_kind: targetKind,
            run_id_hex: bytesToHex(runContext.runId),
          }),
        ],
      ],
      stampSrc: "lyt-runner/pre-write-hook",
      ts,
    });

    const auditId = newUuidv7Bytes();
    try {
      await insertAutomatorWriteAuditLog(auditDb, {
        id: auditId,
        ts: tsMs,
        actor: args.stamp.src,
        provenanceId,
        targetPath: targetId,
        details: { target_kind: targetKind, run_id_hex: bytesToHex(runContext.runId) },
      });
    } catch (err) {
      // .db cache write failed but YON SoT is already on disk; log + continue
      // per the recordAudit / recordProvenance contract. rebuild-index
      // --ledger audit reconstructs from audit.yon.
      // eslint-disable-next-line no-console
      console.warn(
        "lyt-runner pre-write hook: audit.db upsert failed (YON SoT preserved); recoverable via rebuild-index --ledger audit",
        err,
      );
    }

    // Bump the per-run vault_writes_count so automator_runs telemetry stays
    // accurate without the caller having to manage it. Uses the lyt.db
    // client the caller threaded through.
    await incrementVaultWritesCount(vaultDb, runContext.runId);
  } finally {
    // OPT-1: only close DBs we opened ourselves. When the caller threaded
    // pre-opened clients, they own the lifecycle.
    if (threaded === undefined) {
      await closeVaultDb(auditDb);
      await closeVaultDb(provenanceDb);
    }
  }
}

// ---------------------------------------------------------------------------
// Public formatters — exported so callers (tests, the e2e smoke, future
// rollup-aggregator) can build stamp lines for inspection without
// performing fs writes.
// ---------------------------------------------------------------------------

export interface YonStampRecordArgs {
  ts: string;
  src: string;
  method?: string;
  confidence?: number;
  hash?: string;
  tokens?: number;
  costUsd?: number;
  model?: string;
}

export function formatYonStampRecord(args: YonStampRecordArgs): string {
  // Mirrors yai-domain L399-402 + arc-thoughts §11.4 surface. ts is typed
  // (`ts:ts=...`) per YON spec L385; confidence is float; tokens is int.
  // Cost is float; model is a quoted string.
  const parts: string[] = [`@STAMP ts:ts=${args.ts}`, `src="${args.src}"`];
  if (args.method !== undefined) parts.push(`method=${args.method}`);
  if (args.confidence !== undefined) parts.push(`confidence:float=${args.confidence}`);
  if (args.hash !== undefined) parts.push(`hash="${args.hash}"`);
  if (args.tokens !== undefined) parts.push(`tokens:int=${args.tokens}`);
  if (args.costUsd !== undefined) parts.push(`cost:float=${args.costUsd}`);
  if (args.model !== undefined) parts.push(`model="${args.model}"`);
  return parts.join(" | ");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function ensureParentDir(absPath: string): void {
  const parent = dirname(absPath);
  if (parent.length === 0) return;
  mkdirSync(parent, { recursive: true });
}

function computeTargetId(absPath: string, vaultRoot: string | undefined): string {
  if (vaultRoot === undefined || vaultRoot.length === 0) return absPath;
  const rel = relative(vaultRoot, absPath);
  // Normalize to posix separators so the stored target_id is portable
  // across OSes — registered paths grep cleanly on Linux even when written
  // on Windows.
  return rel.split(sep).join(posix.sep);
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

// Re-export ProvenanceWriteTargetType for callers that want to type their own
// provenance writers (e.g. rollup-aggregator emitting target_type='rollup').
export type { ProvenanceWriteTargetType };
