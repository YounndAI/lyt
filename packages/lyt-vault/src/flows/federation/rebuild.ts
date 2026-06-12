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

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { closeRegistry, openRegistry } from "../../registry/client.js";
import { readFederationState, upsertFederationState } from "../../registry/federation-state.js";
import {
  federationRepoFullName,
  getFederationRepoDir,
  getFederationYonPath,
} from "../../util/federation-paths.js";
import { realFederationGhClient, type FederationGhClient } from "../../util/gh-federation.js";
import { getHandleFromIdentity } from "../../util/identity.js";
import { parseFederationYon } from "../../yon/federation-read.js";
import { renderFederationYon } from "../../yon/federation-write.js";
import { derivePodManifestDoc, podManifestDocsEqualIgnoringStamp } from "./regenerate.js";

// `lyt federation rebuild` — re-derives the pod manifest (`pod.yon`) from current
// registry state. Deterministic per master plan §5 v1.A.0 acceptance item 4:
// running rebuild twice produces byte-identical output (modulo last_synced_at,
// which is intentionally exempt per OQ-4 resolution).
//
// D31 (Brief A): the manifest now LISTS the registry's meshes (@FED_MESH) AND
// vaults (@FED_VAULT) — both derived via the single `derivePodManifestDoc` path
// shared with the lifecycle regen hooks (regenerate.ts). Earlier (v1.A.0) this
// flow emitted zero @FED_MESH because the multi-mesh tables didn't exist yet;
// that placeholder is gone.
//
// Output: { changed: boolean, federation_state stamped, mesh/vault counts }.
// `changed` is true if the non-stamped portion of the manifest differs from the
// previous render. Useful for the command layer to decide whether to commit
// (no-op if unchanged).

export interface FederationRebuildOptions {
  handle?: string | undefined;
  pushToRemote?: boolean | undefined; // default false — rebuild is local-first
  ghClient?: FederationGhClient | undefined;
  identityProvider?: (() => string) | undefined;
  now?: (() => Date) | undefined;
}

export interface FederationRebuildResult {
  handle: string;
  federationYonPath: string;
  localPath: string;
  changed: boolean; // true if substantive content (not just stamp) changed
  pushed: boolean;
  meshCount: number;
  vaultCount: number;
}

export async function federationRebuildFlow(
  opts: FederationRebuildOptions = {},
): Promise<FederationRebuildResult> {
  const ghClient = opts.ghClient ?? realFederationGhClient;
  const identityProvider = opts.identityProvider ?? defaultIdentityProvider;
  const push = opts.pushToRemote ?? false;
  const now = opts.now ?? (() => new Date());

  const handle = opts.handle ?? identityProvider();
  const fedYonPath = getFederationYonPath(handle);
  const localDir = getFederationRepoDir(handle);

  if (!existsSync(fedYonPath)) {
    throw new Error(
      `No federation cache for handle ${JSON.stringify(handle)}. ` +
        `Run \`lyt federation init\` first.`,
    );
  }

  const db = await openRegistry();
  try {
    const state = await readFederationState(db, handle);
    if (state === null) {
      throw new Error(
        `federation_state row missing for handle ${JSON.stringify(handle)}. ` +
          `The pod.yon exists at ${fedYonPath} but the registry has no record — ` +
          `run \`lyt federation init\` to re-register the local cache.`,
      );
    }

    const existingRaw = readFileSync(fedYonPath, "utf8");
    const existing = parseFederationYon(existingRaw);

    // D31: derive meshes + vaults from the registry via the single shared
    // derivation path (regenerate.ts). Preserve the federation-level fields not
    // stored in the registry (visibility, created_at) from the existing manifest
    // — rebuild does not reset birth time or repo visibility.
    const stamp = now().toISOString();
    const next = await derivePodManifestDoc(db, {
      handle,
      visibility: existing.federation.visibility,
      createdAt: existing.federation.createdAt,
      nowIso: stamp,
    });

    const rendered = renderFederationYon(next);

    // v1.A.2d release review fold (v1.A.0 #16b): struct compare on the parsed
    // FederationDoc, dropping lastSyncedAt — survives writer field-order /
    // formatting drift. The shared helper now spans @FED_VAULT too (D31). The
    // byte-level helper stripStampAndNewlines is still exported for the test
    // suite's byte-identity assertions.
    const changed = !podManifestDocsEqualIgnoringStamp(existing, next);

    writeFileSync(fedYonPath, rendered, "utf8");
    await upsertFederationState(db, {
      handle,
      fedRidBytes: state.fedRidBytes,
      lastSyncedAt: stamp,
    });

    let pushed = false;
    if (changed && push) {
      try {
        await ghClient.commitAndOptionallyPush(
          localDir,
          `chore(federation): rebuild ${federationRepoFullName(handle)}`,
          true,
        );
        pushed = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(`federation rebuild: push failed — ${msg}`);
      }
    }

    return {
      handle,
      federationYonPath: fedYonPath,
      localPath: localDir,
      changed,
      pushed,
      meshCount: next.meshes.length,
      vaultCount: next.vaults.length,
    };
  } finally {
    await closeRegistry(db);
  }
}

// Exported so tests + future callers reference one canonical "what counts
// as substantive change at the BYTE level" rule (release review Angle E — was
// duplicated in tests/federation/federation-rebuild-idempotent.test.ts).
// Also strips CRLF → LF so cross-platform pod.yon files compare cleanly.
// Production rebuild logic uses podManifestDocsEqualIgnoringStamp (regenerate.ts)
// for STRUCTURAL compare (v1.A.0 #16b; D31 extended it to span @FED_VAULT).
export function stripStampAndNewlines(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/@META\s+key=last_synced_at\s*\|\s*value=\S+\s*\n?/g, "");
}

function defaultIdentityProvider(): string {
  return getHandleFromIdentity();
}
