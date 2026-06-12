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

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByName, type VaultRow } from "../registry/repo.js";
import { frozenLockPath } from "../util/freeze-check.js";
import { hexToUuid7Bytes } from "../util/uuid7.js";
import { parseVaultYon } from "../yon/parse.js";
import { renderVaultYon, type VaultDoc } from "../yon/vault.js";

export interface UnfreezeFlowArgs {
  name: string;
}

export interface UnfreezeFlowResult {
  vault: VaultRow;
  yonPath: string;
  lockPath: string;
  wasFrozen: boolean;
  removedLock: boolean;
}

export async function unfreezeVaultFlow(args: UnfreezeFlowArgs): Promise<UnfreezeFlowResult> {
  const db = await openRegistry();
  try {
    const vault = await getVaultByName(db, args.name);
    if (!vault) {
      throw new Error(`No vault registered with name '${args.name}'.`);
    }
    const yonPath = join(vault.path, ".lyt", "vault.yon");
    const lockPath = frozenLockPath(vault.path);

    let wasFrozen = false;
    if (existsSync(yonPath)) {
      const beforeContent = readFileSync(yonPath, "utf8");
      const parsed = parseVaultYon(beforeContent);
      if (parsed.frozenAt || parsed.frozenUntil) {
        wasFrozen = true;
        const doc: VaultDoc = {
          vault: {
            rid: hexToUuid7Bytes(parsed.rid),
            name: parsed.name,
            desc: parsed.desc ?? undefined,
            parentVault: parsed.parentVault ? hexToUuid7Bytes(parsed.parentVault) : undefined,
            shareWith: parsed.shareWith,
            acceptsFrom: parsed.acceptsFrom,
            tierHint: parsed.tierHint ?? undefined,
            memscope: parsed.memscopeRid ? hexToUuid7Bytes(parsed.memscopeRid) : undefined,
            createdAt: parsed.createdAt ?? new Date().toISOString(),
            version: parsed.version ?? "0.1",
          },
          gitUrl: parsed.gitUrl ?? undefined,
          primaryOwner: parsed.primaryOwner ?? "unknown",
          lifecycle: "active",
          topics: parsed.topics,
          agentTemplateVersion: parsed.agentTemplateVersion ?? undefined,
        };
        writeFileSync(yonPath, renderVaultYon(doc), "utf8");
      }
    }

    let removedLock = false;
    if (existsSync(lockPath)) {
      unlinkSync(lockPath);
      removedLock = true;
      wasFrozen = true;
    }

    return { vault, yonPath, lockPath, wasFrozen, removedLock };
  } finally {
    await closeRegistry(db);
  }
}
