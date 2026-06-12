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

import { existsSync, lstatSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { listVaults } from "../registry/repo.js";
import { getUserPatternsDir } from "../util/pattern-paths.js";

export interface PatternUninstallArgs {
  name: string;
  force?: boolean | undefined;
}

export interface PatternUninstallResult {
  name: string;
  removed: boolean;
  reason?: string | undefined;
  affectedVaults: string[];
}

// Refuses to remove a pattern if any active vault has a symlink/dir pointing at it,
// unless --force is passed. With --force, unlinks the per-vault symlinks first.
export async function patternUninstallFlow(
  args: PatternUninstallArgs,
): Promise<PatternUninstallResult> {
  const patternsDir = getUserPatternsDir();
  const target = join(patternsDir, args.name);
  if (!existsSync(target)) {
    return { name: args.name, removed: false, reason: "not-installed", affectedVaults: [] };
  }

  const db = await openRegistry();
  let affectedVaults: string[] = [];
  try {
    const vaults = await listVaults(db);
    for (const v of vaults) {
      if (v.status !== "active") continue;
      const linkPath = join(v.path, "Patterns", args.name);
      if (!existsSync(linkPath)) continue;
      affectedVaults.push(v.name);
    }
  } finally {
    await closeRegistry(db);
  }

  if (affectedVaults.length > 0 && args.force !== true) {
    return {
      name: args.name,
      removed: false,
      reason: `linked-in-vaults: ${affectedVaults.join(", ")}`,
      affectedVaults,
    };
  }

  // Remove vault-side symlinks first (best-effort).
  if (args.force === true) {
    const db2 = await openRegistry();
    try {
      const vaults = await listVaults(db2);
      for (const v of vaults) {
        if (v.status !== "active") continue;
        const linkPath = join(v.path, "Patterns", args.name);
        if (!existsSync(linkPath)) continue;
        try {
          const stat = lstatSync(linkPath);
          if (stat.isSymbolicLink()) {
            readlinkSync(linkPath); // confirm readable
          }
          rmSync(linkPath, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    } finally {
      await closeRegistry(db2);
    }
  }

  rmSync(target, { recursive: true, force: true });
  return { name: args.name, removed: true, affectedVaults };
}
