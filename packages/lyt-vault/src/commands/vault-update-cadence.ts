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

import { Command } from "commander";

import {
  setVaultUpdateCadenceFlow,
  VaultUpdateCadenceFlagComboError,
  VaultUpdateCadenceNoHomeMeshError,
  VaultUpdateCadenceNotFoundError,
} from "../flows/vault-update-cadence.js";
import type { MeshUpdateCadenceType } from "../yon/mesh-write.js";

// v1.B.6 — `lyt vault update-cadence <vault> [--cron <spec> | --interval
// <seconds> | --on-demand] [--timezone <tz>] [--peak-hours <csv>]
// [--no-on-demand] [--json]`. Mutually-exclusive cadence-type flags;
// idempotent re-emit via Lock 0.3 mesh.yon writer.

interface VaultUpdateCadenceCliOpts {
  cron?: string;
  interval?: string;
  onDemand?: boolean;
  timezone?: string;
  peakHours?: string;
  json?: boolean;
}

export function buildVaultUpdateCadenceCommand(): Command {
  return new Command("update-cadence")
    .description(
      "v1.B.6: declare publisher-side sync rhythm for a home vault in a public mesh. Writes @UPDATE_CADENCE into the vault's home mesh.yon (mesh-scoped declaration per lyt-public-mesh §2.3). Mutually-exclusive --cron / --interval / --on-demand.",
    )
    .argument("<vault>", "Vault name (must be registered locally and bound to a home mesh)")
    .option("--cron <spec>", "POSIX 5-field cron expression (e.g. '0 9 * * 1')")
    .option("--interval <seconds>", "Interval between syncs in seconds (e.g. 86400 for daily)")
    .option("--on-demand", "Subscribers sync only on explicit trigger")
    .option("--timezone <tz>", "IANA timezone for interpreting --cron")
    .option(
      "--peak-hours <csv>",
      "Comma-separated local-time hours (0-23) preferred for sync (advisory)",
    )
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (vaultName: string, opts: VaultUpdateCadenceCliOpts) => {
      const flagsSet = [
        opts.cron !== undefined,
        opts.interval !== undefined,
        opts.onDemand === true,
      ].filter(Boolean).length;
      if (flagsSet !== 1) {
        emitError(opts.json === true, {
          error: "vault-update-cadence-invalid-flag-combo",
          message:
            "lyt vault update-cadence: exactly one of --cron, --interval, --on-demand must be specified.",
        });
        process.exitCode = 2;
        return;
      }
      let cadenceType: MeshUpdateCadenceType;
      let intervalSeconds: number | undefined;
      if (opts.cron !== undefined) {
        cadenceType = "cron";
      } else if (opts.interval !== undefined) {
        cadenceType = "interval";
        intervalSeconds = Number.parseInt(opts.interval, 10);
        if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
          emitError(opts.json === true, {
            error: "vault-update-cadence-invalid-flag-combo",
            message: `lyt vault update-cadence: --interval must be a positive integer (got '${opts.interval}').`,
          });
          process.exitCode = 2;
          return;
        }
      } else {
        cadenceType = "on-demand";
      }

      try {
        const result = await setVaultUpdateCadenceFlow({
          vaultName,
          cadenceType,
          ...(opts.cron !== undefined ? { cron: opts.cron } : {}),
          ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
          ...(opts.timezone !== undefined ? { timezone: opts.timezone } : {}),
          ...(opts.peakHours !== undefined ? { peakHours: opts.peakHours } : {}),
        });
        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify(
              {
                vault: { name: result.vaultName, rid_hex: result.vaultRidHex },
                mesh: { name: result.meshName, rid_hex: result.meshRidHex },
                cadence_type: result.cadenceType,
                mesh_yon_path: result.meshYonPath,
                duration_ms: result.durationMs,
              },
              null,
              2,
            ),
          );
          return;
        }
        // eslint-disable-next-line no-console
        console.log(
          `Updated @UPDATE_CADENCE for vault '${result.vaultName}' in mesh '${result.meshName}' (${result.cadenceType}).`,
        );
        // eslint-disable-next-line no-console
        console.log(`  mesh.yon: ${result.meshYonPath}`);
      } catch (err) {
        const status = mapErrorToExitCode(err);
        const body = errorToJsonBody(err);
        emitError(opts.json === true, body);
        process.exitCode = status ?? 1;
      }
    });
}

function mapErrorToExitCode(err: unknown): number | null {
  if (err instanceof VaultUpdateCadenceNotFoundError) return 2;
  if (err instanceof VaultUpdateCadenceNoHomeMeshError) return 2;
  if (err instanceof VaultUpdateCadenceFlagComboError) return 2;
  return null;
}

function errorToJsonBody(err: unknown): Record<string, unknown> {
  if (err instanceof VaultUpdateCadenceNotFoundError) {
    return { error: err.errorCode, vault_name: err.vaultName, message: err.message };
  }
  if (err instanceof VaultUpdateCadenceNoHomeMeshError) {
    return { error: err.errorCode, vault_name: err.vaultName, message: err.message };
  }
  if (err instanceof VaultUpdateCadenceFlagComboError) {
    return { error: err.errorCode, message: err.message };
  }
  return { error: "unknown", message: err instanceof Error ? err.message : String(err) };
}

function emitError(json: boolean, body: Record<string, unknown>): void {
  if (json) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(body, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.error(`lyt vault update-cadence: ${String(body["message"] ?? body["error"])}`);
  }
}
