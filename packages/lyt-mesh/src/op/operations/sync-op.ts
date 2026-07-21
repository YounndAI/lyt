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

// Increment 1 · Phase A.4 — the `sync` Operation (the honest-`none` END of the
// reversibility taxonomy, the counterpart to A.3's clean-undo `capture`).
//
// Home = lyt-mesh (which depends on lyt-vault) because the sync flow lives here;
// the Operation contract + Receipt + RemoteProvider port are imported from the
// lyt-vault barrel. It adds NO new remote mechanic — the push runs through the
// injected `RemoteProvider` (default = the firewalled GitRemoteProvider) — it
// wraps that push in the Operation spine so preview / horizon / inverse come
// for free.
//
// THE LOAD-BEARING RULE (D, cross-examine 2026-07-06 — the sharpest catch): the
// horizon is READ BACK from the ACTUAL push result, NEVER asserted from the
// verb. A landed push → `pushed` (→ inverse `none`: it reached the online copy,
// a local undo can't un-share it). A push that FAILED after a local commit
// leaves that commit unshared → `committed-not-pushed` (→ `clean-undo`: reset
// the local commit). A static `none` on a failed push would be a *dishonest*
// none in exactly the firewall's own failure modes — the thing this op refuses
// to do.
//
// SCOPE NOTE (A.4): the `committed-not-pushed → clean-undo` inverse is CLASS-ONLY
// here (no executable `UndoAction` payload). A.4 proves the honest
// CLASSIFICATION; the reset-local-commit executor for `lyt undo` is a later
// phase (the A.3 undo executor handles `delete-figment` only). Class-only is
// honest: the class states the change IS reversible locally; nothing false is
// promised, and no reset fires until the executor exists.

import {
  defaultInverseForHorizon,
  makeReceipt,
  type Inverse,
  type Operation,
  type Preview,
  type PushResult,
  type PushTarget,
  type Receipt,
  type RemoteProvider,
  type SyncHorizon,
} from "@younndai/lyt-vault";

/** The sync's inputs (what governs the honest horizon). */
export interface SyncOperationInput {
  vaultName: string;
  vaultPath: string;
  /**
   * True when there are local commit(s) to send (git `ahead > 0`). When false,
   * `apply()` performs NO push — the local state already IS the shared state (or
   * this was a pull-only sync), so the horizon stays `local`.
   */
  hasOutgoing: boolean;
  /** Exact remote + branch destination already checked against publication authority. */
  pushTarget: PushTarget;
}

/** Injectable seams — the production wiring is the default GitRemoteProvider; tests inject a fake port. */
export interface SyncOperationDeps {
  /** The git-remote seam. The push runs through this — the honest horizon is read back from its result. */
  remote: RemoteProvider;
  /** Fresh, attempt-bound authorization that must complete immediately before push. */
  authorizePush?: () => Promise<void>;
  /** Holds scoped canonical authority through the actual outward push. */
  executeAuthorizedPush?: (push: () => Promise<PushResult>) => Promise<PushResult>;
  /** ISO clock — reserved for a future op-log write; defaults to wall time. */
  now?: () => string;
}

export class SyncOperation implements Operation {
  readonly kind = "sync";

  // The INTENDED horizon before apply(); updated to the ACTUAL horizon after
  // apply() reads back the push result. Always read AFTER apply() for truth.
  horizon: SyncHorizon = "local";

  // The push result read back from the port — exposed (like CaptureOperation's
  // lastResult) so the sync flow can classify terminal-vs-retryable from the raw
  // code+stderr exactly as it did with the inline runGit result.
  lastPushResult: PushResult | null = null;

  constructor(
    private readonly input: SyncOperationInput,
    private readonly deps: SyncOperationDeps,
  ) {}

  // Zero-mutation description. Plain language (the charter's "no decision the
  // human can't answer") — no git/push/remote noun.
  async preview(): Promise<Preview> {
    return {
      summary: this.input.hasOutgoing
        ? `Send your saved changes in "${this.input.vaultName}" to its online copy.`
        : `"${this.input.vaultName}" is already in sync with its online copy.`,
      details: { vault: this.input.vaultName, outgoing: this.input.hasOutgoing },
    };
  }

  async apply(): Promise<Receipt> {
    if (!this.input.hasOutgoing) {
      // Nothing to send — the local state already matches the shared state (or a
      // pull-only sync). Horizon stays `local`: nothing left the machine.
      this.horizon = "local";
      return makeReceipt({
        applied: false,
        verified: true,
        logline: this.logline(),
        horizon: this.horizon,
        envelope: { vault: this.input.vaultName, pushed: false },
      });
    }

    if (this.deps.executeAuthorizedPush === undefined && this.deps.authorizePush === undefined) {
      this.lastPushResult = {
        pushed: false,
        code: -1,
        stderr: "publication permission was not verified for this sync attempt",
      };
      this.horizon = "committed-not-pushed";
      return makeReceipt({
        applied: false,
        verified: false,
        logline: this.logline(),
        horizon: this.horizon,
        envelope: { vault: this.input.vaultName, pushed: false },
      });
    }
    try {
      if (this.deps.executeAuthorizedPush !== undefined) {
        this.lastPushResult = await this.deps.executeAuthorizedPush(() =>
          this.deps.remote.push(this.input.vaultPath, this.input.pushTarget),
        );
      } else {
        await this.deps.authorizePush!();
        this.lastPushResult = await this.deps.remote.push(
          this.input.vaultPath,
          this.input.pushTarget,
        );
      }
    } catch (error) {
      this.lastPushResult = {
        pushed: false,
        code: -1,
        stderr: error instanceof Error ? error.message : String(error),
      };
      this.horizon = "committed-not-pushed";
      return makeReceipt({
        applied: false,
        verified: false,
        logline: this.logline(),
        horizon: this.horizon,
        envelope: { vault: this.input.vaultName, pushed: false },
      });
    }
    const pr = this.lastPushResult!;
    this.lastPushResult = pr;
    // HONEST-NONE: read the horizon back from what ACTUALLY happened. A landed
    // push is the ONLY path to `pushed`; a failed push leaves the local
    // commit(s) unshared → `committed-not-pushed` (never a static `none`).
    this.horizon = pr.pushed ? "pushed" : "committed-not-pushed";
    return makeReceipt({
      // `applied` reflects the effect reaching its destination: a landed push
      // applied; a failed push did NOT (the commit is still only local).
      applied: pr.pushed,
      // `verified` is checked against the REAL push result, not asserted.
      verified: pr.pushed,
      logline: this.logline(),
      horizon: this.horizon,
      envelope: { vault: this.input.vaultName, pushed: pr.pushed },
    });
  }

  // Computed from the (post-apply) horizon via the shared deterministic mapping:
  //   pushed                → none        (already on the online copy)
  //   committed-not-pushed  → clean-undo  (local commit is resettable; class-only, executor later)
  //   local                 → clean-undo  (nothing left the machine)
  inverse(): Inverse {
    return defaultInverseForHorizon(this.horizon);
  }

  logline(): string {
    switch (this.horizon) {
      case "pushed":
        return `Sent your saved changes in "${this.input.vaultName}" to its online copy.`;
      case "committed-not-pushed":
        return `Saved your changes in "${this.input.vaultName}" on this machine; they haven't reached the online copy yet.`;
      default:
        return `"${this.input.vaultName}" was already up to date.`;
    }
  }
}
