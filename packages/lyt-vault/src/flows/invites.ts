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
import { GhAccessProvider } from "../access/gh-access-provider.js";
import type { AccessProvider, Invitation } from "../access/access-provider.js";
import type { GhExecutor } from "../util/gh-discover.js";

// keystone Phase C — the `lyt vault invites` verb. Lists the caller's
// pending GitHub repository invitations (read-only) and optionally ACCEPTS one
// (a mutation). gh-as-sole-SoT: the invitations come straight off
// `/user/repository_invitations` — NO local mirror, NO new table.
//
// The accept path is confirmed-gated EXACTLY like shareVaultFlow: an accept the
// handler did not explicitly confirm is refused. The CLI wires `confirmed` from
// `--yes`. Listing (no `--accept`) is READ-ONLY — no gate.

export interface VaultInvitesArgs {
  // The gh invitation id to accept. When omitted/undefined → list-only (no
  // mutation, no gate).
  accept?: number;
  // Explicit handler confirmation for the accept mutation (CLI `--yes`).
  confirmed: boolean;
}

export interface VaultInvitesFlowOpts {
  // Injectable registry handle — defaults to a freshly opened (and closed) one.
  // The invites flow itself needs no registry, but we mirror the other flows so
  // the GhAccessProvider has a db handle and the injection seam is uniform.
  db?: Client;
  // Injectable AccessProvider — tests inject a fake recording accept calls.
  accessProvider?: AccessProvider;
  // Injectable gh executor used only when `accessProvider` is NOT supplied.
  gh?: GhExecutor;
}

export interface VaultInvitesListResult {
  action: "listed";
  invitations: Invitation[];
}

export interface VaultInvitesAcceptResult {
  action: "accepted";
  id: number;
}

export type VaultInvitesResult = VaultInvitesListResult | VaultInvitesAcceptResult;

// List the caller's pending GitHub repository invitations, or accept one when
// `accept` is set. Accept refuses without explicit confirmation (the HIL gate).
export async function vaultInvitesFlow(
  args: VaultInvitesArgs,
  opts: VaultInvitesFlowOpts = {},
): Promise<VaultInvitesResult> {
  // Accept path is a MUTATION — refuse without explicit confirmation, mirroring
  // shareVaultFlow's refusal. Gate FIRST, before opening any registry or
  // touching gh, so an unconfirmed accept never reaches a side effect.
  if (args.accept !== undefined) {
    if (!args.confirmed) {
      throw new Error(
        `Refusing to accept invitation '${args.accept}' without explicit confirmation. ` +
          `CLI: pass --yes. Agent/MCP: this mutation is handler-gated; confirmation is ` +
          `required and MCP dispatch is now gated (default-deny unless the server was ` +
          `launched with out-of-band handler approval). This flow-layer refusal is ` +
          `retained as defense-in-depth beneath that gate.`,
      );
    }
  }

  const { db, owns } = await resolveDb(opts.db);
  try {
    const provider = resolveProvider(db, opts);

    if (args.accept !== undefined) {
      await provider.acceptInvitation(args.accept);
      return { action: "accepted", id: args.accept };
    }

    const invitations = await provider.listInvitations();
    return { action: "listed", invitations };
  } finally {
    if (owns) await closeRegistry(db);
  }
}

async function resolveDb(injected?: Client): Promise<{ db: Client; owns: boolean }> {
  if (injected !== undefined) return { db: injected, owns: false };
  return { db: await openRegistry(), owns: true };
}

function resolveProvider(db: Client, opts: VaultInvitesFlowOpts): AccessProvider {
  if (opts.accessProvider !== undefined) return opts.accessProvider;
  return new GhAccessProvider(db, opts.gh !== undefined ? { gh: opts.gh } : {});
}
