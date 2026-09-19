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

import {
  closeRegistry,
  getVaultByRid,
  liveSubscriptions,
  listFederationStates,
  normalizeGitHubRepoCoordinate,
  openRegistry,
  uuid7BytesToHex,
  withDestinationPolicySubjectLocks,
  withFreshPublicationPermission,
  type LiveSubscription,
  type PublicationPermissionObserver,
  type VaultRow,
} from "@younndai/lyt-vault";

export interface ForeignSyncAuthority {
  actor: string;
  target: string;
  repository: string;
  vaultRid: Uint8Array;
  podRid: string;
  podRoot?: string;
  policy: null;
  foreignSource: "shared" | "subscribed";
}

/** A received origin is usable only while its receiver-authored ledger entry is live. */
export function resolveForeignSyncRepository(
  vault: VaultRow,
  subscriptions: readonly LiveSubscription[],
): string | null {
  if (vault.status !== "active" || (vault.source !== "shared" && vault.source !== "subscribed")) {
    return null;
  }
  const repository = vault.gitUrl === null ? null : normalizeGitHubRepoCoordinate(vault.gitUrl);
  if (repository === null) return null;
  const coordinate = `lyt:vault:github.com/${repository}`.toLowerCase();
  const mode = vault.source === "shared" ? "shared" : "subscribe";
  return subscriptions.some(
    (entry) =>
      entry.coordinate.toLowerCase() === coordinate &&
      entry.rid.replace(/-/g, "").toLowerCase() === vault.ridHex.toLowerCase() &&
      entry.entryMode === mode,
  )
    ? repository
    : null;
}

/** Hold the same vault subject fence as source transitions; recheck before every remote child. */
export async function withForeignSyncAttempt<T>(args: {
  authority: ForeignSyncAuthority;
  vault: VaultRow;
  readOnly: boolean;
  attemptId: string;
  permissionObserver: PublicationPermissionObserver;
  action: (context: { runOutwardChild<U>(child: () => Promise<U>): Promise<U> }) => Promise<T>;
}): Promise<T> {
  const a = args.authority;
  const ridHex = uuid7BytesToHex(a.vaultRid);
  return withDestinationPolicySubjectLocks(
    a.podRoot,
    [{ subjectKind: "vault", subjectRid: ridHex }],
    async (lease) => {
      const revalidate = async () => {
        lease.renew();
        const db = await openRegistry();
        try {
          const current = await getVaultByRid(db, a.vaultRid);
          const states = await listFederationStates(db);
          if (
            states.length !== 1 ||
            states[0]!.fedRidHex !== a.podRid ||
            states[0]!.handle !== a.actor ||
            current === null ||
            current.path !== args.vault.path ||
            current.source !== a.foreignSource ||
            resolveForeignSyncRepository(current, liveSubscriptions(a.podRoot))?.toLowerCase() !==
              a.repository.toLowerCase()
          ) {
            throw new Error(
              "Shared sync refused: received vault identity or subscription changed.",
            );
          }
        } finally {
          await closeRegistry(db);
        }
      };
      await revalidate();
      const context = {
        runOutwardChild: async <U>(child: () => Promise<U>): Promise<U> => {
          await revalidate();
          return child();
        },
      };
      if (args.readOnly) return args.action(context);
      if (a.foreignSource !== "shared")
        throw new Error("Subscribed vaults cannot publish changes.");
      return withFreshPublicationPermission({
        capability: "repository-push",
        target: a.target,
        repository: a.repository,
        actor: a.actor,
        attemptId: args.attemptId,
        policyEpoch: 0,
        permissionObserver: args.permissionObserver,
        action: () => args.action(context),
      });
    },
  );
}
