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

import { cpSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByName } from "../registry/repo.js";
import { getUserPatternsDir } from "../util/pattern-paths.js";
import { regenAgentsMd } from "./agents-md-regen.js";

export interface PatternLinkArgs {
  patternName: string;
  vaultName: string;
}

export interface PatternLinkResult {
  patternName: string;
  vaultName: string;
  vaultPath: string;
  linkPath: string;
  status: "linked" | "already-linked" | "copied-fallback";
  agentsMdRegenerated: boolean;
}

// Create a symlink at <vault>/Patterns/<pattern-name> -> ~/lyt/patterns/<pattern-name>.
// On Windows where symlink creation requires admin privileges, falls back to a directory
// copy and surfaces status="copied-fallback".
export async function patternLinkFlow(args: PatternLinkArgs): Promise<PatternLinkResult> {
  const patternsDir = getUserPatternsDir();
  const patternDir = join(patternsDir, args.patternName);
  if (!existsSync(patternDir)) {
    throw new Error(`pattern link: '${args.patternName}' not installed at ${patternDir}.`);
  }

  const db = await openRegistry();
  let vaultPath: string;
  try {
    const row = await getVaultByName(db, args.vaultName);
    if (!row) {
      throw new Error(`pattern link: no vault named '${args.vaultName}' in registry.`);
    }
    if (row.status === "tombstoned") {
      throw new Error(`pattern link: vault '${args.vaultName}' is tombstoned.`);
    }
    vaultPath = row.path;
  } finally {
    await closeRegistry(db);
  }

  const linkPath = join(vaultPath, "Patterns", args.patternName);
  if (existsSync(linkPath)) {
    return {
      patternName: args.patternName,
      vaultName: args.vaultName,
      vaultPath,
      linkPath,
      status: "already-linked",
      agentsMdRegenerated: false,
    };
  }

  mkdirSync(dirname(linkPath), { recursive: true });

  let status: PatternLinkResult["status"];
  try {
    symlinkSync(patternDir, linkPath, "junction");
    status = "linked";
  } catch {
    // Symlink failed (Windows-no-admin or filesystem limitation). Fallback to copy.
    cpSync(patternDir, linkPath, { recursive: true });
    status = "copied-fallback";
  }

  // Regenerate agents.md's installed-patterns section.
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
    vaultPath,
    linkPath,
    status,
    agentsMdRegenerated,
  };
}
