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

// C10 — the topic-picker's read side. Resolves a vault by name, opens its
// per-vault lyt.db, and returns the DISTINCT frontmatter topics (ranked
// recommended-first) so `lyt capture` can offer existing topics for reuse. Thin
// read-only wrapper over listDistinctTopics; the CLI owns the picker UX + the
// topic->folder routing (topics stay a CLI-layer concern per the C10 design).

import { closeRegistry, openRegistry } from "../registry/client.js";
import { listDistinctTopics, type TopicCount } from "../registry/figment-meta-repo.js";
import { getVaultByName } from "../registry/repo.js";
import { closeVaultDb, openLytDbActionable } from "../registry/vault-db.js";

export async function listVaultTopicsFlow(args: { vaultName: string }): Promise<TopicCount[]> {
  const registryDb = await openRegistry();
  let vaultPath: string;
  let vaultName: string;
  try {
    const row = await getVaultByName(registryDb, args.vaultName);
    if (!row) {
      throw new Error(`list topics: no vault named '${args.vaultName}' in registry.`);
    }
    vaultPath = row.path;
    vaultName = row.name;
  } finally {
    await closeRegistry(registryDb);
  }

  // openLytDbActionable maps a corrupt lyt.db to an actionable `lyt reindex`
  // error rather than a raw libSQL fault (same posture as the primer/search
  // read paths).
  const lytDb = await openLytDbActionable(vaultPath, vaultName);
  try {
    return await listDistinctTopics(lytDb);
  } finally {
    await closeVaultDb(lytDb);
  }
}
