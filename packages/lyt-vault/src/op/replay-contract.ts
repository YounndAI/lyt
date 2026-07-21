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

export type ReplayCoverage =
  | "planned-receipt-boundary"
  | "legacy-operation-log"
  | "canonical-state-idempotent"
  | "handler-gated-non-replay"
  | "deferred";

export type PhaseALifecycleMutation =
  | "mesh-init"
  | "vault-init"
  | "vault-adopt"
  | "vault-join"
  | "vault-clone"
  | "vault-refresh"
  | "vault-abandon"
  | "vault-verify"
  | "vault-disconnect"
  | "vault-reconnect"
  | "vault-rebuild-index"
  | "vault-rebuild-lanes"
  | "vault-rebuild-rollup"
  | "vault-rebuild-arcs"
  | "vault-rebuild-fts"
  | "vault-rebuild"
  | "vault-add-edge"
  | "vault-move"
  | "vault-rename"
  | "vault-regen-context"
  | "vault-sync-metadata"
  | "vault-freeze"
  | "vault-unfreeze"
  | "vault-snapshot"
  | "vault-restore"
  | "vault-share"
  | "vault-unshare"
  | "vault-invites"
  | "vault-accept-share"
  | "mesh-join"
  | "mesh-subscribe"
  | "mesh-adopt"
  | "mesh-prune"
  | "mesh-add-edge"
  | "mesh-rebuild-registry"
  | "mesh-rebuild-rollup"
  | "mesh-canvas"
  | "mesh-clone-all"
  | "mesh-source-add"
  | "mesh-source-remove"
  | "undo"
  | "repair"
  | "reindex"
  | "alias"
  | "pattern-install"
  | "pattern-uninstall"
  | "pattern-link"
  | "pattern-unlink"
  | "pattern-fork"
  | "pattern-run"
  | "skills-install"
  | "agent-manual-install"
  | "init"
  | "discover-auto"
  | "vault-backfill"
  | "vault-reconcile"
  | "primer"
  | "model-fetch"
  | "model-nudge"
  | "automator-run"
  | "federation-init"
  | "federation-rebuild"
  | "federation-canvas"
  | "registry-reset"
  | "registry-rebuild"
  | "identity-refresh"
  | "machine-role-enable"
  | "machine-role-disable"
  | "machine-config-region"
  | "friction-note"
  | "friction-resolve"
  | "friction-false-positive"
  | "capture-metric-record"
  | "housekeep"
  | "audit-export"
  | "scoped-sync"
  | "pod-sync"
  | "existing-pod-refresh"
  | "update"
  | "editor-localization-prepare"
  | "editor-localization-apply"
  | "capture"
  | "vault-delete"
  | "vault-forget"
  | "mesh-delete";

export interface ReplayBoundaryDeclaration {
  operation: PhaseALifecycleMutation;
  commandPath?: string;
  coverage: ReplayCoverage;
  sideEffects: readonly ("filesystem" | "registry" | "git" | "github" | "npm" | "editor-index")[];
  note: string;
}

/**
 * An executable inventory of operations whose concrete receipt-bound replay
 * implementation is deliberately owned by Phase C2. This is not evidence that
 * a row has a durable replay key, journal, producer, or resume behavior yet.
 * The side-effect sets describe the operation boundaries that C2 must cover.
 */
export const PHASE_A_REPLAY_INVENTORY: readonly ReplayBoundaryDeclaration[] = [
  {
    operation: "mesh-init",
    commandPath: "mesh init",
    coverage: "planned-receipt-boundary",
    sideEffects: ["filesystem", "registry", "git"],
    note: "Creation has local filesystem, registry, and checkpoint-Git boundaries.",
  },
  {
    operation: "vault-init",
    commandPath: "vault init",
    coverage: "planned-receipt-boundary",
    sideEffects: ["filesystem", "registry", "git"],
    note: "Creation has local filesystem, registry, and checkpoint-Git boundaries.",
  },
  {
    operation: "vault-adopt",
    commandPath: "vault adopt",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem", "registry"],
    note: "Scaffold, registration, pattern links, and indexes converge from the adopted vault.",
  },
  {
    operation: "vault-join",
    commandPath: "vault join",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem", "registry"],
    note: "Registration and derived local state converge from the existing vault.",
  },
  {
    operation: "vault-clone",
    commandPath: "vault clone",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem", "registry", "git"],
    note: "Git clone, registration, and derived local state converge at one target path.",
  },
  {
    operation: "vault-refresh",
    commandPath: "vault refresh",
    coverage: "canonical-state-idempotent",
    sideEffects: ["registry", "github"],
    note: "A fresh permission observation replaces the cached publication verdict.",
  },
  {
    operation: "vault-abandon",
    commandPath: "vault abandon",
    coverage: "handler-gated-non-replay",
    sideEffects: ["filesystem", "registry"],
    note: "Explicit confirmation removes local Lyt adoption while preserving Markdown.",
  },
  {
    operation: "vault-verify",
    commandPath: "vault verify",
    coverage: "deferred",
    sideEffects: ["registry"],
    note: "Verification can update lifecycle counters and status; replay work is later.",
  },
  {
    operation: "vault-disconnect",
    commandPath: "vault disconnect",
    coverage: "canonical-state-idempotent",
    sideEffects: ["registry"],
    note: "Sets the registered vault lifecycle state to disconnected.",
  },
  {
    operation: "vault-reconnect",
    commandPath: "vault reconnect",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem", "registry"],
    note: "Rebinds the verified path, restores active state, and regenerates local context.",
  },
  {
    operation: "vault-rebuild-index",
    commandPath: "vault rebuild-index",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem", "editor-index"],
    note: "Rebuilds local projections from canonical vault content.",
  },
  {
    operation: "vault-rebuild-lanes",
    commandPath: "vault rebuild-lanes",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem", "editor-index"],
    note: "Rebuilds the local lane projection.",
  },
  {
    operation: "vault-rebuild-rollup",
    commandPath: "vault rebuild-rollup",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem", "editor-index"],
    note: "Rebuilds the local rollup projection.",
  },
  {
    operation: "vault-rebuild-arcs",
    commandPath: "vault rebuild-arcs",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem", "editor-index"],
    note: "Rebuilds the local arc projection.",
  },
  {
    operation: "vault-rebuild-fts",
    commandPath: "vault rebuild-fts",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem", "editor-index"],
    note: "Rebuilds the local full-text projection.",
  },
  {
    operation: "vault-rebuild",
    commandPath: "vault rebuild",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem", "editor-index"],
    note: "Rebuilds local derived vault projections.",
  },
  {
    operation: "vault-add-edge",
    commandPath: "vault add-edge",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem", "registry"],
    note: "Writes the canonical vault edge and its registry projection.",
  },
  {
    operation: "vault-move",
    commandPath: "vault move",
    coverage: "deferred",
    sideEffects: ["filesystem", "registry"],
    note: "Moves the vault and rewrites local topology; replay work is later.",
  },
  {
    operation: "vault-rename",
    commandPath: "vault rename",
    coverage: "deferred",
    sideEffects: ["filesystem", "registry"],
    note: "Renames the vault and rewrites local topology; replay work is later.",
  },
  {
    operation: "vault-regen-context",
    commandPath: "vault regen-context",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem"],
    note: "Regenerates local context from canonical vault metadata.",
  },
  {
    operation: "vault-sync-metadata",
    commandPath: "vault sync-metadata",
    coverage: "handler-gated-non-replay",
    sideEffects: ["filesystem", "github"],
    note: "Apply mode updates GitHub metadata and can append the requested local audit log.",
  },
  {
    operation: "vault-freeze",
    commandPath: "vault freeze",
    coverage: "deferred",
    sideEffects: ["filesystem"],
    note: "Writes time-varying freeze state and a local sentinel; replay work is later.",
  },
  {
    operation: "vault-unfreeze",
    commandPath: "vault unfreeze",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem"],
    note: "Clears freeze state and its local sentinel idempotently.",
  },
  {
    operation: "vault-snapshot",
    commandPath: "vault snapshot",
    coverage: "deferred",
    sideEffects: ["git"],
    note: "Creates a timestamped local Git branch and optional snapshot commit; replay work is later.",
  },
  {
    operation: "vault-restore",
    commandPath: "vault restore",
    coverage: "handler-gated-non-replay",
    sideEffects: ["filesystem", "git"],
    note: "Restores the working tree and creates a local Git commit; force can discard local changes.",
  },
  {
    operation: "vault-share",
    commandPath: "vault share",
    coverage: "handler-gated-non-replay",
    sideEffects: ["github"],
    note: "Explicit confirmation changes GitHub repository access.",
  },
  {
    operation: "vault-unshare",
    commandPath: "vault unshare",
    coverage: "handler-gated-non-replay",
    sideEffects: ["github"],
    note: "Explicit confirmation removes GitHub repository access.",
  },
  {
    operation: "vault-invites",
    commandPath: "vault invites",
    coverage: "handler-gated-non-replay",
    sideEffects: ["github"],
    note: "The accept form explicitly confirms a GitHub invitation mutation.",
  },
  {
    operation: "vault-accept-share",
    commandPath: "vault accept-share",
    coverage: "handler-gated-non-replay",
    sideEffects: ["filesystem", "registry", "git", "github"],
    note: "Explicit confirmation accepts access, clones, and registers the shared vault.",
  },
  {
    operation: "mesh-join",
    commandPath: "mesh join",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem", "registry", "git"],
    note: "Clones and registers the mesh and its declared members locally.",
  },
  {
    operation: "mesh-subscribe",
    commandPath: "mesh subscribe",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem", "registry", "git"],
    note: "Clones and registers a subscribed vault locally.",
  },
  {
    operation: "mesh-adopt",
    commandPath: "mesh adopt",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem", "registry", "git"],
    note: "Adopts the selected remote cluster into local mesh state.",
  },
  {
    operation: "mesh-prune",
    commandPath: "mesh prune",
    coverage: "handler-gated-non-replay",
    sideEffects: ["filesystem", "registry"],
    note: "Explicit confirmation removes an empty or orphan mesh from local state.",
  },
  {
    operation: "mesh-add-edge",
    commandPath: "mesh add-edge",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem", "registry"],
    note: "Writes the canonical mesh edge and its registry projection.",
  },
  {
    operation: "mesh-rebuild-registry",
    commandPath: "mesh rebuild-registry",
    coverage: "canonical-state-idempotent",
    sideEffects: ["registry"],
    note: "Rebuilds registry mesh projections from canonical local manifests.",
  },
  {
    operation: "mesh-rebuild-rollup",
    commandPath: "mesh rebuild-rollup",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem", "editor-index"],
    note: "Rebuilds the local mesh rollup projection.",
  },
  {
    operation: "mesh-canvas",
    commandPath: "mesh canvas",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem"],
    note: "Writes the derived local mesh canvas artifact.",
  },
  {
    operation: "mesh-clone-all",
    commandPath: "mesh clone-all",
    coverage: "deferred",
    sideEffects: ["filesystem", "registry", "git"],
    note: "Clones and registers all accessible configured sources; replay work is later.",
  },
  {
    operation: "mesh-source-add",
    commandPath: "mesh source add",
    coverage: "canonical-state-idempotent",
    sideEffects: ["registry"],
    note: "Adds a configured vault source to the local registry.",
  },
  {
    operation: "mesh-source-remove",
    commandPath: "mesh source remove",
    coverage: "canonical-state-idempotent",
    sideEffects: ["registry"],
    note: "Removes a configured vault source from the local registry.",
  },
  {
    operation: "undo",
    commandPath: "undo",
    coverage: "legacy-operation-log",
    sideEffects: ["filesystem", "registry", "editor-index"],
    note: "Uses the existing operation log to reverse the recorded local capture boundary.",
  },
  {
    operation: "repair",
    commandPath: "repair",
    coverage: "handler-gated-non-replay",
    sideEffects: ["filesystem", "registry", "git"],
    note: "Apply mode performs the selected local repair plan; dry-run remains read-only.",
  },
  {
    operation: "reindex",
    commandPath: "reindex",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem", "editor-index"],
    note: "Rebuilds local search projections from canonical vault content.",
  },
  {
    operation: "alias",
    commandPath: "alias",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem", "registry"],
    note: "Set/remove modes update the pod-local alias register; list remains read-only.",
  },
  {
    operation: "pattern-install",
    commandPath: "pattern install",
    coverage: "deferred",
    sideEffects: ["filesystem"],
    note: "Copies a local pattern into the managed pattern store; overwrite replay is later.",
  },
  {
    operation: "pattern-uninstall",
    commandPath: "pattern uninstall",
    coverage: "handler-gated-non-replay",
    sideEffects: ["filesystem"],
    note: "Removes the managed pattern and can unlink it from vaults.",
  },
  {
    operation: "pattern-link",
    commandPath: "pattern link",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem"],
    note: "Creates the machine-local vault pattern link.",
  },
  {
    operation: "pattern-unlink",
    commandPath: "pattern unlink",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem"],
    note: "Removes the machine-local vault pattern link.",
  },
  {
    operation: "pattern-fork",
    commandPath: "pattern fork",
    coverage: "deferred",
    sideEffects: ["filesystem"],
    note: "Copies a managed pattern to a new local identity; replay work is later.",
  },
  {
    operation: "pattern-run",
    commandPath: "pattern run",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem", "editor-index"],
    note: "Writes the resolved template output and updates its local search projection.",
  },
  {
    operation: "skills-install",
    commandPath: "skills install",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem"],
    note: "Reconciles managed skill links/files into detected agent runtimes.",
  },
  {
    operation: "agent-manual-install",
    commandPath: "agent-manual",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem"],
    note: "Install mode replaces the managed manual marker block; preview remains read-only.",
  },
  {
    operation: "init",
    commandPath: "init",
    coverage: "planned-receipt-boundary",
    sideEffects: ["filesystem", "registry", "git"],
    note: "Composes fresh or existing-pod local bootstrap and reconciliation.",
  },
  {
    operation: "discover-auto",
    commandPath: "discover",
    coverage: "deferred",
    sideEffects: ["filesystem", "registry", "git"],
    note: "Auto mode can adopt or clone selected discovered clusters; ordinary discovery remains read-only.",
  },
  {
    operation: "vault-backfill",
    commandPath: "vault backfill",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem", "editor-index"],
    note: "Backfills canonical frontmatter and its local search projection.",
  },
  {
    operation: "vault-reconcile",
    commandPath: "vault reconcile",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem", "editor-index"],
    note: "Reconciles canonical frontmatter and its local search projection.",
  },
  {
    operation: "primer",
    commandPath: "primer",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem"],
    note: "Writes the derived local primer cache for the requested scope.",
  },
  {
    operation: "model-fetch",
    commandPath: "model fetch",
    coverage: "deferred",
    sideEffects: ["filesystem"],
    note: "Downloads and installs local semantic-model assets; replay work is later.",
  },
  {
    operation: "model-nudge",
    commandPath: "model nudge",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem"],
    note: "Mutating nudge forms update the local offer-state record; status remains read-only.",
  },
  {
    operation: "automator-run",
    commandPath: "automator run",
    coverage: "deferred",
    sideEffects: ["filesystem", "registry", "editor-index"],
    note: "Executes the selected automator's bounded local write pipeline.",
  },
  {
    operation: "federation-init",
    commandPath: "federation init",
    coverage: "deferred",
    sideEffects: ["filesystem", "registry", "git"],
    note: "Creates or adopts the local pod repository and registry identity.",
  },
  {
    operation: "federation-rebuild",
    commandPath: "federation rebuild",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem", "registry"],
    note: "Rebuilds local federation projections and manifests from canonical inputs.",
  },
  {
    operation: "federation-canvas",
    commandPath: "federation canvas",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem"],
    note: "Writes the derived local federation canvas artifact.",
  },
  {
    operation: "registry-reset",
    commandPath: "registry reset",
    coverage: "handler-gated-non-replay",
    sideEffects: ["filesystem", "registry"],
    note: "Explicit confirmation replaces the local machine registry.",
  },
  {
    operation: "registry-rebuild",
    commandPath: "registry rebuild",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem", "registry"],
    note: "Rebuilds the local registry from discovered canonical vault metadata.",
  },
  {
    operation: "identity-refresh",
    commandPath: "identity refresh",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem"],
    note: "Replaces the local authenticated-identity observation cache.",
  },
  {
    operation: "machine-role-enable",
    commandPath: "machine role enable",
    coverage: "canonical-state-idempotent",
    sideEffects: ["registry"],
    note: "Enables the selected machine role in local configuration.",
  },
  {
    operation: "machine-role-disable",
    commandPath: "machine role disable",
    coverage: "canonical-state-idempotent",
    sideEffects: ["registry"],
    note: "Disables the selected machine role in local configuration.",
  },
  {
    operation: "machine-config-region",
    commandPath: "machine config region",
    coverage: "canonical-state-idempotent",
    sideEffects: ["registry"],
    note: "Sets the local machine region configuration.",
  },
  {
    operation: "friction-note",
    commandPath: "friction note",
    coverage: "legacy-operation-log",
    sideEffects: ["registry"],
    note: "Appends a local friction record through the existing operational store.",
  },
  {
    operation: "friction-resolve",
    commandPath: "friction resolve",
    coverage: "canonical-state-idempotent",
    sideEffects: ["registry"],
    note: "Marks the selected local friction record resolved.",
  },
  {
    operation: "friction-false-positive",
    commandPath: "friction false-positive",
    coverage: "canonical-state-idempotent",
    sideEffects: ["registry"],
    note: "Marks the selected local friction record as a false positive.",
  },
  {
    operation: "capture-metric-record",
    commandPath: "capture-metric record",
    coverage: "legacy-operation-log",
    sideEffects: ["registry"],
    note: "Appends one local dogfood capture metric.",
  },
  {
    operation: "housekeep",
    commandPath: "housekeep",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem"],
    note: "Rotates the selected local YON ledger files at the bounded archive boundary.",
  },
  {
    operation: "audit-export",
    commandPath: "audit export",
    coverage: "canonical-state-idempotent",
    sideEffects: ["filesystem"],
    note: "Writes the requested bounded audit export file.",
  },
  {
    operation: "scoped-sync",
    coverage: "planned-receipt-boundary",
    sideEffects: ["filesystem", "registry", "git", "github"],
    note: "Includes local reconciliation and optional first online publication.",
  },
  {
    operation: "pod-sync",
    commandPath: "sync",
    coverage: "planned-receipt-boundary",
    sideEffects: ["filesystem", "registry", "git", "github"],
    note: "Pod-wide reconciliation can affect local state and online copies.",
  },
  {
    operation: "existing-pod-refresh",
    coverage: "planned-receipt-boundary",
    sideEffects: ["filesystem", "registry", "git"],
    note: "Refresh has local reconstruction and Git reconciliation boundaries.",
  },
  {
    operation: "update",
    commandPath: "update",
    coverage: "planned-receipt-boundary",
    sideEffects: ["filesystem", "npm"],
    note: "Update crosses managed local files and npm installation boundaries.",
  },
  {
    operation: "editor-localization-prepare",
    coverage: "planned-receipt-boundary",
    sideEffects: ["filesystem", "git", "editor-index"],
    note: "Prepare records a local plan and observes target Git/editor state.",
  },
  {
    operation: "editor-localization-apply",
    coverage: "planned-receipt-boundary",
    sideEffects: ["filesystem", "git", "editor-index"],
    note: "Apply changes only the approved target's local Git/editor state.",
  },
  {
    operation: "capture",
    commandPath: "capture",
    coverage: "legacy-operation-log",
    sideEffects: ["filesystem", "registry", "git"],
    note: "Existing capture operation log remains authoritative in 0.20.0.",
  },
  {
    operation: "vault-delete",
    commandPath: "vault delete",
    coverage: "handler-gated-non-replay",
    sideEffects: ["filesystem", "registry"],
    note: "Removes derived local state, updates registry/aliases, and writes federation manifest state locally.",
  },
  {
    operation: "vault-forget",
    commandPath: "vault forget",
    coverage: "handler-gated-non-replay",
    sideEffects: ["filesystem", "registry"],
    note: "Updates registry/known paths/aliases and writes federation manifest state locally while preserving vault content.",
  },
  {
    operation: "mesh-delete",
    coverage: "deferred",
    sideEffects: ["filesystem", "registry", "git", "github"],
    note: "Distributed mesh deletion is outside 0.20.0 scope.",
  },
] as const;
