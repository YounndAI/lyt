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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByName, type VaultRow } from "../registry/repo.js";
import { DEFAULT_FREEZE_DURATION, parseFreezeDuration } from "../util/duration.js";
import { frozenLockPath } from "../util/freeze-check.js";
import { hexToUuid7Bytes } from "../util/uuid7.js";
import { parseVaultYon } from "../yon/parse.js";
import { renderVaultYon, type VaultDoc } from "../yon/vault.js";

export interface FreezeFlowArgs {
  name: string;
  until?: string;
  now?: Date;
}

export interface FreezeFlowResult {
  vault: VaultRow;
  yonPath: string;
  lockPath: string;
  frozenAt: string;
  frozenUntil: string;
}

export async function freezeVaultFlow(args: FreezeFlowArgs): Promise<FreezeFlowResult> {
  const db = await openRegistry();
  try {
    const vault = await getVaultByName(db, args.name);
    if (!vault) {
      throw new Error(`No vault registered with name '${args.name}'.`);
    }
    if (vault.status === "tombstoned") {
      throw new Error(`Vault '${args.name}' is tombstoned; cannot freeze a buried vault.`);
    }
    const now = args.now ?? new Date();
    const untilInput = args.until && args.until.length > 0 ? args.until : DEFAULT_FREEZE_DURATION;
    const frozenAt = now.toISOString();
    const frozenUntil = parseFreezeDuration(untilInput, now);

    const yonPath = join(vault.path, ".lyt", "vault.yon");
    const beforeContent = readFileSync(yonPath, "utf8");
    const parsed = parseVaultYon(beforeContent);
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
        createdAt: parsed.createdAt ?? frozenAt,
        version: parsed.version ?? "0.1",
        frozenAt,
        frozenUntil,
      },
      gitUrl: parsed.gitUrl ?? undefined,
      primaryOwner: parsed.primaryOwner ?? "unknown",
      lifecycle: "frozen",
      topics: parsed.topics,
      agentTemplateVersion: parsed.agentTemplateVersion ?? undefined,
    };
    writeFileSync(yonPath, renderVaultYon(doc), "utf8");

    const lockPath = frozenLockPath(vault.path);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ frozen_at: frozenAt, frozen_until: frozenUntil }, null, 2),
      "utf8",
    );

    return { vault, yonPath, lockPath, frozenAt, frozenUntil };
  } finally {
    await closeRegistry(db);
  }
}
