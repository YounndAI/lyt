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

import { closeVaultDb, openLytDb } from "../registry/vault-db.js";
import {
  listAutomatorRunEvents,
  listAutomatorRuns,
  type AutomatorRunEventLevel,
} from "../registry/vault-db-repo.js";
import { resolveSingleVault } from "../util/vault-resolve.js";
import { uuid7BytesToHex } from "../util/uuid7.js";

// block-B Commit 6 — `lyt automator log <name> [--since <date>] [--level <l>] [--json]`.
//
// Reads automator_run_events filtered by automator_name (joined back to
// automator_runs.id). When --since is given, the filter applies to
// event.ts (the per-event timestamp), not the run's started_at — that
// way scrolling forward through long runs by absolute time still works.

export interface AutomatorLogEntry {
  runIdHex: string;
  automatorName: string;
  ts: number;
  level: AutomatorRunEventLevel;
  message: string;
  dataJson: string | null;
}

export interface AutomatorLogArgs {
  automator: string;
  vault?: string;
  // Inclusive lower bound in epoch ms. Callers transform CLI --since=<iso>
  // → ms before invoking.
  sinceMs?: number;
  level?: AutomatorRunEventLevel;
  limit?: number;
  vaultPathOverride?: string;
}

export interface AutomatorLogResult {
  vaultName: string;
  vaultPath: string;
  automator: string;
  events: AutomatorLogEntry[];
}

export async function automatorLogFlow(args: AutomatorLogArgs): Promise<AutomatorLogResult> {
  let vaultName: string;
  let vaultPath: string;
  if (args.vaultPathOverride !== undefined) {
    vaultPath = args.vaultPathOverride;
    vaultName = args.vault ?? "(override)";
  } else {
    const vault = await resolveSingleVault(args.vault);
    vaultName = vault.name;
    vaultPath = vault.path;
  }

  const limit = args.limit ?? 500;
  const events: AutomatorLogEntry[] = [];
  const vaultDb = await openLytDb(vaultPath);
  try {
    // Try both stored-name shapes — `metadata-filler` and
    // `automator:metadata-filler` — so callers can supply either form.
    const bareName = args.automator.startsWith("automator:")
      ? args.automator.slice("automator:".length)
      : args.automator;
    const prefixedName = `automator:${bareName}`;
    const runsBare = await listAutomatorRuns(vaultDb, { automatorName: bareName, limit: 100 });
    const runsPrefixed = await listAutomatorRuns(vaultDb, {
      automatorName: prefixedName,
      limit: 100,
    });
    const runs = [...runsBare, ...runsPrefixed];
    if (runs.length === 0) {
      return { vaultName, vaultPath, automator: args.automator, events: [] };
    }
    for (const run of runs) {
      const filter: {
        runId: Uint8Array;
        sinceMs?: number;
        level?: AutomatorRunEventLevel;
        limit?: number;
      } = {
        runId: run.id,
        limit,
      };
      if (args.sinceMs !== undefined) filter.sinceMs = args.sinceMs;
      if (args.level !== undefined) filter.level = args.level;
      const runEvents = await listAutomatorRunEvents(vaultDb, filter);
      for (const ev of runEvents) {
        events.push({
          runIdHex: uuid7BytesToHex(ev.runId),
          automatorName: run.automatorName,
          ts: ev.ts,
          level: ev.level,
          message: ev.message,
          dataJson: ev.dataJson,
        });
      }
    }
  } finally {
    await closeVaultDb(vaultDb);
  }
  // Sort all events globally by ts ASC for the UI surface.
  events.sort((a, b) => a.ts - b.ts);
  return { vaultName, vaultPath, automator: args.automator, events };
}
