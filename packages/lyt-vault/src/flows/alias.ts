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
import { deleteAlias, listAliases, setAlias, type AliasRow } from "../registry/aliases-repo.js";
import { getVaultByRid } from "../registry/repo.js";
import { resolveVault, computeDisplayName } from "../registry/vault-addressing.js";

// 0.9.4 (F — pod-local aliases). `lyt alias <name> <target>` binds a
// handler-chosen name to a vault's rid (identity), so it survives rename + move.
// The target is resolved THROUGH the single addressing chokepoint (so the
// target can itself be a `{mesh}/{vault}`, a bare leaf, or another alias).
//
// Pod-local: aliases live in the local registry and sync across YOUR OWN pod's
// machines, never to subscribers (the publish surface filters them out — they
// are per-pod, individual).

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
function validateAliasName(alias: string): void {
  if (alias.length === 0) throw new AliasNameInvalidError(alias, "empty");
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

export async function removeAliasFlow(alias: string, registryDb?: Client): Promise<boolean> {
  const callerSupplied = registryDb !== undefined;
  const db = registryDb ?? (await openRegistry());
  try {
    return await deleteAlias(db, alias);
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}
