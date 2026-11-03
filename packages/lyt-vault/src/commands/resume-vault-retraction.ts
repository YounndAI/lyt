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

import { Command } from "commander";
import type { Client } from "@libsql/client";
import { listVaults } from "../registry/repo.js";
import { openRegistryReadOnly } from "../registry/read-only-client.js";
import { foldFedVaultWinners, readAllFedVaultRecords } from "../yon/federation-vault-ledger-read.js";
import { liveSubscriptions } from "../yon/subscription-ledger-read.js";
import { liveAliasNamesForTargetRid } from "../flows/alias.js";
import { refreshScopedVaultProjection } from "../flows/scoped-vault-projection.js";

export function buildResumeVaultRetractionCommand(): Command {
  return new Command("resume-vault-retraction")
    .description("Resume only a pending, RID-scoped pod projection update. Does not remove files or publish.")
    .requiredOption("--rid <rid>", "Previously retracted vault RID")
    .option("--yes", "Confirm updating the pod projection")
    .option("--json", "Emit JSON")
    .action(async (opts: { rid: string; yes?: boolean; json?: boolean }) => {
      try {
        if (opts.yes !== true) throw new Error("resume requires --yes.");
        const rid = opts.rid.replace(/-/g, "").toLowerCase();
        if (!/^[0-9a-f]{32}$/.test(rid)) throw new Error("invalid vault RID.");
        const winners = [...foldFedVaultWinners(readAllFedVaultRecords()).values()]
          .filter((r) => r.vaultRid.replace(/-/g, "").toLowerCase() === rid);
        if (winners.length !== 1 || winners[0]?.state !== "tombstoned") throw new Error("the vault ledger has no unique verified tombstone winner.");
        if (liveSubscriptions().some((s) => s.rid.replace(/-/g, "").toLowerCase() === rid) || liveAliasNamesForTargetRid(rid).length > 0) {
          throw new Error("live subscription or alias remains; resolve it before refreshing the projection.");
        }
        const opened = openRegistryReadOnly();
        if (opened.kind !== "open") throw new Error("registry is unavailable.");
        try {
          const db = opened.client as unknown as Client;
          const rows = await listVaults(db);
          if (rows.some((v) => v.ridHex.toLowerCase() === rid && v.status !== "tombstoned")) {
            throw new Error("the target is still active in the registry.");
          }
          const result = await refreshScopedVaultProjection(db, rid);
          if (result.pending) throw new Error(`projection remains pending: ${result.reason ?? "unverified"}`);
          console.log(opts.json ? JSON.stringify({ rid, status: "projection-refreshed", remoteVerified: false }) :
            `Projection refreshed for ${rid}; other cleanup and remote state are not verified.`);
        } finally { opened.close(); }
      } catch (error) {
        console.error(`lyt mesh resume-vault-retraction: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
}
