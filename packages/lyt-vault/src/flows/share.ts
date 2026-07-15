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
import { getVaultByName, type VaultRow } from "../registry/repo.js";
import { GhAccessProvider } from "../access/gh-access-provider.js";
import type { AccessProvider, Caller } from "../access/access-provider.js";
import type { GhExecutor } from "../util/gh-discover.js";
import { isReservedFederationRepoName } from "../util/federation-paths.js";

// keystone Phase C C8 (partial) — the `vault share` + `vault unshare`
// access verbs. Per the gh-as-sole-SoT design these are THIN wrappers over the
// already-implemented `AccessProvider.grant`/`revoke` (the gh repo-collaborator
// seam). The gh collaborator grant IS the record — NO new table, migration, or
// local "share_with" store is created here.
//
// The verbs are agent-HIL-gated: every grant/revoke a handler did not
// explicitly confirm is refused (`confirmed: false` throws). The CLI wires
// `confirmed` from `--yes`. The MCP projection passes `confirmed: false` so MCP
// invocation FAILS CLOSED — `handlerGated: true` is declared on the OpRows but
// is NOT yet enforced by the MCP dispatch, so MCP refuses these mutations until
// real handler-approval enforcement lands (see Phase C).

export type ShareLevel = "read" | "write";

export interface ShareVaultArgs {
  vaultName: string;
  withHandle: string;
  level: ShareLevel;
  confirmed: boolean;
}

export interface UnshareVaultArgs {
  vaultName: string;
  withHandle: string;
  confirmed: boolean;
}

export interface ShareVaultFlowOpts {
  // Injectable registry handle — tests that already opened one can thread it.
  // Defaults to a freshly opened (and closed) registry, matching the other
  // flows.
  db?: Client;
  // Injectable AccessProvider — tests inject a fake recording grant/revoke.
  // Defaults to a GhAccessProvider built from `gh` (mirrors pattern-run.ts).
  accessProvider?: AccessProvider;
  // Injectable gh executor used only when `accessProvider` is NOT supplied.
  gh?: GhExecutor;
}

export interface ShareVaultResult {
  vault: string;
  grantee: Caller;
  level: ShareLevel;
  status: "shared";
}

export interface UnshareVaultResult {
  vault: string;
  grantee: Caller;
  status: "unshared";
}

const VALID_LEVELS: readonly ShareLevel[] = ["read", "write"];

// G3 (design §6.1) — the federation manifest repo (`lyt-pod` / `lyt-pod-map`) is
// UN-SHAREABLE: granting a collaborator on it would expose every push_target,
// vault rid, and the whole federation map. Refuse on BOTH the bare name argument
// (e.g. `lyt vault share lyt-pod`) AND the resolved row's repo/origin basename
// (the precise identity of the manifest repo), with an actionable error. Fires
// regardless of `--yes` — no confirmation can authorize sharing the pod map.
function assertNotFederationManifestRepo(requested: string, row?: VaultRow): void {
  // FIX C (A2-R2 G3-3) — key on the REPO identity, NOT the vault-NAME leaf. The old
  // `lastSegment` check matched the last `/`-segment of the requested vault NAME, so
  // a legit vault whose LEAF is `lyt-pod` (shared as `{mesh}/lyt-pod`, real repo
  // `lyt-vault-<mesh>--lyt-pod`) was wrongly refused. The manifest repo is identified
  // by (a) the requested string being literally a reserved repo name (a bare
  // `lyt-pod` typed as the vault ref), or (b) the RESOLVED row's origin basename
  // being one — the precise repo identity (federation-paths.ts:104-110). A qualified
  // `{mesh}/lyt-pod` is NOT reserved (it carries a slash) and its origin basename is
  // `lyt-vault-<mesh>--lyt-pod`, so a legit leaf `lyt-pod` now passes.
  const originBasename = row?.gitUrl
    ? (row.gitUrl.split(/[\\/]/).filter((s) => s.length > 0).pop() ?? "")
    : "";
  if (
    isReservedFederationRepoName(requested) ||
    (originBasename.length > 0 && isReservedFederationRepoName(originBasename))
  ) {
    throw new Error(
      `Refusing to share '${requested}': the federation manifest repo (lyt-pod / lyt-pod-map) ` +
        `is un-shareable — it exposes every push_target, vault rid, and your whole federation ` +
        `map. Share individual vaults instead.`,
    );
  }
}

// Grant `withHandle` `level` access on `vaultName`. Refuses without explicit
// confirmation (the agent-HIL gate). Resolves the vault to a row, constructs/
// accepts an AccessProvider, and delegates to its `grant` — the gh collaborator
// PUT is the record.
export async function shareVaultFlow(
  args: ShareVaultArgs,
  opts: ShareVaultFlowOpts = {},
): Promise<ShareVaultResult> {
  // G3 — the manifest repo is un-shareable (fires before the confirmation gate;
  // no --yes can authorize it). Cheap bare-name check up front; the resolved-row
  // origin check follows once the vault is looked up.
  assertNotFederationManifestRepo(args.vaultName);
  if (!args.confirmed) {
    throw new Error(
      `Refusing to share '${args.vaultName}' with '${args.withHandle}' without explicit ` +
        `confirmation. CLI: pass --yes. Agent/MCP: this mutation is handler-gated; ` +
        `confirmation is required and MCP dispatch is now gated (default-deny unless the ` +
        `server was launched with out-of-band handler approval). This flow-layer refusal ` +
        `is retained as defense-in-depth beneath that gate.`,
    );
  }
  if (!VALID_LEVELS.includes(args.level)) {
    throw new Error(
      `invalid --access value '${args.level}' — expected one of: ${VALID_LEVELS.join(", ")}.`,
    );
  }

  const grantee: Caller = `github:${args.withHandle}`;
  const { db, owns } = await resolveDb(opts.db);
  try {
    const row = await getVaultByName(db, args.vaultName);
    if (!row) {
      throw new Error(`No vault registered with name '${args.vaultName}'. Try 'lyt vault list'.`);
    }
    // G3 — belt-and-suspenders: refuse if the RESOLVED row is actually the
    // manifest repo (its origin basename is lyt-pod / lyt-pod-map), even when the
    // requested name did not literally spell it.
    assertNotFederationManifestRepo(args.vaultName, row);
    const provider = resolveProvider(db, opts);
    await provider.grant(row, grantee, args.level);
    return {
      vault: row.name,
      grantee,
      level: args.level,
      status: "shared",
    };
  } finally {
    if (owns) await closeRegistry(db);
  }
}

// Revoke `withHandle`'s access on `vaultName`. Refuses without explicit
// confirmation. Delegates to `AccessProvider.revoke` — the gh collaborator
// DELETE is the record.
export async function unshareVaultFlow(
  args: UnshareVaultArgs,
  opts: ShareVaultFlowOpts = {},
): Promise<UnshareVaultResult> {
  if (!args.confirmed) {
    throw new Error(
      `Refusing to unshare '${args.vaultName}' from '${args.withHandle}' without explicit ` +
        `confirmation. CLI: pass --yes. Agent/MCP: this mutation is handler-gated; ` +
        `confirmation is required and MCP dispatch is now gated (default-deny unless the ` +
        `server was launched with out-of-band handler approval). This flow-layer refusal ` +
        `is retained as defense-in-depth beneath that gate.`,
    );
  }

  const grantee: Caller = `github:${args.withHandle}`;
  const { db, owns } = await resolveDb(opts.db);
  try {
    const row = await getVaultByName(db, args.vaultName);
    if (!row) {
      throw new Error(`No vault registered with name '${args.vaultName}'. Try 'lyt vault list'.`);
    }
    const provider = resolveProvider(db, opts);
    await provider.revoke(row, grantee);
    return {
      vault: row.name,
      grantee,
      status: "unshared",
    };
  } finally {
    if (owns) await closeRegistry(db);
  }
}

async function resolveDb(injected?: Client): Promise<{ db: Client; owns: boolean }> {
  if (injected !== undefined) return { db: injected, owns: false };
  return { db: await openRegistry(), owns: true };
}

function resolveProvider(db: Client, opts: ShareVaultFlowOpts): AccessProvider {
  if (opts.accessProvider !== undefined) return opts.accessProvider;
  return new GhAccessProvider(db, opts.gh !== undefined ? { gh: opts.gh } : {});
}
