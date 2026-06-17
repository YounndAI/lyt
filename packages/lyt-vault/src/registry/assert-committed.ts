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

import { getVaultByRid } from "./repo.js";
import { ridsEqual } from "../util/uuid7.js";

// 0.9.4 (3d / success-must-reflect-committed-state). After a mutation
// (move/rename/init) commits, re-read the authoritative row and ASSERT the
// expected post-state before printing success. This is a GUARD ON TOP of the
// existing transaction — the tx already makes the write atomic; this closes the
// "reported success without effect" class (the move-bug symptom) by verifying
// the committed bytes match what we claim.
//
// Verdict is `verified` when the read-back confirms the predicate, else
// `unverified`. Callers downgrade an unverified outcome to
// "(unverified — run `lyt vault list`)" rather than asserting a clean success.

export type CommitVerdict = "verified" | "unverified";

export interface AssertCommittedResult {
  verdict: CommitVerdict;
  // A human-facing suffix to append to the success line when unverified.
  unverifiedNote: string | null;
  // The specific predicate that failed (for logs / structured output).
  reason: string | null;
}

const UNVERIFIED_NOTE = "(unverified — run `lyt vault list`)";

// Assert a vault's home mesh is now the expected mesh (post-move / post-init).
export async function assertVaultHomeMesh(
  db: Client,
  vaultRid: Uint8Array,
  expectedMeshRid: Uint8Array,
): Promise<AssertCommittedResult> {
  const row = await getVaultByRid(db, vaultRid);
  if (row === null) {
    return { verdict: "unverified", unverifiedNote: UNVERIFIED_NOTE, reason: "vault-row-missing" };
  }
  if (row.homeMeshRid === null || !ridsEqual(row.homeMeshRid, expectedMeshRid)) {
    return {
      verdict: "unverified",
      unverifiedNote: UNVERIFIED_NOTE,
      reason: "home-mesh-not-committed",
    };
  }
  return { verdict: "verified", unverifiedNote: null, reason: null };
}

// Assert a vault's stored name is now the expected value (post-rename).
export async function assertVaultName(
  db: Client,
  vaultRid: Uint8Array,
  expectedName: string,
): Promise<AssertCommittedResult> {
  const row = await getVaultByRid(db, vaultRid);
  if (row === null) {
    return { verdict: "unverified", unverifiedNote: UNVERIFIED_NOTE, reason: "vault-row-missing" };
  }
  if (row.name !== expectedName) {
    return { verdict: "unverified", unverifiedNote: UNVERIFIED_NOTE, reason: "name-not-committed" };
  }
  return { verdict: "verified", unverifiedNote: null, reason: null };
}

// Assert a vault row exists by rid (post-init).
export async function assertVaultRegistered(
  db: Client,
  vaultRid: Uint8Array,
): Promise<AssertCommittedResult> {
  const row = await getVaultByRid(db, vaultRid);
  if (row === null) {
    return { verdict: "unverified", unverifiedNote: UNVERIFIED_NOTE, reason: "vault-row-missing" };
  }
  return { verdict: "verified", unverifiedNote: null, reason: null };
}
