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

import { closeRegistry, openRegistry } from "../registry/client.js";
import {
  deleteAlias,
  getAliasTargetRid,
  listAliases,
  setAlias,
  type AliasRow,
} from "../registry/aliases-repo.js";
import { getVaultByRid } from "../registry/repo.js";
import { resolveVault, computeDisplayName } from "../registry/vault-addressing.js";
import { uuid7BytesToHex } from "../util/uuid7.js";
import { appendAliasActive, appendAliasTombstone } from "../yon/alias-ledger-write.js";
import { liveAliases, readAllAliasRecords } from "../yon/alias-ledger-read.js";
import { type Hlc, compareHlc } from "../util/hlc.js";

// 0.9.4 (F — pod-local aliases). `lyt alias <name> <target>` binds a
// handler-chosen name to a vault's rid (identity), so it survives rename + move.
// The target is resolved THROUGH the single addressing chokepoint (so the
// target can itself be a `{mesh}/{vault}`, a bare leaf, or another alias).
//
// Pod-local: aliases live in the local registry and sync across YOUR OWN pod's
// machines, never to subscribers (the publish surface filters them out — they
// are per-pod, individual).
//
// Fed-v2 Layer-1 (Phase E / E2a). The alias is CONVERGENT: the durable
// side-effect is an `@ALIAS` record appended to THIS writer's own append-only
// shard (`<podRoot>/ledger/aliases/<writerId>/`) via appendAliasActive /
// appendAliasTombstone — the alias analog of how `flows/subscribe.ts` writes a
// @SUBSCRIPTION record to its own shard. The `vault_aliases` libSQL table is a
// DERIVED cache reconstituted from the shard fold by rebuildFederationCacheFlow;
// like the subscription side, the write path does NOT write through to the cache
// synchronously — the cache is EXPECTED to go stale until the next
// reconstitution. A writer only ever appends to its OWN shard; never another's.
//
// Slice 1a — the alias fold is now a NAME-KEYED HLC-LWW REGISTER (was an OR-Set
// keyed on (name, target_rid)). Each append stamps a monotone HLC; the fold
// keeps the max-(hlc, writerId) record per name. Two consequences here:
//   - RE-POINT is just a newer active (the OLD tombstone-on-repoint loop is GONE
//     — a register supersedes the prior binding by hlc, no manual tombstone of
//     the old rid needed, and it works ACROSS writers, not just within one).
//   - REMOVE retracts cross-machine: a newer-hlc tombstone beats a FOREIGN
//     writer's active (the OR-Set could not express this).

// The HLC RECEIVE RULE input. Enumerate EVERY alias shard record (the same
// enumeration the fold uses) and return the max `hlc` observed across all of
// them — this writer's own AND every foreign writer's synced shard. Threading
// this into stampNext seeds the new stamp ABOVE everything observed, so a
// lagging-wall-clock machine that has already synced a higher remote hlc cannot
// stamp BELOW it and lose its causally-later write. Null when no hlc-bearing
// record exists yet (pure local-clock seed). Aliases are low-frequency, so the
// per-write shard read is acceptable. The flow computes it (keeping write.ts
// from importing read.ts).
function observedMaxAliasHlc(): Hlc | null {
  let max: Hlc | null = null;
  for (const rec of readAllAliasRecords()) {
    if (rec.hlc === null) continue;
    if (max === null || compareHlc(rec.hlc, max) > 0) max = rec.hlc;
  }
  return max;
}

export class AliasTargetNotFoundError extends Error {
  readonly errorCode = "alias-target-not-found";
  readonly target: string;
  constructor(target: string) {
    super(
      `lyt alias: target '${target}' does not resolve to a vault. ` +
        `Use 'lyt vault list' to see registered vaults.`,
    );
    this.name = "AliasTargetNotFoundError";
    this.target = target;
  }
}

export class AliasNameInvalidError extends Error {
  readonly errorCode = "alias-name-invalid";
  constructor(alias: string, reason: string) {
    super(`lyt alias: invalid alias name '${alias}' — ${reason}.`);
    this.name = "AliasNameInvalidError";
  }
}

// An alias name must not collide with the qualified-address grammar: no slash
// (would shadow `{mesh}/{vault}`), non-empty, no whitespace.
//
// federation-v2 Phase B: also reject a LEADING `@`. The `@` is the chat-surface
// alias SIGIL, stripped at the resolver boundary (vault-addressing.resolveVault
// step 0) before the table lookup — so aliases are stored RAW (sigil-free). If a
// raw `@x` were ever stored, the resolver would strip the sigil to `x` and never
// find `@x`, leaving it permanently unreachable. Reject it at the write boundary
// so the stored form always matches the resolver's stripped form.
function validateAliasName(alias: string): void {
  if (alias.length === 0) throw new AliasNameInvalidError(alias, "empty");
  if (alias.startsWith("@")) {
    throw new AliasNameInvalidError(
      alias,
      "must not start with '@' (the '@' sigil is stripped at resolve time; aliases are stored raw)",
    );
  }
  if (alias.includes("/")) {
    throw new AliasNameInvalidError(alias, "must not contain '/' (reserved for {mesh}/{vault})");
  }
  if (/\s/.test(alias)) throw new AliasNameInvalidError(alias, "must not contain whitespace");
}

export interface SetAliasResult {
  alias: string;
  vaultRidHex: string;
  targetDisplayName: string;
}

export async function setAliasFlow(
  alias: string,
  target: string,
  registryDb?: Client,
): Promise<SetAliasResult> {
  validateAliasName(alias);
  const callerSupplied = registryDb !== undefined;
  const db = registryDb ?? (await openRegistry());
  try {
    const vault = await resolveVault(db, target);
    if (vault === null) throw new AliasTargetNotFoundError(target);
    // RE-POINT (Slice 1a): the alias fold is now a name-keyed HLC-LWW REGISTER,
    // so re-pointing `name` from an old rid to a new one is JUST a newer active
    // — its higher hlc supersedes the prior binding in the fold (the register
    // keeps ≤1 live record per name). No tombstone-on-repoint loop is needed:
    // the OLD OR-Set keyed on (name, target_rid) and could leave both bindings
    // co-live, which is why E2a had to tombstone the old rid; the register key
    // (name alone) makes that obsolete, AND fixes the cross-writer case the old
    // loop could not (a remote writer's re-point now also supersedes by hlc).
    //
    // Durable convergent side-effect: append an `active` @ALIAS record to THIS
    // writer's own append-only shard (stamps a fresh monotone hlc). The shard
    // fold is the SoT reconstituted into `vault_aliases` by
    // rebuildFederationCacheFlow.
    appendAliasActive({
      name: alias,
      targetRid: vault.ridHex,
      kind: "vault",
      // RECEIVE RULE: seed the stamp above every hlc observed in synced shards.
      observedMaxHlc: observedMaxAliasHlc(),
    });
    // Cache write-through (DELIBERATE deviation from subscribe.ts — see note at
    // top of file): unlike the subscription cache, the `vault_aliases` cache is
    // read SYNCHRONOUSLY in-session by the resolver's `@`-sigil path
    // (vault-addressing.resolveVault → getAliasTargetRid), so a stale cache would
    // make a just-set alias unresolvable until the next reconstitution. Keep the
    // cache warm so `@alias` resolves immediately; reconstitution remains the SoT
    // and full-replaces this row idempotently from the shard fold.
    await setAlias(db, alias, vault.rid);
    const targetDisplayName = await computeDisplayName(db, vault);
    return { alias, vaultRidHex: vault.ridHex, targetDisplayName };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}

export interface ListAliasResult {
  aliases: Array<{ alias: string; vaultRidHex: string; targetDisplayName: string }>;
}

export async function listAliasesFlow(registryDb?: Client): Promise<ListAliasResult> {
  const callerSupplied = registryDb !== undefined;
  const db = registryDb ?? (await openRegistry());
  try {
    const rows: AliasRow[] = await listAliases(db);
    const out: ListAliasResult["aliases"] = [];
    for (const r of rows) {
      // Resolve the target by rid (identity) for an accurate display name.
      const byRid = await getVaultByRid(db, r.vaultRid);
      const targetDisplayName =
        byRid !== null ? await computeDisplayName(db, byRid) : "(dangling — target removed)";
      out.push({ alias: r.alias, vaultRidHex: r.vaultRidHex, targetDisplayName });
    }
    return { aliases: out };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}

// Phase E item 1 (#9 — warn-then-drop on vault delete/unsubscribe). Discover
// every LIVE pod-local alias whose target is `targetRidHex` (the vault about to
// be deleted/forgotten). Folds the alias ledger (the SoT) rather than the
// `vault_aliases` cache, mirroring removeAliasFlow's cache-miss fallback: a
// cross-machine alias can be LIVE in the converged ledger yet absent from THIS
// machine's not-yet-reconstituted cache, and we must still surface + drop it.
// Returns the affected alias NAMES, sorted (foldAliases already sorts by name).
export function liveAliasNamesForTargetRid(targetRidHex: string): string[] {
  const target = targetRidHex.toLowerCase();
  return liveAliases()
    .filter((a) => a.targetRid.toLowerCase() === target)
    .map((a) => a.name);
}

// Phase E item 1 — DROP every pod-local alias pointing at a vault that is being
// deleted/unsubscribed. Each drop is a `tombstoned` @ALIAS appended via the
// EXISTING removeAliasFlow / appendAliasTombstone path (follow-the-rid,
// HLC-stamped, this writer's own shard). Idempotent: removeAliasFlow no-ops when
// the name is already live nowhere, and re-running reconstitution keeps a
// tombstoned alias gone. Returns the names that WERE tombstoned by this call.
export async function dropAliasesForTargetRid(
  targetRidHex: string,
  registryDb?: Client,
): Promise<string[]> {
  const callerSupplied = registryDb !== undefined;
  const db = registryDb ?? (await openRegistry());
  try {
    const names = liveAliasNamesForTargetRid(targetRidHex);
    const dropped: string[] = [];
    for (const name of names) {
      // Reuse the canonical remove path — it tombstones via appendAliasTombstone
      // (HLC-stamped, own shard) AND drops the warm cache row. Returns true iff a
      // tombstone was appended; idempotent on a name already retracted.
      const tombstoned = await removeAliasFlow(name, db);
      if (tombstoned) dropped.push(name);
    }
    return dropped;
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}

export async function removeAliasFlow(alias: string, registryDb?: Client): Promise<boolean> {
  const callerSupplied = registryDb !== undefined;
  const db = registryDb ?? (await openRegistry());
  try {
    // Resolve the alias's CURRENT live target rid. Slice 1a: the register keys on
    // `name` ALONE, so the tombstone's target_rid is just the VALUE it carries —
    // not part of the merge key. A fresh-hlc tombstone retracts `name` iff its
    // (hlc, writerId) is the greatest across all shards; because stampNext is
    // monotone, this tombstone's hlc is newer than any prior active — INCLUDING a
    // FOREIGN writer's active (the cross-machine REMOVE the OR-Set could not do).
    //
    // The cache is the warm in-session read (kept warm by setAliasFlow's
    // write-through). But on THIS machine the cache may be empty / not yet
    // reconstituted for an alias that is nevertheless LIVE in the converged ledger
    // (cross-machine: a peer set it, the ledger synced, but rebuildFederationCache
    // has not yet run here). A cache-only lookup would then return false and
    // silently no-op — the alias stays live forever (release review Major).
    //
    // Fix: try the cache first (fast path); on a MISS, fall back to the LEDGER
    // fold (the SoT) and tombstone the live binding for `name` (the register
    // yields ≤1). Return true iff a tombstone was appended; false ONLY when
    // `name` is live nowhere — cache AND ledger.
    const cachedTargetRid = await getAliasTargetRid(db, alias);
    // RECEIVE RULE: seed the tombstone's stamp above every hlc observed in synced
    // shards, so a lagging-clock machine's remove still dominates a remote active
    // it has already synced (else the stale active would survive the fold).
    const observedMax = observedMaxAliasHlc();
    let tombstonedAny = false;
    if (cachedTargetRid !== null) {
      // Durable convergent side-effect: append a `tombstoned` @ALIAS record to
      // THIS writer's OWN shard. Its fresh monotone hlc makes the register fold
      // pick this tombstone as the winner for `name`, retracting it.
      appendAliasTombstone({
        name: alias,
        targetRid: uuid7BytesToHex(cachedTargetRid),
        kind: "vault",
        observedMaxHlc: observedMax,
      });
      tombstonedAny = true;
    } else {
      // Cache miss — fall back to the ledger fold (the SoT). Tombstone the live
      // binding for `name`. This lets a cross-machine alias — live in the
      // converged ledger but not reconstituted into THIS cache — still be removed.
      for (const live of liveAliases()) {
        if (live.name !== alias) continue;
        appendAliasTombstone({
          name: alias,
          targetRid: live.targetRid,
          kind: live.kind,
          observedMaxHlc: observedMax,
        });
        tombstonedAny = true;
      }
      if (!tombstonedAny) return false; // live nowhere — nothing to remove
    }
    // Cache write-through (same deviation rationale as setAliasFlow): drop the
    // cache row so the synchronous `@`-sigil resolver stops resolving the alias
    // in-session. Reconstitution remains the SoT and full-replaces from the fold.
    // (deleteAlias may report rowsAffected=0 on a cache-miss path — irrelevant; a
    // tombstone WAS appended, so the verb succeeded. Return tombstonedAny.)
    await deleteAlias(db, alias);
    return tombstonedAny;
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}
