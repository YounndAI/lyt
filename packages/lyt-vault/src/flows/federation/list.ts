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

import { closeRegistry, openRegistry } from "../../registry/client.js";
import { listFederationStates } from "../../registry/federation-state.js";
import { getFederationYonPath } from "../../util/federation-paths.js";
import { getHandleFromIdentity } from "../../util/identity.js";
import { parseFederationYon } from "../../yon/federation-read.js";
import type { FedMeshRecord, FederationRecord } from "../../yon/federation-write.js";

// `lyt federation list` — reads the cached pod.yon and returns
// @FED_MESH records sorted by mesh_name (matches federation-write.ts
// deterministic ordering, but enforced here too in case the file was
// hand-edited).
//
// Branches:
// - pod.yon missing → throws with a "run lyt federation init" hint
// - pod.yon present → parse + return

export interface FederationListResult {
  federation: FederationRecord;
  meshes: FedMeshRecord[];
  lastSyncedAt: string;
  federationYonPath: string;
}

export interface FederationListOptions {
  handle?: string | undefined;
  identityProvider?: (() => string) | undefined;
}

export async function federationListFlow(
  opts: FederationListOptions = {},
): Promise<FederationListResult> {
  const identityProvider = opts.identityProvider ?? defaultIdentityProvider;
  const handle = opts.handle ?? (await resolveHandle(identityProvider));
  const path = getFederationYonPath(handle);
  if (!existsSync(path)) {
    throw new Error(
      `No federation cache for handle ${JSON.stringify(handle)}. ` +
        `Run \`lyt federation init\` to forge Your Pod.`,
    );
  }
  const raw = readFileSync(path, "utf8");
  const doc = parseFederationYon(raw);
  const meshes = [...doc.meshes].sort((a, b) => {
    if (a.meshName < b.meshName) return -1;
    if (a.meshName > b.meshName) return 1;
    return 0;
  });
  return {
    federation: doc.federation,
    meshes,
    lastSyncedAt: doc.lastSyncedAt,
    federationYonPath: path,
  };
}

async function resolveHandle(identityProvider: () => string): Promise<string> {
  // v1.A.2d release review fold (v1.A.0 #2): identity-first precedence — the
  // identity probe is an in-process gh-handle lookup (typically cached);
  // the registry open is ~200ms of Windows file-lock cost. Only fall back
  // to federation_state when identity is unavailable (gh missing, no auth,
  // sandboxed env). This saves a full registry open/close per `lyt
  // federation list` invocation on the happy path.
  try {
    return identityProvider();
  } catch {
    // Identity probe failed — consult federation_state for the canonical
    // handle on this machine.
    const db = await openRegistry();
    try {
      const states = await listFederationStates(db);
      if (states.length === 1) return states[0]!.handle;
    } finally {
      await closeRegistry(db);
    }
    throw new Error(
      "Cannot resolve handle: gh identity unavailable AND no unique " +
        "federation_state row found. Run `lyt federation init` or " +
        "`gh auth login`.",
    );
  }
}

function defaultIdentityProvider(): string {
  return getHandleFromIdentity();
}
