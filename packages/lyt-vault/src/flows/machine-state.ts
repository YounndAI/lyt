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
import { getFederationRoot } from "../util/federation-paths.js";
import { readPodIdentity } from "../util/identity-cache.js";
import { getIdentity } from "../util/identity.js";
import { getMachineId } from "../util/writer-id.js";
import { parseFederationYon } from "../yon/federation-read.js";
import {
  readCurrentMachine,
  updateCurrentMachineAlias,
  type MachineLedgerRecord,
} from "../yon/machine-ledger.js";

// Per arc §7 — machine stance is role *composition*, not a discrete mode.
// Defaults to client + automator-runner + mesh-syncer (typical solo);
// llm-host is OFF unless the handler explicitly enables. Automators in
// block-B declare requires_role=[...]; the runtime check skips on any
// machine that lacks the role.
export const MACHINE_ROLES = Object.freeze([
  "client",
  "automator-runner",
  "mesh-syncer",
  "llm-host",
] as const);
export type MachineRole = (typeof MACHINE_ROLES)[number];

export const DEFAULT_MACHINE_ROLES: readonly MachineRole[] = Object.freeze([
  "client",
  "automator-runner",
  "mesh-syncer",
]);

export interface MachineStatus {
  roles: MachineRole[];
  region: string;
  machineId: string;
  accountIdentity: string;
  alias: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  lastSync: string | null;
  // 0.20 compatibility alias for accountIdentity.
  identity: string;
}

function isMachineRole(value: string): value is MachineRole {
  return (MACHINE_ROLES as readonly string[]).includes(value);
}

function parseRolesCsv(raw: string): MachineRole[] {
  const out: MachineRole[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    if (!isMachineRole(trimmed)) {
      throw new Error(
        `machine_state.roles contains unknown role ${JSON.stringify(trimmed)}. Valid: ${MACHINE_ROLES.join(", ")}`,
      );
    }
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function rolesCsv(roles: readonly MachineRole[]): string {
  return roles.join(",");
}

export async function readMachineState(): Promise<{ roles: MachineRole[]; region: string }> {
  const db = await openRegistry();
  try {
    const r = await db.execute(
      "SELECT key, value FROM machine_state WHERE key IN ('roles', 'region')",
    );
    let rolesRaw = rolesCsv(DEFAULT_MACHINE_ROLES);
    let region = "";
    for (const row of r.rows) {
      if (row["key"] === "roles") rolesRaw = String(row["value"]);
      else if (row["key"] === "region") region = String(row["value"]);
    }
    return { roles: parseRolesCsv(rolesRaw), region };
  } finally {
    await closeRegistry(db);
  }
}

export async function machineStatusFlow(): Promise<MachineStatus> {
  const state = await readMachineState();
  const accountIdentity = getIdentity();
  const machineId = getMachineId();
  const machine = readCurrentMachine(undefined, machineId);
  return {
    roles: state.roles,
    region: state.region,
    machineId,
    accountIdentity,
    alias: machine?.alias ?? null,
    firstSeen: machine?.firstSeen ?? null,
    lastSeen: machine?.lastSeen ?? null,
    lastSync: machine?.lastSync ?? null,
    identity: accountIdentity,
  };
}

export function machineAliasUpdateFlow(alias: string): MachineLedgerRecord {
  const podRoot = getFederationRoot();
  const identity = readPodIdentity(podRoot);
  const manifestPath = join(podRoot, "pod.yon");
  if (identity?.podRid === undefined || !existsSync(manifestPath)) {
    throw new Error("Cannot update machine alias before the pod repository and identity are initialized.");
  }
  const manifest = parseFederationYon(readFileSync(manifestPath, "utf8"));
  if (manifest.federation.fedRidHex !== identity.podRid) {
    throw new Error("Cannot update machine alias: pod repository identity does not match identity.yon.");
  }
  return updateCurrentMachineAlias(alias, { podRoot, accountIdentity: getIdentity() });
}

export interface MachineRoleEnableArgs {
  role: string;
}

export async function machineRoleEnableFlow(
  args: MachineRoleEnableArgs,
): Promise<{ roles: MachineRole[] }> {
  if (!isMachineRole(args.role)) {
    throw new Error(
      `Unknown machine role ${JSON.stringify(args.role)}. Valid: ${MACHINE_ROLES.join(", ")}`,
    );
  }
  const current = await readMachineState();
  if (current.roles.includes(args.role)) {
    return { roles: current.roles };
  }
  const next = [...current.roles, args.role];
  await writeRoles(next);
  return { roles: next };
}

export interface MachineRoleDisableArgs {
  role: string;
}

export async function machineRoleDisableFlow(
  args: MachineRoleDisableArgs,
): Promise<{ roles: MachineRole[] }> {
  if (!isMachineRole(args.role)) {
    throw new Error(
      `Unknown machine role ${JSON.stringify(args.role)}. Valid: ${MACHINE_ROLES.join(", ")}`,
    );
  }
  const current = await readMachineState();
  const next = current.roles.filter((r) => r !== args.role);
  await writeRoles(next);
  return { roles: next };
}

async function writeRoles(roles: readonly MachineRole[]): Promise<void> {
  const db = await openRegistry();
  try {
    await db.execute({
      sql:
        "INSERT INTO machine_state (key, value, updated_at) VALUES ('roles', ?, ?)" +
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      args: [rolesCsv(roles), Date.now()],
    });
  } finally {
    await closeRegistry(db);
  }
}

export interface MachineRegionConfigArgs {
  region: string;
}

export async function machineRegionConfigFlow(
  args: MachineRegionConfigArgs,
): Promise<{ region: string }> {
  // Region is handler-declared per arc §7.10 — no auto-detection. Empty
  // string allowed (un-set).
  const region = args.region.trim();
  const db = await openRegistry();
  try {
    await db.execute({
      sql:
        "INSERT INTO machine_state (key, value, updated_at) VALUES ('region', ?, ?)" +
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      args: [region, Date.now()],
    });
  } finally {
    await closeRegistry(db);
  }
  return { region };
}
