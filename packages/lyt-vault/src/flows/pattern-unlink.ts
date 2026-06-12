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

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByName } from "../registry/repo.js";
import { regenAgentsMd } from "./agents-md-regen.js";

export interface PatternUnlinkArgs {
  patternName: string;
  vaultName: string;
}

export interface PatternUnlinkResult {
  patternName: string;
  vaultName: string;
  removed: boolean;
  agentsMdRegenerated: boolean;
}

export async function patternUnlinkFlow(args: PatternUnlinkArgs): Promise<PatternUnlinkResult> {
  const db = await openRegistry();
  let vaultPath: string;
  try {
    const row = await getVaultByName(db, args.vaultName);
    if (!row) {
      throw new Error(`pattern unlink: no vault named '${args.vaultName}' in registry.`);
    }
    vaultPath = row.path;
  } finally {
    await closeRegistry(db);
  }
  const linkPath = join(vaultPath, "Patterns", args.patternName);
  if (!existsSync(linkPath)) {
    return {
      patternName: args.patternName,
      vaultName: args.vaultName,
      removed: false,
      agentsMdRegenerated: false,
    };
  }
  rmSync(linkPath, { recursive: true, force: true });

  let agentsMdRegenerated = false;
  try {
    const r = regenAgentsMd(vaultPath, args.vaultName);
    agentsMdRegenerated = r.written;
  } catch {
    // best-effort
  }

  return {
    patternName: args.patternName,
    vaultName: args.vaultName,
    removed: true,
    agentsMdRegenerated,
  };
}
