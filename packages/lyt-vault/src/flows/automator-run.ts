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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { closeRegistry, openRegistry } from "../registry/client.js";
import {
  closeVaultDb,
  openAuditDb,
  openLytDbActionable,
  openProvenanceDb,
} from "../registry/vault-db.js";
import { insertAutomatorRunEvent } from "../registry/vault-db-repo.js";
import { enforceNotFrozen } from "../util/freeze-check.js";
import { newUuidv7Bytes, hexToUuid7Bytes } from "../util/uuid7.js";
import { resolveSingleVault } from "../util/vault-resolve.js";
import type { VaultRow } from "../registry/repo.js";
import type { Client } from "@libsql/client";

// block-B Commit 6 — automator-run flow.
//
// The flow itself does NOT import @younndai/lyt-runner (lyt-runner depends
// on lyt-vault — adding the reverse dep would be a cycle). Instead it
// produces an `AutomatorRunPlan` that the meta `@younndai/lyt` CLI consumes
// alongside lyt-runner's `runFiveStep`. Same composition pattern as v1.B.1
// mesh dispatch (where lyt-vault registers the `mesh` parent and the meta
// CLI attaches lyt-mesh-provided subcommands).
//
// Source: brief @TASK.9 + @CONTINUATION §5 (parallel-compatibility with
// v1.B.1 mesh dispatch) + register-verbs.ts L17-20 (single-registration-site
// invariant) + master plan §3 Block-B parallel posture.

export interface AutomatorRunPlan {
  vaultName: string;
  vaultPath: string;
  vaultRid: Uint8Array;
  automatorName: string;
  automatorRid: Uint8Array;
  automatorYonPath: string;
  // Already-opened libSQL clients. The meta CLI MUST close all four via
  // closeAutomatorRunPlan() once runFiveStep returns — the run flow opens
  // them so consumers don't thread openLytDb / openRegistry / openAuditDb /
  // openProvenanceDb themselves. v1.A.2c DB SPLIT: `vaultDb` is semantically
  // the lyt.db client (carries `automator_runs` + `automator_run_events`).
  // v1.A.5 OPT-1 caller-side: `auditDb` + `provenanceDb` are now opened here
  // too and threaded through `WriteWithStampArgs.ledgerClients` so the
  // pre-write @STAMP hook skips its per-write open/close pair (~400ms × 2
  // saved on Windows file-lock per fired stamp).
  registryDb: Client;
  vaultDb: Client;
  auditDb: Client;
  provenanceDb: Client;
  // Internal flag — when registryDb was caller-supplied via
  // AutomatorRunPlanArgs.registryDb, closeAutomatorRunPlan must NOT close it
  // (lifecycle owned by the caller). Read-only after buildAutomatorRunPlan.
  readonly _registryDbCallerSupplied: boolean;
}

export interface AutomatorRunPlanArgs {
  // The automator name (e.g. "metadata-filler") OR its full rid (e.g.
  // "automator:metadata-filler"). The flow strips the `automator:` prefix
  // when resolving the .yon file.
  automator: string;
  vault?: string;
  vaultPathOverride?: string;
  // v1.A.5 CR-B1 open-once seam: when the caller already holds an open
  // registry client (e.g. a long-running CLI session sharing one connection
  // across multiple automator dispatches), pass it here to skip the inline
  // openRegistry() open/close pair. The caller owns lifecycle — closeAutomatorRunPlan
  // skips closing this client. When omitted, the flow opens + closes its own
  // registry client (the back-compat path).
  registryDb?: Client;
}

export async function buildAutomatorRunPlan(args: AutomatorRunPlanArgs): Promise<AutomatorRunPlan> {
  let vault: VaultRow | null = null;
  let vaultPath: string;
  let vaultName: string;
  let vaultRid: Uint8Array;
  if (args.vaultPathOverride !== undefined) {
    vaultPath = args.vaultPathOverride;
    vaultName = args.vault ?? "(override)";
    // For override paths used by tests, surface a placeholder vault rid —
    // the test harness can substitute via direct insertAutomatorRun calls
    // if it needs a real rid for assertion symmetry.
    vaultRid = newUuidv7Bytes();
  } else {
    vault = await resolveSingleVault(args.vault);
    vaultName = vault.name;
    vaultPath = vault.path;
    vaultRid = vault.rid;
  }

  // hardening pass (fix-pass): the five-step runner mutates the vault (frontmatter
  // edits + a local commit) — F13 chokepoint before any db opens.
  // SURFACE CONTRACT (release review correction): plan-phase refusals
  // (frozen here, corrupt-db at the open below, automator-not-found) THROW —
  // runAutomator's containment covers only the five-step body, so the CLI
  // surfaces these as `lyt: <message>` with exit 1, NOT as the ok:false JSON
  // envelope. The thrown messages are the actionable surface.
  await enforceNotFrozen(vaultPath, vaultName);

  // Resolve `<name>` OR `automator:<name>`.
  const automatorName = args.automator.startsWith("automator:")
    ? args.automator.slice("automator:".length)
    : args.automator;
  const fileName = `${automatorName}.yon`;
  const automatorYonPath = join(vaultPath, ".lyt", "automators", fileName);
  if (!existsSync(automatorYonPath)) {
    throw new Error(
      `No automator '${automatorName}' found in vault '${vaultName}' (expected: ${automatorYonPath}).`,
    );
  }

  // Resolve the automator rid: pluck the @AUTOMATOR rid= field from the
  // .yon file. This is the same minimal hand-rolled extractor as
  // automator-list.ts but trimmed to just the rid lookup; we don't pull
  // in the full parser to keep this flow cycle-free.
  const raw = readFileSync(automatorYonPath, "utf8");
  const ridMatch = raw.match(/@AUTOMATOR[^@]*?rid=([^|\s]+)/);
  const automatorRid =
    ridMatch !== null && /^[a-f0-9-]{32,}$/i.test(ridMatch[1]!.replace(/^automator:/, ""))
      ? hexToUuid7Bytes(ridMatch[1]!.replace(/^automator:/, "").replace(/-/g, ""))
      : newUuidv7Bytes();
  // Most v1 automators (metadata-filler, rollup-aggregator) declare a
  // symbolic rid (`automator:metadata-filler`) rather than a UUIDv7 hex —
  // in that case we synthesise a v7 byte rid for the run. Symbolic
  // automator rids will get reconciled when v1.A.3 yai.lyt schema gate
  // mandates UUIDv7 rids on declaration.

  const registryDbCallerSupplied = args.registryDb !== undefined;
  const registryDb = args.registryDb ?? (await openRegistry());
  // corrupt lyt.db → CorruptLytDbError naming the reindex remedy.
  // Thrown from the plan phase (see the surface-contract note above): the
  // CLI prints the actionable message and exits 1.
  const vaultDb = await openLytDbActionable(vaultPath, vaultName);
  const auditDb = await openAuditDb(vaultPath);
  const provenanceDb = await openProvenanceDb(vaultPath);

  return {
    vaultName,
    vaultPath,
    vaultRid,
    automatorName,
    automatorRid,
    automatorYonPath,
    registryDb,
    vaultDb,
    auditDb,
    provenanceDb,
    _registryDbCallerSupplied: registryDbCallerSupplied,
  };
}

export async function closeAutomatorRunPlan(plan: AutomatorRunPlan): Promise<void> {
  // Close the per-vault DBs first to release Windows file locks before the
  // registry close path. Mirrors the leases-repo + scaffold ordering.
  // v1.A.5 OPT-1 caller-side: audit.db + provenance.db close here (caller
  // doesn't manage them — the plan owns their lifecycle).
  await closeVaultDb(plan.provenanceDb);
  await closeVaultDb(plan.auditDb);
  await closeVaultDb(plan.vaultDb);
  // v1.A.5 CR-B1: skip closing registryDb when caller-supplied (caller owns
  // lifecycle of pre-opened clients).
  if (!plan._registryDbCallerSupplied) {
    await closeRegistry(plan.registryDb);
  }
}

// Convenience writer for the meta CLI: emits a `cli.invoked` event into
// automator_run_events so `lyt automator log` can surface the invocation
// boundary alongside the protocol's per-step events. Optional — the meta
// CLI calls this BEFORE handing the plan + runId to runFiveStep so the
// event reflects "started from CLI" rather than "started in protocol".
//
// v1.A.5 CR-B13: payload now carries `automator_version` alongside
// `automator_name` so downstream observers (lyt automator log, audit
// review) can pin the exact bundled body version that ran. Caller-supplied
// (extracted from the .yon file by the meta CLI's extractAutomatorVersion).
export async function recordCliInvocation(
  plan: AutomatorRunPlan,
  args: {
    runId: Uint8Array;
    ts: number;
    dryRun: boolean;
    noPush: boolean;
    automatorVersion?: string;
  },
): Promise<void> {
  await insertAutomatorRunEvent(plan.vaultDb, {
    id: newUuidv7Bytes(),
    runId: args.runId,
    ts: args.ts,
    level: "info",
    message: "cli.invoked",
    data: {
      dry_run: args.dryRun,
      no_push: args.noPush,
      automator_name: plan.automatorName,
      ...(args.automatorVersion !== undefined ? { automator_version: args.automatorVersion } : {}),
    },
  });
}
