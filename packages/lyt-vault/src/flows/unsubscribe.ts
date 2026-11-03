/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { Client } from "@libsql/client";

import { listVaults } from "../registry/repo.js";
import { openRegistryReadOnly } from "../registry/read-only-client.js";
import { normalizeGithubPublicationCoordinate } from "../util/publication-coordinate.js";
import { foldSubscriptions, readAllSubscriptionRecords, observedMaxSubscriptionHlc } from "../yon/subscription-ledger-read.js";
import { appendSubscriptionTombstone } from "../yon/subscription-ledger-write.js";

/** Retract an explicitly identified orphan relationship, not its repository or files. */
export async function unsubscribeOrphanFlow(args: {
  coordinate: string;
  rid: string;
  confirmed: boolean;
  operationId?: string;
  writerId?: string;
}): Promise<{ coordinate: string; rid: string; status: "retracted" | "already-retracted" }> {
  if (!args.confirmed) throw new Error("unsubscribe requires explicit confirmation (--yes).");
  const target = normalizeGithubPublicationCoordinate(args.coordinate);
  const rid = args.rid.replace(/-/g, "").toLowerCase();
  if (target === null || !/^[0-9a-f]{32}$/.test(rid)) {
    throw new Error("unsubscribe requires a valid GitHub vault coordinate and exact vault RID.");
  }
  const registry = openRegistryReadOnly();
  if (registry.kind !== "open") throw new Error("unsubscribe requires an existing readable registry.");
  try {
    const vaults = await listVaults(registry.client as unknown as Client);
    if (vaults.some((v) => v.ridHex.toLowerCase() === rid ||
      normalizeGithubPublicationCoordinate(v.gitUrl)?.coordinate === target.coordinate)) {
      throw new Error("unsubscribe refuses a registered vault; use its supported lifecycle operation.");
    }
  } finally { registry.close(); }

  const records = readAllSubscriptionRecords();
  const matching = records.filter((r) => normalizeGithubPublicationCoordinate(r.coordinate)?.coordinate === target.coordinate);
  if (matching.some((r) => r.hlcMalformed === true)) {
    throw new Error("unsubscribe refuses malformed subscription history.");
  }
  const live = foldSubscriptions(records).find((r) => r.coordinate === target.coordinate);
  if (live === undefined) {
    if (args.operationId !== undefined && args.writerId !== undefined && matching.some((r) => r.state === "tombstoned" && r.operationId === args.operationId && r.writerId === args.writerId && r.rid.replace(/-/g, "").toLowerCase() === rid)) {
      return { coordinate: target.coordinate, rid, status: "retracted" };
    }
    if (matching.some((r) => r.state === "tombstoned" && r.rid.replace(/-/g, "").toLowerCase() === rid)) {
      return { coordinate: target.coordinate, rid, status: "already-retracted" };
    }
    throw new Error("unsubscribe: no matching live subscription.");
  }
  if (live.rid.replace(/-/g, "").toLowerCase() !== rid ||
      (live.entryMode !== "subscribe" && live.entryMode !== "shared")) {
    throw new Error("unsubscribe: subscription identity or entry mode differs; no change made.");
  }
  appendSubscriptionTombstone({ coordinate: target.coordinate, rid, entryMode: live.entryMode,
    observedMaxHlc: observedMaxSubscriptionHlc(), ...(args.operationId === undefined ? {} : { operationId: args.operationId }), ...(args.writerId === undefined ? {} : { writerId: args.writerId }) });
  const after = readAllSubscriptionRecords();
  if (foldSubscriptions(after).some((r) => r.coordinate === target.coordinate) ||
      (args.operationId !== undefined && !after.some((r) => r.operationId === args.operationId && r.writerId === args.writerId && r.state === "tombstoned" && r.coordinate === target.coordinate && r.rid.replace(/-/g, "").toLowerCase() === rid))) {
    throw new Error("unsubscribe: tombstone appended but retraction could not be verified; inspect ledger before retrying.");
  }
  return { coordinate: target.coordinate, rid, status: "retracted" };
}
