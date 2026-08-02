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

export { initVault, plannedInitialScaffoldPaths } from "./scaffold/init.js";
export type { InitOptions, InitResult } from "./scaffold/init.js";
export { adoptVault } from "./scaffold/adopt.js";
export type { AdoptOptions, AdoptResult } from "./scaffold/adopt.js";
export { deleteVaultDerivedState } from "./scaffold/delete.js";
export type { DeleteScaffoldResult } from "./scaffold/delete.js";

export { initVaultFlow, HomeMeshNotFoundError, VaultAlreadyExistsError } from "./flows/init.js";
export type { InitFlowOptions, InitFlowResult, MeshSelfHealOptions } from "./flows/init.js";
export {
  deriveCreationOperationIdV1,
  derivePlannedCreationRid,
  plannedSingleVaultEffectsV1,
  resolveCreationPlanV1,
  withCreationRepositoryEffectsV1,
} from "./flows/creation-plan.js";
export type {
  CreationIntendedEffectsV1,
  CreationPlanV1,
  CreationSubjectFacts,
  DestinationRequest,
  ResolveCreationPlanV1Result,
  PlannedPodIdentityEffectV1,
} from "./flows/creation-plan.js";
export type { VaultCreationBinding } from "./flows/vault-init-preflight.js";
export {
  deriveVaultAliasRecommendation,
  observeVaultAliasRecommendation,
} from "./flows/alias-recommendation.js";
export type {
  AliasRecommendationReason,
  VaultAliasRecommendation,
} from "./flows/alias-recommendation.js";
export { observeActiveActor } from "./op/active-actor-observation.js";
export type { ActiveActorObservation } from "./op/active-actor-observation.js";
export {
  CreationMutationFailure,
  CreationMutationJournal,
  asCreationMutationFailure,
  cloneCreationMutationEvidence,
  creationCheckpointPathDigest,
  creationLocalMutationCount,
  emptyCreationMutationEvidence,
} from "./op/creation-mutation-journal.js";
export type {
  CreationMutationDelta,
  CreationMutationEvidence,
  CreationMutationFailureOptions,
  CreationRecoveryAction,
} from "./op/creation-mutation-journal.js";
export {
  inspectMeshInitPreflight,
  inspectRegistryTopologyPreflight,
  openMeshInitRegistryReadOnly,
} from "./flows/mesh-init-preflight.js";
export {
  finalizeInitialCheckpoint,
  recordInitialCheckpointPaths,
} from "./scaffold/local-checkpoint.js";
export type {
  InitialCheckpointContext,
  LocalCheckpointResult,
} from "./scaffold/local-checkpoint.js";
export {
  appendMeshHomeToFile,
  removeMeshHomeFromFile,
  updateMeshHomeNameInFile,
} from "./registry/vault-home-mesh-helpers.js";
export type {
  AppendMeshHomeArgs,
  RemoveMeshHomeArgs,
  UpdateMeshHomeNameArgs,
} from "./registry/vault-home-mesh-helpers.js";
export { adoptVaultFlow } from "./flows/adopt.js";
export type { AdoptFlowResult } from "./flows/adopt.js";
export { ensurePersonalMesh } from "./flows/ensure-personal-mesh.js";
export type {
  EnsurePersonalMeshArgs,
  EnsurePersonalMeshResult,
} from "./flows/ensure-personal-mesh.js";
export { joinVaultFlow } from "./flows/join.js";
export type { JoinResult } from "./flows/join.js";
export { cloneVaultFlow, CloneTargetMeshNotFoundError } from "./flows/clone.js";
export type { CloneOptions, CloneResult } from "./flows/clone.js";
export {
  BranchVsSoloPromptRequiredError,
  MoveMainVaultForbiddenError,
  MoveSameMeshError,
  MoveTargetMeshNotFoundError,
  MoveVaultNotFoundError,
  moveVaultFlow,
} from "./flows/move.js";
export type {
  DroppedEdgeSummary,
  MoveVaultArgs,
  MoveVaultMode,
  MoveVaultResult,
  ReRootedEdgeSummary,
} from "./flows/move.js";
export {
  MainVaultImmutableError,
  RenameVaultNotFoundError,
  renameVaultFlow,
  VaultNameTakenError,
} from "./flows/rename.js";
export type { RenameVaultArgs, RenameVaultResult } from "./flows/rename.js";
export { listVaultsFlow, formatHumanTable } from "./flows/list.js";
export type { ListFlowOptions, ListFlowResult, RollupTombstoneAggregate } from "./flows/list.js";
export { infoVaultFlow, formatBytes } from "./flows/info.js";
export type { InfoFlowResult } from "./flows/info.js";
export { openVaultFlow } from "./flows/open.js";
export type { OpenFlowResult } from "./flows/open.js";
export { forgetVaultFlow } from "./flows/forget.js";
export type { ForgetFlowResult } from "./flows/forget.js";
export { disconnectVaultFlow } from "./flows/disconnect.js";
export type { DisconnectFlowResult } from "./flows/disconnect.js";
export { deleteVaultFlow } from "./flows/delete.js";
export type { DeleteFlowResult } from "./flows/delete.js";
export { abandonVaultFlow } from "./flows/abandon.js";
export type { AbandonFlowResult, AbandonVaultOpts } from "./flows/abandon.js";
export { registryRebuildFlow } from "./flows/rebuild.js";
export type { RebuildFlowResult } from "./flows/rebuild.js";
export { registryResetFlow } from "./flows/registry-reset.js";
export type {
  RegistryResetArgs,
  RegistryResetResult,
  RegistryResetSkippedEntry,
} from "./flows/registry-reset.js";
export {
  verifyVaultsFlow,
  resolveTombstoneThreshold,
  DEFAULT_TOMBSTONE_THRESHOLD,
  TOMBSTONE_THRESHOLD_ENV,
} from "./flows/verify.js";
export type { VerifyFlowOptions, VerifyFlowResult, VerifyTransition } from "./flows/verify.js";
export { reconnectVaultFlow } from "./flows/reconnect.js";
export type { ReconnectFlowArgs, ReconnectFlowResult } from "./flows/reconnect.js";
export { addEdgeFlow } from "./flows/add-edge.js";
export type { AddEdgeArgs, AddEdgeResult, AddEdgeKind } from "./flows/add-edge.js";
export {
  addMeshEdgeFlow,
  AddMeshEdgeMainVaultMissingError,
  AddMeshEdgeNoHomeMeshError,
  AddMeshEdgeVaultNotFoundError,
} from "./flows/add-mesh-edge.js";
export type {
  AddMeshEdgeArgs,
  AddMeshEdgeEdgeSummary,
  AddMeshEdgeResult,
  AddMeshEdgeResultStatus,
} from "./flows/add-mesh-edge.js";
export { MeshValidateNotFoundError, validateMeshEdgesFlow } from "./flows/mesh-validate.js";
export type {
  MeshEdgeFinding,
  MeshFileFinding,
  MeshSubscriptionFinding,
  ValidateMeshEdgesArgs,
  ValidateMeshEdgesResult,
} from "./flows/mesh-validate.js";
export {
  defaultGhUrlForVaultName,
  subscribeFlow,
  SubscribeMainVaultMissingError,
  SubscribeVaultNotFoundError,
  SubscribeNoCoordinateError,
} from "./flows/subscribe.js";
export type {
  SubscribeArgs,
  SubscribeCloneArgs,
  SubscribeCloneFn,
  SubscribeCloneOutcome,
  SubscribeCloneResult,
  SubscribeResult,
  SubscribeResultStatus,
} from "./flows/subscribe.js";
export {
  computeAutoDecisions,
  discoverFlow,
  DiscoverGhUnavailableError,
  orchestrateClusters,
  shouldOfferBatchFastPath,
  UNCLUSTERED_MESH_NAME,
} from "./flows/discover.js";
export type {
  Cluster,
  ClusterDecision,
  ClusterMember,
  ClusterMemberRepo,
  ClusterOutcome,
  ClusterOutcomeStatus,
  DiscoverArgs,
  DiscoverResult,
  OrchestrateClustersArgs,
  OrchestrateClustersResult,
} from "./flows/discover.js";
export { buildDiscoverCommand } from "./commands/discover.js";
export {
  checkPushPermission,
  fetchVaultYonContent,
  getDefaultGhExecutor,
  walkUserRepos,
} from "./util/gh-discover.js";
export type { DiscoveredRepo, GhExecutor } from "./util/gh-discover.js";
export {
  AdoptClusterNotFoundError,
  ClusterAlreadyRegisteredError,
  PushPermissionDeniedError,
  meshAdoptClusterFlow,
  observeMeshAdoptCreationEvidence,
} from "./flows/mesh-adopt-cluster.js";
export type {
  AdoptActorObserver,
  AdoptCloneFn,
  AdoptClusterArgs,
  AdoptClusterCloneArgs,
  AdoptClusterCloneResult,
  AdoptClusterResult,
  AdoptedMemberSummary,
  MeshAdoptCreationEvidence,
} from "./flows/mesh-adopt-cluster.js";
export { buildMeshAdoptSubcommand } from "./commands/mesh-adopt.js";
export {
  GitHistoryEmptyError,
  OrphanReattachMeshNotFoundError,
  OrphanReattachMissingArgError,
  RepairTargetNotFoundError,
  RestoreParseFailedError,
  repairFlow,
  resolveTargetMeshOrThrow,
  resolveVaultTarget,
  listRegisteredMeshNames,
} from "./flows/repair.js";
export type {
  RepairAction,
  RepairActionKind,
  RepairArgs,
  RepairFinding,
  RepairFindingClass,
  RepairMode,
  RepairResult,
} from "./flows/repair.js";
export { buildRepairCommand } from "./commands/repair.js";
// v1.G.5 — agent-manual flow + command surface.
export {
  AGENT_MANUAL_RUNTIMES,
  AgentManualMalformedMarkersError,
  AgentManualUnsafeRuntimeError,
  detectInstalledRuntimes,
  generateAgentManual,
  INSTALLABLE_RUNTIMES,
  makeMarkerBegin,
  makeMarkerEnd,
  parseAgentManualRuntime,
  replaceMarkerBlock,
  resolveRuntimeDestination,
  wrapInMarker,
} from "./flows/agent-manual.js";
export type {
  AgentManualArgs,
  AgentManualResult,
  AgentManualRuntime,
} from "./flows/agent-manual.js";
export {
  AGENT_MANUAL_MAX_WORDS,
  composeManagedManualMarker,
  inspectManagedManualMarker,
  countGuidanceWords,
} from "./flows/agent-guidance.js";
export type { ManagedMarkerComposition } from "./flows/agent-guidance.js";
export { buildAgentManualCommand } from "./commands/agent-manual.js";
// stay-current slice — version-currency core shared by `outdated`/`update`
// (lyt meta CLI) + doctor + init.
export {
  checkCurrency,
  CURRENCY_CACHE_TTL_MS,
  CURRENCY_DIST_TAG,
  CURRENCY_PACKAGE,
  formatCurrencyLine,
  isUpdateChannel,
  isNewerVersion,
  inspectCurrencyStateV1,
  normalizeRegistryUrl,
  readUpdateChannel,
  resolveUpdateAction,
  UPDATE_CHANNELS,
  updateCommandString,
  writeUpdateChannel,
} from "./flows/currency.js";
export type {
  CommandRunner,
  CurrencyOptions,
  CurrencyResult,
  CurrencyStateInspectionV1,
  UpdateChannel,
  UpdateChannelPreference,
  UpdateAction,
} from "./flows/currency.js";
// v1.G.4 — setup wizard surface (runWizard + IPromptHandler default impl).
// Consumed by packages/lyt/src/commands/init.ts via `lyt init --wizard`.
// Release review Arch-M1 fix-pass: the 10 individual phase functions are NOT
// exported here — they are wizard-internal. Tests import them via the
// `../../src/flows/wizard.js` relative path, keeping the public surface
// minimal (runWizard is the only public entry).
export { ReadlinePromptHandler, runWizard } from "./flows/wizard.js";
export type {
  AgentRuntimeChoice,
  IPromptHandler,
  WizardPhaseResult,
  WizardRunOptions,
  WizardRunResult,
} from "./flows/wizard.js";
export {
  currentPlatform,
  detectTool,
  getInstallerCommand,
  getManualInstallUrl,
  installTool,
} from "./util/installer.js";
export type {
  DetectToolResult,
  InstallToolResult,
  Platform as InstallerPlatform,
  Tool as InstallerTool,
} from "./util/installer.js";
export {
  enumerateMeshYonRevisions,
  getDefaultGitExecutor,
  readMeshYonAtRevision,
} from "./util/git-history.js";
export type { GitExecutor } from "./util/git-history.js";
export { removeMeshEdge } from "./registry/mesh-edges-repo.js";
export { regenContextFlow } from "./flows/regen-context.js";
export type { RegenContextResult } from "./flows/regen-context.js";
export { rebuildVaultIndexFlow } from "./flows/rebuild-index.js";
export type { RebuildIndexArgs, RebuildIndexResult } from "./flows/rebuild-index.js";
export {
  migrateVaultGitignoreIndexRule,
  ensureSyncProvenancePendingIgnored,
} from "./flows/migrate-gitignore.js";
export type { MigrateGitignoreResult } from "./flows/migrate-gitignore.js";
export {
  rebuildLanesFlow,
  parseFrontmatterTags,
  slugifyTag,
  DEFAULT_LANE_THRESHOLD,
} from "./flows/rebuild-lanes.js";
export type { RebuildLanesArgs, RebuildLanesResult } from "./flows/rebuild-lanes.js";
export { rebuildRollupFlow, ROLLUP_DISCONNECTED_DAYS } from "./flows/rebuild-rollup.js";
export type { RebuildRollupArgs, RebuildRollupResult } from "./flows/rebuild-rollup.js";
export { rebuildMeshRollupFlow, MeshRollupMeshNotFoundError } from "./flows/rebuild-mesh-rollup.js";
export type {
  RebuildMeshRollupArgs,
  RebuildMeshRollupResult,
  MeshRollupOutcome,
  MeshRollupVaultOutcome,
  MeshRollupVaultStatus,
} from "./flows/rebuild-mesh-rollup.js";
export {
  upsertRollup,
  listRollupByTarget,
  listAllRollup,
  countTombstonedRollupForTarget,
  latestTombstoneSeenForTarget,
  deleteAllRollup,
  deleteAllRollupForTarget,
} from "./registry/rollup-repo.js";
export type { RollupRow, UpsertRollupArgs } from "./registry/rollup-repo.js";
export {
  rebuildArcsFlow,
  parseFrontmatterArcs,
  slugifyArcName,
  ArcPositionCollisionError,
} from "./flows/rebuild-arcs.js";
export type { RebuildArcsArgs, RebuildArcsResult } from "./flows/rebuild-arcs.js";
export { auditExportFlow } from "./flows/audit-export.js";
export type { AuditExportArgs, AuditExportResult } from "./flows/audit-export.js";
export { buildAuditCommand } from "./commands/audit.js";
export { buildHousekeepCommand } from "./commands/housekeep.js";
export { housekeepFlow, KNOWN_LEDGERS } from "./flows/housekeep.js";
export type {
  HousekeepArgs,
  HousekeepResult,
  HousekeepRotationReport,
  LedgerName,
} from "./flows/housekeep.js";
export { upsertLedgerCache } from "./flows/sync-post-pull-ledger.js";
export type { UpsertLedgerCacheResult } from "./flows/sync-post-pull-ledger.js";
export { upsertLanesCache } from "./flows/upsert-lanes-cache.js";
export type { UpsertLanesCacheResult, UpsertLanesCacheOpts } from "./flows/upsert-lanes-cache.js";
export {
  insertLane,
  insertLaneMember,
  deleteAllLanes,
  getLaneByRid,
  getLaneByName,
  listLanes,
  listMembersByLane,
  laneSlugToRidBytes,
} from "./registry/lanes-repo.js";
export type { LaneRow, LaneMemberRow, InsertLaneArgs } from "./registry/lanes-repo.js";
export { upsertArcsCache } from "./flows/upsert-arcs-cache.js";
export type { UpsertArcsCacheResult, UpsertArcsCacheOpts } from "./flows/upsert-arcs-cache.js";
export {
  insertArc,
  insertArcMember,
  deleteAllArcs,
  getArcByRid,
  getArcByName,
  listArcs,
  listMembersByArc,
  listMembershipByFigment,
  arcSlugToRidBytes,
} from "./registry/arcs-repo.js";
export type { ArcRow, ArcMemberRow, InsertArcArgs } from "./registry/arcs-repo.js";
export { rebuildFtsFlow } from "./flows/rebuild-fts.js";
export type { RebuildFtsArgs, RebuildFtsResult } from "./flows/rebuild-fts.js";
export {
  upsertFtsCache,
  stripFrontmatter,
  stripCodeFences,
  extractWikilinks,
  extractFtsBody,
  parseFigmentDates,
  parseFigmentTopicTags,
  isScaffoldNote,
  toVaultRelPosix,
} from "./flows/upsert-fts-cache.js";
export { parseFigmentTitle } from "./util/figment-title.js";
export type {
  UpsertFtsCacheResult,
  UpsertFtsCacheOpts,
  ExtractedFtsBody,
  FigmentDates,
  FigmentTopicTags,
} from "./flows/upsert-fts-cache.js";
export {
  insertFtsDoc,
  deleteAllFts,
  deleteFtsByPath,
  upsertFtsDocByPath,
  countFtsDocs,
  searchFts,
  searchTitleFts,
  normalizeTitle,
} from "./registry/fts-repo.js";
export type { FtsHitRow, InsertFtsDocArgs, TitleFtsHitRow } from "./registry/fts-repo.js";
// Lane V Phase 0 (0.3) — figment_edges cache repo (parsed wikilink/embed
// targets pulled out of the FTS body; foundation for the A5 graph arm).
export {
  deleteAllEdges,
  deleteEdgesByPath,
  replaceEdgesForFigment,
  countEdges,
} from "./registry/figment-edges-repo.js";
export type { FigmentEdge, FigmentEdgeKind } from "./registry/figment-edges-repo.js";
// Lane V Phase 0 (0.4) — figment_meta cache repo (per-figment frontmatter
// authored-time; fixes V-F16 recent-activity + V-F9 decay).
export {
  upsertFigmentMeta,
  deleteAllMeta,
  deleteMetaByPath,
  countMeta,
  loadModifiedByPath,
  listRecentFigments,
  // V-C-1 SC3 option-b — primer keyword fallback source (topic/tags aggregate).
  loadKeywordSignals,
  // C10 — distinct-topics source for the capture topic picker.
  listDistinctTopics,
} from "./registry/figment-meta-repo.js";
export type {
  FigmentMeta,
  RecentFigmentRow,
  KeywordSignal,
  TopicCount,
} from "./registry/figment-meta-repo.js";
// C10 — the topic-picker read flow ( vault name -> distinct topics ).
export { listVaultTopicsFlow } from "./flows/list-vault-topics.js";
// Phase E (Unit 2 wiring) — the C10 picker's SEMANTIC upgrade: re-rank existing
// topics by similarity to the figment when the model is present; degrade to the
// frequency order otherwise (read-never-fetches).
export { rankVaultTopicsFlow } from "./flows/rank-vault-topics.js";
export type { RankVaultTopicsArgs, RankVaultTopicsResult } from "./flows/rank-vault-topics.js";
// Lane V Phase 0 (0.5 / C1-C3) — all-tiers rebuild umbrella + pod/mesh/vault reindex.
export { rebuildVaultFlow } from "./flows/rebuild-vault.js";
export type {
  RebuildVaultArgs,
  RebuildVaultResult,
  EmbeddingsBuildProgress,
} from "./flows/rebuild-vault.js";
export { reindexFlow } from "./flows/reindex.js";
export type { ReindexArgs, ReindexResult, ReindexScope } from "./flows/reindex.js";
// Inc-2 Phase B / lazy repair for already-commingled foreign vaults.
export { repairForeignHomingFlow } from "./flows/repair-foreign-homing.js";
export type {
  RepairForeignHomingArgs,
  RepairForeignHomingResult,
  RelocatedForeignVault,
} from "./flows/repair-foreign-homing.js";
// B2a (Inc-2 Phase B slice 2 / M1) — org-mesh vault origin-owner repair. Wired
// into repairFlow as the `mis-owned-origin` finding class; also exported for
// direct invocation.
export { repairVaultOriginOwnerFlow } from "./flows/repair-vault-origin-owner.js";
export type {
  RepairVaultOriginOwnerArgs,
  RepairVaultOriginOwnerResult,
  RepointedOrigin,
} from "./flows/repair-vault-origin-owner.js";
// Phase D (0.10.0 frontmatter-contract lane) — disk↔index + frontmatter-contract
// DETECT primitives (pure, read-only; the meta CLI's backfill/reconcile verbs +
// the doctor check consume these). The HEAL side lives in @younndai/lyt.
export {
  scanFrontmatterContract,
  scanUnindexedFigments,
  reconcileVaultScan,
  migrateFrontmatterTo,
  migrateFrontmatterToCurrent,
  FRONTMATTER_MIGRATORS,
} from "./flows/reconcile-frontmatter.js";
export type {
  FrontmatterContractIssue,
  FrontmatterContractScan,
  UnindexedScan,
  ReconcileScan,
  FrontmatterMigrationCandidate,
  FrontmatterMigrator,
  FrontmatterMigrationResult,
} from "./flows/reconcile-frontmatter.js";
// Phase E (0.10.0 frontmatter-contract lane) — tag/topic enrichment +
// in-vault suggested-links. Pure primitives (Unit 1 model-free tags, Unit 3
// model-free links) + the model-boundary Unit 2 (topic-classify degrades to
// blank when the embedder is absent). HEAL/write side is the meta @younndai/lyt
// CLI + capture surface, mirroring reconcile-frontmatter's detect/heal split.
export {
  suggestFigmentTags,
  DEFAULT_MAX_FIGMENT_TAGS,
  MIN_TAG_LEN,
} from "./enrich/figment-tags.js";
export type { SuggestFigmentTagsOptions } from "./enrich/figment-tags.js";
export {
  classifyTopic,
  precomputeTopicLabelVectors,
  TOPIC_MIN_CONFIDENCE,
} from "./enrich/topic-classify.js";
export type {
  RankedTopic,
  ClassifyTopicResult,
  ClassifyTopicOptions,
} from "./enrich/topic-classify.js";
// Phase E.1 — suggested-links (Unit 3) is DESCOPED from the public barrel: the
// module is built + unit-tested but has ZERO production callers (a dead public
// API). It is intentionally NOT re-exported here until a fast-follow wires the
// ACCEPT→edge write into the capture surface. The module + its tests stay in-tree
// (tests import it by relative path). See enrich/suggested-links.ts header.
// Phase E Unit 3 — the VERSIONED `lyt reindex --json` schema (zod), shared
// by the command emit-path AND the agent skill consumer (single source). Carries
// model + index + nudge-trace; the schema is itself the Unit-3 test target.
export {
  ReindexJsonSchema,
  REINDEX_JSON_SCHEMA_VERSION,
  buildReindexJson,
} from "./util/reindex-json-schema.js";
export type {
  ReindexJson,
  ReindexJsonModelFacet,
  ReindexJsonVaultEntry,
} from "./util/reindex-json-schema.js";
export { NudgeDecisionTraceSchema } from "./util/nudge-json-schema.js";
export type { NudgeDecisionTraceJson } from "./util/nudge-json-schema.js";
// Lane M Wave 0 (P0-a/P0-c) — couple capture (and any figment write) to
// the derived FTS5 + provenance caches via a single incremental reconcile
// entry point, plus a one-time full-walk backfill heal for existing pods.
export {
  reconcileFigmentWrite,
  RECONCILE_PROVENANCE_SRC,
} from "./flows/reconcile-figment-write.js";
export type {
  ReconcileFigmentOp,
  ReconcileFigmentWriteArgs,
  ReconcileFigmentWriteOptions,
  ReconcileFigmentWriteResult,
} from "./flows/reconcile-figment-write.js";
export { backfillFigmentCaches } from "./flows/backfill-figment-caches.js";
export type { BackfillFigmentCachesResult } from "./flows/backfill-figment-caches.js";
// Phase A (UNIT 3 / C4) — maintain the figment `modified` frontmatter on a
// content change (fs-mtime keyed, floored-second, clamped `>= created`;
// `created` preserved). The write / sync-watch path invokes this before
// reconciling so the index picks up the advanced date.
export { maintainModifiedFromMtime, mtimeToFlooredIso } from "./flows/maintain-modified.js";
export type { MaintainModifiedResult } from "./flows/maintain-modified.js";
// V-C-1 (Lane V Track C) — index-on-write (L1): the single seam every capture
// path calls after writing a figment so search/recall/primer hit with NO manual
// reindex (FTS reconcile + per-vault lanes/arcs; cross-vault rollup deferred).
export { captureIndexFlow } from "./flows/capture-index.js";
export type { CaptureIndexArgs, CaptureIndexResult } from "./flows/capture-index.js";
// Increment 1 · Phase A — the safe-write spine (op/): the Operation contract, the
// append-only op-log, per-verb Receipt verification, the capture Operation, and
// the undo engine behind `lyt undo`. Consumed by the lyt CLI package.
export { defaultInverseForHorizon } from "./op/operation.js";
export type {
  Operation,
  SyncHorizon,
  Inverse,
  UndoAction,
  Preview,
  Receipt,
} from "./op/operation.js";
export {
  openOpLog,
  closeOpLog,
  getOpLogPath,
  appendPendingOp,
  markOpApplied,
  markOpAborted,
  readLastAppliedOp,
  readPendingOps,
  listOps,
  countOps,
} from "./op/operation-log.js";
export type { OpLogInput, OpLogRow, OpStatus } from "./op/operation-log.js";
export {
  OP_LOG_SCHEMA_VERSION,
  OP_LOG_UPGRADE_REQUIRED,
  OpLogUpgradeRequiredError,
  migrateOperationLog,
} from "./op/operation-log-migrations.js";
export {
  ReceiptRepositoryError,
  beginReceiptAttempt,
  finalizeReceiptAttempt,
  readReceiptAttempt,
  readReceiptAttemptState,
  resumePendingReceiptAttempt,
  queryReceiptAttempts,
  listReceiptAttemptSummaries,
  countReceiptOperations,
  countReceiptAttempts,
} from "./op/receipt-repository.js";
export type {
  BeginReceiptAttemptResult,
  ReceiptAttemptQuery,
  ReceiptAttemptSummary,
  StoredReceiptV1,
} from "./op/receipt-repository.js";
export {
  inspectReceiptAttempt,
  openReceiptAttempt,
  reopenReceiptAttempt,
} from "./op/receipt-attempt.js";
export type {
  OpenReceiptAttemptResult,
  ReceiptAttemptAdapterDependencies,
  ReceiptAttemptSession,
  ReceiptAttemptWarningCode,
} from "./op/receipt-attempt.js";
export { CaptureOperation } from "./op/operations/capture-op.js";
export type { CaptureInput, CaptureOperationDeps } from "./op/operations/capture-op.js";
// 0.13.0 — small caller-supplied lifecycle callbacks for programmatic
// composition. No discovery, registry, subprocess loading, or layer vocabulary.
export { AfterOperationHookError, applyOperation } from "./hooks.js";
export type {
  AfterOperationEvent,
  AfterOperationHook,
  DoctorChecksHook,
  LytLifecycleHooks,
} from "./hooks.js";
export { undoLast, previewUndo } from "./op/undo.js";
export type { UndoDeps, UndoOutcome } from "./op/undo.js";
// makeReceipt is the canonical Receipt constructor for Operation implementers —
// exported so an Operation living in ANOTHER package (A.4 SyncOperation, home =
// lyt-mesh) can build a Receipt without reaching into op/receipt.ts internals.
export { makeReceipt } from "./op/receipt.js";
// Lyt 0.20 Receipt V1 is additive. The legacy Operation Receipt above remains
// exported unchanged for 0.13 consumers.
export {
  RECEIPT_V1_SCHEMA_ID,
  RECEIPT_V1_MAJOR,
  RECEIPT_V1_MINOR,
  ReceiptV1ProducerSchema,
  ReceiptV1ConsumerSchema,
  parseReceiptV1ForEmission,
  consumeReceiptV1,
} from "./op/receipt-v1.js";
export type {
  ReceiptV1,
  ReceiptV1Consumption,
  UnsupportedReceiptSchema,
  InvalidReceipt,
} from "./op/receipt-v1.js";
export { PHASE_A_REPLAY_INVENTORY } from "./op/replay-contract.js";
export type {
  ReplayCoverage,
  PhaseALifecycleMutation,
  ReplayBoundaryDeclaration,
} from "./op/replay-contract.js";
// Increment 1 · Phase A firewall-C1 fix-pass — the git-error FIREWALL narrator,
// barrel-exported so a cross-package boundary renderer (the lyt-mesh sync flow's
// allowFailure push/pull/fetch paths) can narrate a raw git/gh failure into
// plain sense at the render boundary — not only on the THROW path the spawn
// wrappers already decorate (A.G release review C1). `firewall`/`isFirewalled` ride
// along for callers that decorate a thrown error rather than a resolved stderr.
export { narrate, firewall, isFirewalled } from "./util/git-error-firewall.js";
// 0.12.0 Phase D · A6 — the share-revoke access-loss classifier + narration
// (same firewall class). The sync / sync --check / vault info surfaces call
// these to detect a revoked-access `Repository not found` / 404 and surface a
// plain "access removed" message instead of a raw git noun or a stale `active`.
export { isAccessRemoved, narrateAccessRemoved } from "./util/git-error-firewall.js";
export type {
  NarratedError,
  FirewalledError,
  BoundaryCategory,
} from "./util/git-error-firewall.js";
// Increment 1 · Phase A a review finding fix-pass — the op-level audit adapter: maps an
// Operation + its verified Receipt onto recordAudit's fixed schema. Exported so
// a CLI caller (capture's `captureThroughOp`) can wire the audit sink that was
// previously dark (the seam existed but no caller passed it).
export { recordOperationAudit } from "./op/op-audit.js";
export type { OpAuditTarget } from "./op/op-audit.js";
// Increment 1 · Phase A.4 — the RemoteProvider port (git-remote seam): the
// gh-agnostic push/pull primitive returning STRUCTURED results, so the
// SyncOperation's honest-none horizon is read back from the actual push result,
// never asserted from the verb. GitRemoteProvider = the v1 github-backed default
// wrapping the firewalled runGit; non-GitHub slot reserved.
export { GitRemoteProvider } from "./remote/remote-provider.js";
export type {
  RemoteProvider,
  PushResult,
  PushTarget,
  PullTarget,
  PullResult,
  GitRunnerFn,
} from "./remote/remote-provider.js";
// v1.G.2 writability derivation + the 0.9.3 write-gate. `deriveWriteGate`
// is the shared capture/sync/publish refusal decision, keyed on the LIVE
// writability verdict (it replaced the too-narrow `isPureSubscriberVault`, which
// missed foreign-mesh subscriptions). `hasSubscriptionSignal` is the local,
// no-network pre-filter that keeps the capture hot path (own vaults) probe-free.
// `isPureSubscriberVault` remains exported as a (now legacy) helper.
export {
  deriveVaultWritable,
  deriveLocalWritable,
  deriveWriteGate,
  hasSubscriptionSignal,
  isPureSubscriberVault,
  loadRoleSummary,
  __clearWritabilityCache,
} from "./flows/writability.js";
export type {
  WritabilityVerdict,
  LocalWritability,
  WriteGate,
  DeriveVaultWritableOpts,
  RoleSummary,
} from "./flows/writability.js";
// 0.9.3 — `lyt vault refresh`: force a live gh re-probe of write access.
export { refreshVaultWritableFlow } from "./flows/vault-refresh.js";
export type { RefreshWritabilityResult } from "./flows/vault-refresh.js";
// keystone Phase B — the AccessProvider port (auth-primitive seam) +
// its gh-backed default impl. Interface only in B-auth.0: GhAccessProvider is
// behavior-preserving delegation onto deriveWriteGate / resolveVault /
// getIdentity; no callers are moved onto the port yet (later phase). The
// grant/revoke mutate seam is declared but throws until Phase C.
export { GhAccessProvider } from "./access/gh-access-provider.js";
export type { AccessProvider, Caller } from "./access/access-provider.js";
// hardening pass / C1 (Cohort-1 fix-pass release review) — the ONE shared `git push`
// permission-denied classifier. Both push paths (lyt-mesh `sync` + lyt-vault
// `reconcile-publish`) import THIS copy; the duplicate in-file copies were
// deleted. Terminal only on a genuine permission/auth co-signal; default
// non-terminal (retry-safe) so a transient 403 rate-limit / SSH timeout is
// retried, never dropped from the capless outbox.
export { isPermissionDeniedPush } from "./util/push-classify.js";
// V-C-1 Phase B (L2) — reindex-on-inbound: all-tier rebuild + watermark for a
// brought-in vault (adopt / subscribe). Closes V-B-6 (FTS-only inbound index).
export { reindexInboundVault } from "./flows/reindex-inbound.js";
export type { ReindexInboundArgs, ReindexInboundResult } from "./flows/reindex-inbound.js";
// V-C-1 (L3 input) — per-vault index watermark read/write for the empty-result
// self-heal staleness signal.
export {
  getIndexWatermarkPath,
  readIndexWatermark,
  writeIndexWatermark,
} from "./util/index-watermark.js";
export {
  searchCascadeFlow,
  SEARCH_CONFIDENCE_TIER_0,
  SEARCH_CONFIDENCE_TIER_1,
  SEARCH_CONFIDENCE_TIER_2,
  SEARCH_CONFIDENCE_TIER_3,
  SOFT_TIER_ALPHA,
  KEYPHRASE_BETA,
  FUSION_BLEND_HI,
  FUSION_BLEND_MID,
  FUSION_KEEP_N_FALLBACK,
  FUSION_ADAPTIVE,
  MEANING_CANDIDATE_CAVEAT,
} from "./flows/search-cascade.js";
// feat/microrag-semantic — OPTIONAL local dense-embedding retrieval arm.
export {
  loadEmbedder,
  cosine,
  vectorToBlob,
  blobToVector,
  embeddingsCacheDir,
  modelCachePresent,
  // Phase E — the automator enrich path (metadata-filler) gates its embedder
  // load on modelCachePresent() || embedderMemoized() (mirrors rankVaultTopicsFlow),
  // so the barrel must surface embedderMemoized too.
  embedderMemoized,
  semanticEvicted,
  isEmbeddingsInteractive,
  __resetEmbedderCache,
  __setTestEmbedder,
  EMBEDDING_DIM,
  EMBEDDING_MODEL_ID,
} from "./util/embeddings.js";
export type { Embedder, EmbedderLoad } from "./util/embeddings.js";
// Phase E Unit 2 — embeddings-build progress surface (phase labels +
// download/embed line formatters). Pure; the CLI spinner consumes these.
export {
  embeddingsPhaseLabel,
  formatDownloadProgress,
  formatEmbedProgress,
} from "./util/embeddings-progress.js";
export type { EmbeddingsBuildPhase } from "./util/embeddings-progress.js";
export { embeddingsEnabled } from "./util/config.js";
export {
  deleteAllEmbeddings,
  deleteEmbeddingByPath,
  upsertEmbeddingForFigment,
  countEmbeddings,
  loadAllEmbeddings,
} from "./registry/embeddings-repo.js";
export type { EmbeddingRow } from "./registry/embeddings-repo.js";
export { rebuildEmbeddingsFlow } from "./flows/rebuild-embeddings.js";
export type { RebuildEmbeddingsArgs, RebuildEmbeddingsResult } from "./flows/rebuild-embeddings.js";
export { upsertEmbeddingsCache } from "./flows/upsert-embeddings-cache.js";
export type {
  UpsertEmbeddingsCacheResult,
  UpsertEmbeddingsCacheOpts,
} from "./flows/upsert-embeddings-cache.js";
// Phase C (C4, F-C.1) — interactive-only embeddings offer at init.
export {
  embeddingsOfferGate,
  EMBEDDINGS_OFFER_PROMPT,
  EMBEDDINGS_OFFER_DECLINE_HINT,
  EMBEDDINGS_OFFER_FETCHED,
  EMBEDDINGS_OFFER_FETCH_FAILED,
} from "./flows/embeddings-offer.js";
// Phase D Slice 2a — the idempotent-offer-surface resolver (separate
// module so embeddings-offer.ts stays clean of nudge-state symbols).
export { resolveAskedState } from "./flows/embeddings-offer-state.js";
export type { EmbeddingsOfferArgs, EmbeddingsOfferOutcome } from "./flows/embeddings-offer.js";
export { fuseDense } from "./flows/search-cascade.js";
export type {
  SearchCascadeArgs,
  SearchCascadeResult,
  SearchCascadeScope,
  SearchResult,
  SearchTrace,
  NudgeDecisionTrace,
  DenseCandidate,
} from "./flows/search-cascade.js";
export { createQueryEngine, searchMesh, searchPod, searchVault } from "./flows/query-engine.js";
export type { Hits, QueryEngine } from "./flows/query-engine.js";
export { generatePrimerFlow, HALF_LIFE_DAYS } from "./flows/primer-generator.js";
export type {
  PrimerGenerateArgs,
  PrimerGenerateResult,
  PrimerScope,
  PrimerKeyword,
  PrimerArc,
  PrimerActivity,
  PrimerLane,
} from "./flows/primer-generator.js";
export {
  frictionNoteFlow,
  frictionReportFlow,
  frictionResolveFlow,
  frictionFalsePositiveFlow,
  FRICTION_TIER_A_THRESHOLD,
  FRICTION_REPORT_DEFAULT_WINDOW_MS,
} from "./flows/friction.js";
export type {
  FrictionNoteArgs,
  FrictionNoteResult,
  FrictionReportArgs,
  FrictionReportResult,
  FrictionRowSummary,
  FrictionMutateArgs,
  FrictionMutateResult,
} from "./flows/friction.js";
export { buildFrictionCommand } from "./commands/friction.js";
export { provenanceTraceFlow } from "./flows/provenance-trace.js";
export type {
  ProvenanceTraceArgs,
  ProvenanceTraceResult,
  ProvenanceEntry,
  ProvenanceTargetType,
} from "./flows/provenance-trace.js";
export { buildProvenanceCommand } from "./commands/provenance.js";
export { captureMetricRecordFlow, parseCaptureMetricPayload } from "./flows/capture-metric.js";
export type { CaptureMetricPayload, CaptureMetricRecordResult } from "./flows/capture-metric.js";
export { buildCaptureMetricCommand } from "./commands/capture-metric.js";
export { syncMetadataFlow } from "./flows/sync-metadata.js";
export type {
  SyncMetadataArgs,
  SyncMetadataMode,
  SyncMetadataResult,
  SyncMetadataScope,
  SyncMetadataVaultReport,
} from "./flows/sync-metadata.js";
export {
  doctorFlow,
  renderHumanReport,
  checkFrontmatterContract,
  checkFrontmatterVersion,
} from "./flows/doctor.js";
export type {
  BinaryRunner,
  CheckResult,
  CheckStatus,
  DoctorOptions,
  DoctorResult,
  GhAuthChecker,
  NetworkProbe,
} from "./flows/doctor.js";
export {
  BRAND_TOPICS,
  POD_TOPICS,
  PUBLIC_VAULT_TOPICS,
  baseTopicsForClass,
  DESCRIPTION_PREFIX,
  DESCRIPTION_SUFFIX,
  formatRepoDescription,
  mergeTopics,
} from "./scaffold/github-defaults.js";
export type { RepoClass } from "./scaffold/github-defaults.js";
export {
  renderMeshContext,
  meshContextInputFromYon,
  regenMeshContextFromYon,
  writeMeshContextFile,
} from "./scaffold/mesh-context.js";
export type { MeshContextInput } from "./scaffold/mesh-context.js";
export {
  AGENTS_MD_TEMPLATE_VERSION,
  AGENTS_MD_PATTERNS_BEGIN,
  AGENTS_MD_PATTERNS_END,
  AGENTS_MD_PRIMER_BEGIN,
  AGENTS_MD_PRIMER_END,
  getAgentsMdContent,
  getLytOverviewContent,
  regenInstalledPatternsSection,
  regenInstalledPrimerSection,
} from "./templates/priming.js";
export type { AgentsMdInput, InstalledPatternSummary } from "./templates/priming.js";
export { regenAgentsMd, collectInstalledPatterns } from "./flows/agents-md-regen.js";
export type { RegenAgentsMdResult } from "./flows/agents-md-regen.js";
export {
  README_MANAGED_BEGIN,
  README_MANAGED_END,
  regenReadme,
  checkReadmePresent,
} from "./flows/readme-regen.js";
export type { RegenReadmeResult, ReadmePresenceCheck } from "./flows/readme-regen.js";
export {
  TIER_PAYLOADS,
  payloadForVault,
  resolveScaffoldTier,
  renderSeedFigment,
} from "./templates/tier-payloads.js";
export type { ScaffoldTier, TierPayload, SeedFigmentSpec } from "./templates/tier-payloads.js";
export {
  POD_README_MANAGED_BEGIN,
  POD_README_MANAGED_END,
  renderPodReadme,
} from "./templates/pod-readme.js";
export type { PodReadmeInput } from "./templates/pod-readme.js";
export {
  edge as jsonCanvasEdge,
  fileNode as jsonCanvasFileNode,
  groupNode as jsonCanvasGroupNode,
  linkNode as jsonCanvasLinkNode,
  serializeCanvas,
  textNode as jsonCanvasTextNode,
} from "./canvas/json-canvas.js";
export type {
  EdgeOptions as JsonCanvasEdgeOptions,
  JsonCanvas,
  JsonCanvasColor,
  JsonCanvasEdge,
  JsonCanvasFileNode,
  JsonCanvasGroupNode,
  JsonCanvasLinkNode,
  JsonCanvasNode,
  JsonCanvasNodeSide,
  JsonCanvasTextNode,
  NodeGeometry,
} from "./canvas/json-canvas.js";
export {
  generateFederationCanvasFlow,
  EDGE_COLOR_FEDERATION_MESH,
  EDGE_COLOR_MESH_VAULT,
  EDGE_COLOR_SUBSCRIPTION,
  FEDERATION_HEIGHT,
  FEDERATION_WIDTH,
  FEDERATION_Y,
  MESH_HEIGHT,
  MESH_STRIDE,
  MESH_WIDTH,
  MESH_Y,
  NODE_COLOR_WARNING,
  VAULT_HEIGHT,
  VAULT_STRIDE,
  VAULT_WIDTH,
  VAULT_Y,
  WARNING_HEIGHT,
  WARNING_WIDTH,
} from "./flows/canvas-federation.js";
export type {
  CanvasFederationResult,
  GenerateFederationCanvasArgs,
} from "./flows/canvas-federation.js";
export { generateMeshCanvasFlow } from "./flows/canvas-mesh.js";
export type { CanvasMeshResult, GenerateMeshCanvasArgs } from "./flows/canvas-mesh.js";
export { MeshNotFoundError, rebuildMeshRegistryFlow } from "./flows/rebuild-mesh-registry.js";
export type {
  MeshRebuildOutcome,
  MeshRebuildStatus,
  RebuildMeshRegistryArgs,
  RebuildMeshRegistryResult,
  RebuildMeshRegistryTotalsByTable,
} from "./flows/rebuild-mesh-registry.js";
export {
  deleteAllEdgesByRefMesh,
  insertMeshEdge as insertMeshEdgeFromRepo,
  listEdgesByRefMesh,
} from "./registry/mesh-edges-repo.js";
export { deleteAllVaultsByMesh } from "./registry/mesh-vaults-repo.js";
export type { GhClient, GhRepoInfo } from "./util/gh.js";
export { parseOwnerRepoFromUrl } from "./util/gh.js";

export { openRegistry, closeRegistry, getRegistryPath } from "./registry/client.js";
export {
  openRegistryReadOnly,
  RegistryUpgradeRequiredError,
  resolveVaultSnapshotReadOnly,
} from "./registry/read-only-client.js";
export type {
  ReadOnlyRegistryClient,
  ReadOnlyRegistryMissing,
  ReadOnlyRegistryOpenResult,
  ReadonlyRegistryQueryClient,
  ResolveVaultSnapshotResult,
  VaultSnapshot,
} from "./registry/read-only-client.js";

// Phase D — pod-global discovery nudge engine. Pure policy (util) + the
// registry.db I/O seam (registry). Exported so the @younndai/lyt meta CLI's
// `lyt model` verbs and the offer surfaces (init offer, rebuild gate) can drive
// ONE coherent pod-global nudge-state.
export {
  deriveOfferState,
  isEligible,
  classifyEligibility,
  recordAsked,
  recordDecline,
  recordNever,
  recordSearch,
  coherentInitRow,
  NUDGE_STATE_SCHEMA_VERSION,
  AUTO_QUIET_DECLINE_THRESHOLD,
  NUDGE_CADENCE_DAYS,
  MS_PER_DAY,
} from "./util/nudge-state.js";
export type { NudgeState, OfferState, NudgeIneligibleReason } from "./util/nudge-state.js";
export {
  ensureNudgeState,
  saveNudgeState,
  bumpSearchCounter,
  bumpDeclineCount,
  markAsked,
  markNever,
  clearDeclineCount,
} from "./registry/nudge-state-repo.js";

export { migrate } from "./registry/migrate.js";
export { MIGRATIONS } from "./registry/migrations.js";
export type { Migration } from "./registry/migrations.js";
export {
  openLytDb,
  openLedgerDb,
  openAuditDb,
  openProvenanceDb,
  closeVaultDb,
  initLytDb,
  initLedgerDb,
  initAuditDb,
  initProvenanceDb,
  initVaultDbs,
  getLytDbPath,
  getLedgerDbPath,
  getAuditDbPath,
  getProvenanceDbPath,
  healLytDbIfCorrupt,
  type LytDbHealResult,
  // hardening cluster (hardening fix-pass) — shared corrupt-db classify +
  // remedy surface: one classifier, one actionable error, one detect probe.
  isCorruptDatabaseError,
  CorruptLytDbError,
  openLytDbActionable,
  isLytDbCorrupt,
  // Phase C (C-2) — the win32 EBUSY/EPERM rename retry primitive, reused by the
  // rename-aside connect flow to survive libSQL's post-close handle hold.
  renameWithRetry,
} from "./registry/vault-db.js";
export {
  LEDGER_REGISTRY,
  LEDGER_NAMES,
  getLedgerKind,
  type LedgerKind,
  type LedgerKindName,
} from "./registry/ledger-registry.js";
export {
  LYT_DB_MIGRATIONS,
  LYT_DB_TABLES,
  AUDIT_DB_MIGRATIONS,
  AUDIT_DB_TABLES,
  PROVENANCE_DB_MIGRATIONS,
  PROVENANCE_DB_TABLES,
  AUDIT_ACTIONS,
  FRICTION_CATEGORIES,
  migrateLytDb,
  migrateAuditDb,
  migrateProvenanceDb,
} from "./registry/vault-db-migrations.js";
export type {
  VaultDbMigration,
  AuditAction,
  FrictionCategory,
} from "./registry/vault-db-migrations.js";
export {
  newUuidv7Bytes,
  isUuidv7Bytes,
  uuid7BytesToHex,
  hexToUuid7Bytes,
  ridsEqual,
  uuid7BytesToDashedString,
} from "./util/uuid7.js";
export {
  insertVault,
  upsertVault,
  getVaultByName,
  getVaultByExactName,
  getVaultByRid,
  getVaultByPath,
  listVaults,
  updateVaultStatus,
  deleteVault,
  deleteAllVaults,
  updateVaultPath,
  markVaultMissing,
  markVaultActive,
  tombstoneVault,
  updateLastVerified,
  bumpVerifyFailCount,
  insertMeshEdge,
  listMeshEdgesByRefVault,
  listMeshEdgesByHomeVault,
} from "./registry/repo.js";
export type {
  VaultRow,
  VaultStatus,
  MeshEdgeRow,
  InsertVaultArgs,
  InsertMeshEdgeArgs,
} from "./registry/repo.js";
export {
  resolveVault,
  computeDisplayName,
  computeDisplayNameSync,
  vaultLeaf,
  vaultOriginCoordinate,
  gitUrlToCoordinate,
  formatTypedId,
  parseTypedId,
  AmbiguousVaultLeafError,
} from "./registry/vault-addressing.js";
export type { LytEntityType, TypedId } from "./registry/vault-addressing.js";
export {
  setAlias,
  getAlias,
  getAliasTargetRid,
  listAliases,
  listAliasesForVault,
  deleteAlias,
} from "./registry/aliases-repo.js";
export type { AliasRow } from "./registry/aliases-repo.js";
export {
  setAliasFlow,
  listAliasesFlow,
  removeAliasFlow,
  AliasTargetNotFoundError,
  AliasNameInvalidError,
} from "./flows/alias.js";
export {
  insertMesh,
  getMeshByRid,
  getMeshByName,
  listMeshes,
  updateMeshMainVault,
  deleteMesh,
} from "./registry/meshes-repo.js";
export type { MeshRow, InsertMeshArgs, MeshPushKind } from "./registry/meshes-repo.js";
export {
  DESTINATION_POLICY_SCHEMA_MAJOR,
  MINIMUM_DESTINATION_POLICY_WRITER_VERSION,
  destinationPolicyKey,
  resolveDestinationPolicy,
  resolveEffectiveOwnedDestination,
  resolveEffectiveOwnedMeshDestination,
  validateDestinationPolicyValue,
  parseCanonicalDestinationTarget,
  publicationCoordinateOwner,
  assertSupportedDestinationPolicyWriter,
  DestinationPolicyValidationError,
  UnsupportedDestinationPolicySchemaError,
  DestinationPolicyWriterUpgradeRequiredError,
} from "./registry/destination-policy.js";
export type {
  DestinationSubjectKind,
  DestinationKind,
  DestinationTargetKind,
  MeshDestinationSource,
  VaultDestinationSource,
  DestinationSource,
  DestinationPolicyState,
  DestinationPolicyValue,
  DestinationPolicyRecordV1,
  ResolvedDestinationPolicy,
  EffectiveOwnedDestination,
  OwnedDestinationVaultView,
  OwnedDestinationMeshView,
  PublicationCoordinateComparison,
} from "./registry/destination-policy.js";
export { comparePublicationCoordinates } from "./util/publication-coordinate.js";
export {
  parseGithubPublicationTarget,
  buildPermissionObservation,
  assertFreshVerifiedPermission,
  classifyPermissionEvidence,
  formatLastObservedPermission,
} from "./util/permission-observation.js";
export type {
  PublicationCapability,
  PermissionObservationResult,
  GithubPublicationTargetKind,
  CanonicalGithubPublicationTarget,
  PermissionEvidence,
  PermissionEvidenceClass,
  PermissionObservation,
  BuildPermissionObservationInput,
  RequiredPermissionObservation,
} from "./util/permission-observation.js";
export {
  observePublicationPermission,
  PUBLICATION_PERMISSION_PROMPT_GUARDS,
} from "./flows/federation/publication-permission.js";
export type {
  ObservePublicationPermissionArgs,
  PublicationPermissionObserver,
  PublicationPermissionGhRunner,
} from "./flows/federation/publication-permission.js";
export {
  loadDestinationPolicyContext,
  resolveCanonicalOwnedVaultDestination,
  resolveCanonicalOwnedVaultPublicationAuthority,
  resolveCanonicalOwnedMeshDestination,
  setCanonicalDestinationPolicy,
  tombstoneCanonicalVaultDestination,
  transitionVaultSourceWithPolicyFence,
  withDestinationPolicySubjectLocks,
} from "./flows/federation/destination-policy-service.js";
export type {
  CanonicalVaultPublicationAuthority,
  DestinationPolicySubjectRef,
  DestinationPolicyContext,
  LoadDestinationPolicyContextOptions,
  SetCanonicalDestinationPolicyArgs,
} from "./flows/federation/destination-policy-service.js";
export {
  withCanonicalVaultPublicationAttempt,
  withFreshPublicationPermission,
} from "./flows/federation/publication-authority.js";
export type {
  CanonicalVaultPublicationAttemptArgs,
  CanonicalVaultPublicationAttemptContext,
  FreshPublicationPermissionArgs,
} from "./flows/federation/publication-authority.js";
export {
  addVaultToMesh,
  listVaultsInMesh,
  listMeshesForVault,
  removeVaultFromMesh,
} from "./registry/mesh-vaults-repo.js";
export type { MeshVaultRow, MeshVaultRole } from "./registry/mesh-vaults-repo.js";
export {
  addSubscription,
  listSubscriptionsForMesh,
  removeSubscription,
} from "./registry/mesh-subscriptions-repo.js";
export type { MeshSubscriptionRow } from "./registry/mesh-subscriptions-repo.js";
export {
  getKnownPathsFile,
  readKnownPaths,
  addKnownPath,
  removeKnownPath,
} from "./registry/known-paths.js";
// v1.B.4 — re-export federationInitFlow + types so the meta package
// (`packages/lyt/src/flows/init-bootstrap.ts`) can compose them without
// reaching into the lyt-vault subpath. Mirrors meshInitFlow re-export
// landed in v1.B.2 (S1) for the same cross-package consumption reason.
export { federationInitFlow } from "./flows/federation/init.js";
export { adoptAndPrimeFlow } from "./flows/adopt-and-prime.js";
// (Brief A) — the derived pod manifest (`pod.yon`) regen surface. The meta
// package's init-bootstrap composes regeneratePodManifestNonFatal at the end of
// the fresh/re-init branches so `lyt init` leaves a POPULATED pod.yon.
export {
  derivePodManifestDoc,
  regeneratePodManifestFlow,
  regeneratePodManifestNonFatal,
} from "./flows/federation/regenerate.js";
export type {
  DerivePodManifestOptions,
  RegeneratePodManifestOptions,
  RegeneratePodManifestResult,
} from "./flows/federation/regenerate.js";
// Brief B (B.1/B.2) — the shared publish-materialization atoms (per-vault +
// pod-commit) + the pod-local orchestrator. init/adopt call materializePodLocal
// push-held; the lyt-mesh sync engine reuses the atoms with push=true.
export {
  materializeVaultPublishable,
  commitPodRepo,
  normalizeGitHubRepoCoordinate,
} from "./flows/federation/vault-publish.js";
export type {
  MaterializeVaultOptions,
  MaterializeVaultResult,
  CommitPodRepoOptions,
  CommitPodRepoResult,
  GitRunner,
} from "./flows/federation/vault-publish.js";
export { materializePodLocal } from "./flows/federation/materialize-pod.js";
export type {
  MaterializePodOptions,
  MaterializePodResult,
} from "./flows/federation/materialize-pod.js";
// Fed-v2 Layer-1 (Phase D1d) — the pod-repo `ledger/` git-sync leg + the
// reconstitution it triggers. `lyt sync` (lyt-mesh) calls these after the
// per-vault sync so the per-writer subscription/alias shards converge
// cross-machine and the local cache is rebuilt from the union.
export { syncPodLedgerFlow } from "./flows/federation/sync-pod-ledger.js";
export type {
  SyncPodLedgerArgs,
  SyncPodLedgerDependencies,
  SyncPodLedgerResult,
  PodLedgerSyncStatus,
} from "./flows/federation/sync-pod-ledger.js";
export {
  rebuildFederationCacheFlow,
  SUBSCRIPTION_BUCKET_MESH,
  SHARED_BUCKET_MESH,
} from "./flows/federation/rebuildFederationCacheFlow.js";
export type {
  RebuildFederationCacheArgs,
  RebuildFederationCacheResult,
} from "./flows/federation/rebuildFederationCacheFlow.js";
// Brief B (B.2) — the reconcile/publish engine + the resumable outbox.
export { reconcilePublishFlow } from "./flows/federation/reconcile-publish.js";
export {
  derivePodReconciliationAction,
  POD_RECONCILIATION_REPAIR_COMMAND,
  type PodReconciliationDecision,
  type PodReconciliationState,
} from "./flows/federation/pod-reconciliation.js";
export {
  observeLocalPodGitState,
  type LocalPodGitEvidence,
  type LocalPodGitStateObservation,
} from "./flows/federation/pod-git-state.js";
export {
  observePodRemoteState,
  type PodRemoteCommandRunner,
  type PodRemoteObservationEvidence,
  type PodRemoteStateObservation,
} from "./flows/federation/pod-remote-state.js";
export {
  applyEditorLocalizationPlanV1,
  EDITOR_LOCALIZATION_MACHINE_EVIDENCE_LABEL,
  parseEditorLocalizationPlanV1,
  prepareEditorLocalizationPlanV1,
} from "./flows/editor-localization.js";
export type {
  ApplyEditorLocalizationArgs,
  EditorLocalizationBeforeV1,
  EditorLocalizationEligibility,
  EditorLocalizationEligibilityReason,
  EditorLocalizationMachineEvidenceV1,
  EditorLocalizationMachineReceiptV1,
  EditorLocalizationPlanV1,
  PrepareEditorLocalizationArgs,
  PrepareEditorLocalizationResult,
} from "./flows/editor-localization.js";
export {
  inspectPodRepair,
  POD_PRESERVE_BOTH_APPLY_COMMAND,
  POD_REPAIR_APPLY_PRECONDITION,
  type PodRepairDecision,
  type PodRepairInspectionDependencies,
  type PodRepairInspectionResult,
  type PodRepairNextAction,
  type PodRepairObservedState,
  type PodRepairProvenanceObservation,
} from "./flows/federation/pod-repair.js";
export {
  applyPodRepairPreserveBoth,
  type PodRepairApplyDependencies,
  type PodRepairApplyResult,
} from "./flows/federation/pod-repair-apply.js";
export {
  classifyDeterministicLegacyPodProvenance,
  classifyReceiptBoundPodProvenance,
  derivePodTransformationProofV1,
  derivePodTransformationRecordIds,
  digestPodTransformationEvidenceRecordV1,
  digestPodTransformationProofV1,
  isPodGeneratedArtifactPath,
  parsePodTransformationProofV1,
  POD_TRANSFORMATION_PROOF_SCHEMA_ID,
  POD_TRANSFORMATION_PROOF_SCHEMA_VERSION,
  serializePodTransformationProofV1,
  type PodGeneratedByteTransitionV1,
  type DerivePodTransformationProofArgs,
  type PodTransformationProofV1,
  type PodTransformationProvenance,
  type PodTransformationRecordIds,
} from "./flows/federation/pod-transformation-proof.js";
export {
  appendPodTransformationProof,
  getPodTransformationLedgerPath,
  getPodTransformationSubjectLedgerPath,
  readAuthenticatedPodTransformationEvidence,
  type AppendPodTransformationProofArgs,
  type AppendPodTransformationProofResult,
  type AuthenticatedPodTransformationEvidence,
  type PodTransformationProofDependencies,
} from "./flows/federation/pod-transformation-proof-ledger.js";
export type {
  ReconcilePublishArgs,
  ReconcilePublishResult,
  VaultPublishOutcome,
  VaultPublishStatus,
} from "./flows/federation/reconcile-publish.js";
// Brief D (D.3) — the connect self-heal: `lyt sync` reconciles a
// local-first (provisional) pod to the real gh handle + D.3-GUARD. The lyt-mesh
// `lyt sync` command calls connectPodFlow before the publish pass; podNeedsConnect
// is the cheap (no-gh-call) gate.
export { connectPodFlow, podNeedsConnect } from "./flows/federation/connect.js";
export type {
  ConnectPodArgs,
  ConnectPodResult,
  ConnectStatus,
  ConnectGitRunner,
} from "./flows/federation/connect.js";
// Phase C (B4) — the rename-aside ACTIONABLE connect path. When
// connectPodFlow's guard detects an existing remote pod WITH CONTENT, the `lyt
// sync` command offers the 3-option menu and (on "adopt") runs this flow: back
// up the whole LYT_HOME aside, L0-strip the backup's junctions, adopt the remote
// fresh, and hand off the merge to the Obsidian-import funnel.
export { adoptRemoteRenameAsideFlow } from "./flows/federation/adopt-remote-rename-aside.js";
export type {
  AdoptRemoteRenameAsideArgs,
  AdoptRemoteRenameAsideResult,
  RenameAsideStatus,
} from "./flows/federation/adopt-remote-rename-aside.js";
export {
  openOutbox,
  closeOutbox,
  enqueueOutbox,
  listOutbox,
  markOutboxDone,
  markOutboxFailed,
  countOutbox,
  getOutboxPath,
} from "./flows/federation/outbox.js";
export type { OutboxOp, OutboxEntry } from "./flows/federation/outbox.js";
// Brief B (B.5 / a review finding) — pod.yon-driven recovery (clone + register each
// @FED_VAULT repo on a clean machine).
export {
  recoverVaultsFromPodManifest,
  reconstructionExitCode,
} from "./flows/federation/recover-pod.js";
export type {
  RecoverPodArgs,
  RecoverPodResult,
  RecoverDrop,
  RecoverDropClassification,
  VaultCloneFn,
} from "./flows/federation/recover-pod.js";
export type { AdoptAndPrimeArgs, AdoptAndPrimeResult } from "./flows/adopt-and-prime.js";
export type {
  FederationInitOptions,
  FederationInitResult,
  FederationInitBranch,
} from "./flows/federation/init.js";
export type { FederationGhClient, FederationRepoVisibility } from "./util/gh-federation.js";
// V-A-11 fix-pass — the real gh-backed FederationGhClient is exported as a VALUE
// so the meta package's init-bootstrap router can default its pod-exists probe to
// the SAME detection federationInitFlow uses internally (router + flow cannot
// disagree). Tests inject their own client via the existing federationGhClient seam.
export { realFederationGhClient } from "./util/gh-federation.js";
// V-B-9 (Track C Wave 1) — win32-aware spawn resolver, shared so the streaming
// gh executors (this package's gh-discover + lyt-mesh discovery/github) get the
// same .exe-direct / .cmd-shell-quoted handling as the federation runners.
export { resolveSpawnInvocation, buildShellCommand, cmdQuote } from "./util/gh-federation.js";
export type { SpawnInvocation } from "./util/gh-federation.js";
// v1.B.4 — getHandleFromIdentity is the canonical handle resolver used by
// the lyt init --custom mode (push-target prompt default). Existing
// federation flows use it internally; the meta CLI now needs it too.
export { getHandleFromIdentity } from "./util/identity.js";
export { validateMeshName, validateVaultName } from "./util/identity.js";
export {
  getFederationRepoDir,
  getFederationRoot,
  getFederationYonPath,
} from "./util/federation-paths.js";
// Brief B (§3-§6) — minimal config seam (publish/visibility/conflict
// defaults). The full config.yon layer is deferred (flagged for oversight).
export {
  resolveConfig,
  DEFAULT_LYT_CONFIG,
  type LytConfig,
  type PublishPromptDefault,
  type ConflictPosture,
  type ResolveConfigOptions,
} from "./util/config.js";
// Brief B (scheme D) — vault repo-name chokepoint family + the pod repo
// name, exported so the lyt-mesh sync/reconcile engine and recovery loop route
// every repo-name computation through one place (vaultRepoName + parse inverse).
export {
  federationRepoName,
  federationRepoFullName,
  vaultRepoName,
  vaultRepoNameFromParts,
  vaultRepoFullName,
  parseVaultRepoName,
  resolveVaultRef,
  VAULT_REPO_PREFIX,
  VAULT_REPO_SEP,
} from "./util/federation-paths.js";
export type { ResolvedVaultRef } from "./util/federation-paths.js";
// hardening pass (subscriber-onboarding fix-pass) — the registration FK guard's
// structured refusal, exported for caller-path error mapping + harness cells.
export { VaultHomeMeshNotRegisteredError } from "./flows/register.js";
export { parseFederationYon } from "./yon/federation-read.js";
// V-A-11 — sibling of the already-public renderVaultYon; renders pod.yon from a
// federation model (used by the adopt-branch test fixture + pod-authoring tools).
export { renderFederationYon } from "./yon/federation-write.js";
// v1.B.5 — federation_state surface for the new doctor check
// (`checkFederationRepoState`) and downstream consumers (e2e harnesses).
export {
  readFederationState,
  listFederationStates,
  upsertFederationState,
  deleteFederationState,
  // provisional→real handle remap (preserves fed_rid).
  remapFederationHandle,
} from "./registry/federation-state.js";
export type { FederationStateRow, UpsertFederationStateArgs } from "./registry/federation-state.js";
// v1.B.5 — re-export the 4 new doctor check helpers so tests + downstream
// consumers can drive them directly (matches the established pattern of
// re-exporting from a single barrel for cross-package import).
export {
  checkFederationRepoState,
  checkMeshYonParses,
  checkLedgersYonDbPairs,
  checkMarkersRender,
} from "./flows/doctor.js";

// Fed-v2 Slice 1b (#13 DELETE) — mesh-publish/unpublish/update-cadence
// and @MESH_PUBLIC/@UPDATE_CADENCE removed. mesh-info survives (simplified).
export {
  meshInfoFlow,
  MeshInfoNotFoundError,
  MeshInfoRemoteGhUnavailableError,
  MeshInfoRemoteMeshYonMissingError,
  realMeshInfoGhClient,
} from "./flows/mesh-info.js";
export type {
  MeshInfoArgs,
  MeshInfoResult,
  MeshInfoHomeVault,
  MeshInfoGhClient,
} from "./flows/mesh-info.js";
export { detectLicenseFromContent } from "./util/license-detect.js";
export type { DetectedLicense, LicenseBucket } from "./util/license-detect.js";
// Fed-v2 Slice 1b (#13 DELETE): vault-update-cadence removed (wrote @UPDATE_CADENCE, deleted).
export { checkFederationLicenseCompatibility } from "./util/license-warnings.js";
export type { LicenseFederationWarning, LicenseWarningKind } from "./util/license-warnings.js";
export type { VaultLicensePosture } from "./flows/info.js";
export {
  acquireLease,
  releaseLease,
  refreshLease,
  getLeaseById,
  listLeasesByVault,
  probeActiveLeases,
  sweepExpiredLeases,
  canAcquireLease,
} from "./registry/leases-repo.js";
export type {
  LeaseRow,
  LeaseStatus,
  LeaseProbe,
  CanAcquireLeaseDecision,
  AcquireLeaseArgs,
  ReleaseLeaseArgs,
  RefreshLeaseArgs,
} from "./registry/leases-repo.js";

export {
  insertAutomatorRun,
  updateAutomatorRunStatus,
  incrementVaultWritesCount,
  getAutomatorRunById,
  listAutomatorRuns,
  insertAutomatorRunEvent,
  listAutomatorRunEvents,
  insertProvenance,
  listProvenanceByTarget,
  insertAuditLog,
  insertAutomatorWriteAuditLog,
} from "./registry/vault-db-repo.js";
export {
  recordAudit,
  reinjectAuditRecord,
  getAuditLedgerPath,
  getAuditLedgerDir,
  listAuditShards,
  walkAllAuditShards,
} from "./registry/audit-write.js";
export type {
  RecordAuditArgs,
  RecordAuditResult,
  AuditLedgerFields,
} from "./registry/audit-write.js";
export {
  recordProvenance,
  reinjectProvenanceRecord,
  getProvenanceLedgerPath,
  getProvenanceLedgerDir,
  listProvenanceShards,
  walkAllProvenanceShards,
} from "./registry/provenance-write.js";
export type {
  RecordProvenanceArgs,
  RecordProvenanceResult,
  ProvenanceLedgerFields,
} from "./registry/provenance-write.js";
export type {
  AutomatorRunStatus,
  AutomatorRunRow,
  AutomatorRunEventLevel,
  AutomatorRunEventRow,
  ProvenanceWriteTargetType,
  ProvenanceRow,
  AuditLogResult,
  InsertAutomatorRunArgs,
  UpdateAutomatorRunStatusArgs,
  InsertAutomatorRunEventArgs,
  ListAutomatorRunsFilter,
  ListAutomatorRunEventsFilter,
  InsertProvenanceArgs,
  InsertAuditLogArgs,
} from "./registry/vault-db-repo.js";

// B-4 (figment-roots, A2) — the shared inclusion predicate, exported so the
// cross-package READ gate in lyt-mesh (the sync-watch event pre-filter) routes
// through the SAME funnel as every in-package index tier. Public-export
// addition only: no behavior change to lyt-vault.
export { isIndexablePath, isIndexable, walkVaultMarkdownFiles } from "./util/indexable.js";
export type { IgnoreMatcher, IndexExclusion, IndexVerdict } from "./util/indexable.js";
export {
  loadLytIgnorePolicy,
  parseLytIgnore,
  LytIgnorePolicyError,
  LYT_IGNORE_FILENAME,
} from "./util/lytignore.js";
export type { LytIgnorePolicy, LytIgnorePattern } from "./util/lytignore.js";
export { inventoryVaultFiles, normalizeVaultSubtree } from "./flows/vault-files.js";
export type {
  VaultFileClassification,
  VaultFileInventoryEntry,
  VaultFilesInventory,
} from "./flows/vault-files.js";

export { renderVaultYon } from "./yon/vault.js";
export type { VaultDoc, VaultRecord, VaultHomeMeshRecord } from "./yon/vault.js";
export {
  appendLedgerRecord,
  ensureLedgerHeader,
  monthKeyFromIsoTs,
  clearLedgerCache,
} from "./yon/ledger-write.js";
export type { AppendLedgerRecordArgs, AppendLedgerRecordResult } from "./yon/ledger-write.js";
export { walkLedger, parseLedgerFile } from "./yon/ledger-read.js";
export type { WalkLedgerOptions } from "./yon/ledger-read.js";
export type { LedgerRecord } from "./yon/ledger-read.js";
export {
  appendPodAlias,
  ensurePodAliasAuthority,
  foldPodAlias,
  projectPodAlias,
  readAllPodAliasRecords,
  readPodAlias,
} from "./yon/pod-alias-ledger.js";
export type { PodAliasRecord } from "./yon/pod-alias-ledger.js";
export {
  acknowledgePromotedSyncProvenance,
  getSyncLedgerDir,
  getSyncPendingDir,
  getSyncProvenanceStatus,
  promotePendingSyncProvenance,
  queueSyncProvenance,
  readSyncProvenance,
  sanitizeSyncProvenanceText,
} from "./yon/sync-provenance.js";
export type {
  QueueSyncProvenanceArgs,
  SyncProvenanceEvent,
  SyncProvenanceStatus,
} from "./yon/sync-provenance.js";
// Fed-v2 Layer-1 (Phase C) — per-writer append-only subscription store.
export { getMachineId, getWriterId, getWriterIdPath, parseWriterYon } from "./util/writer-id.js";
export {
  deriveInitialMachineAlias,
  fallbackMachineAlias,
  foldMachines,
  getMachineLedgerDir,
  listMachineShards,
  readAllMachineRecords,
  readCurrentMachine,
  recordCurrentMachineSyncSuccess,
  registerCurrentMachine,
  sanitizeMachineAlias,
  updateCurrentMachineAlias,
  appendSyncObserved,
  foldSyncObserved,
  readAllSyncObservedRecords,
} from "./yon/machine-ledger.js";
export type {
  MachineLedgerRecord,
  PublishedMachineSnapshot,
  RegisterCurrentMachineArgs,
  SyncObservedRecord,
} from "./yon/machine-ledger.js";
export {
  appendSubscriptionRecord,
  appendSubscriptionActive,
  appendSubscriptionTombstone,
  getSubscriptionsLedgerDir,
} from "./yon/subscription-ledger-write.js";
export type {
  AppendSubscriptionArgs,
  SubscriptionEntryMode,
  SubscriptionState,
} from "./yon/subscription-ledger-write.js";
export {
  foldSubscriptions,
  liveSubscriptions,
  observedMaxSubscriptionHlc,
  readAllSubscriptionRecords,
  listSubscriptionShards,
} from "./yon/subscription-ledger-read.js";
export type { SubscriptionRecord, LiveSubscription } from "./yon/subscription-ledger-read.js";
// Inc-2 Phase 0 — per-writer append-only @FED_VAULT / @FED_MESH
// manifest ledger (HLC-LWW register keyed on rid). The sharded-CRDT write/merge
// SoT under the byte-stable `pod.yon` derived view.
export {
  appendFedVaultRecord,
  appendFedVaultActive,
  appendFedVaultTombstone,
  getFedVaultLedgerDir,
} from "./yon/federation-vault-ledger-write.js";
export type { AppendFedVaultArgs, FedVaultState } from "./yon/federation-vault-ledger-write.js";
export {
  foldFedVaults,
  liveFedVaults,
  readAllFedVaultRecords,
  listFedVaultShards,
  observedMaxFedVaultHlc,
} from "./yon/federation-vault-ledger-read.js";
export type { FedVaultLedgerRecord, LiveFedVault } from "./yon/federation-vault-ledger-read.js";
export {
  appendFedMeshRecord,
  appendFedMeshActive,
  appendFedMeshTombstone,
  getFedMeshLedgerDir,
} from "./yon/federation-mesh-ledger-write.js";
export type { AppendFedMeshArgs, FedMeshState } from "./yon/federation-mesh-ledger-write.js";
export {
  foldFedMeshes,
  liveFedMeshes,
  readAllFedMeshRecords,
  listFedMeshShards,
  observedMaxFedMeshHlc,
} from "./yon/federation-mesh-ledger-read.js";
export type { FedMeshLedgerRecord, LiveFedMesh } from "./yon/federation-mesh-ledger-read.js";
export { renderLanesYon, writeLanesDoc, getLanesYonPath } from "./yon/lanes-write.js";
export type { LaneRecord, LaneMemberRecord, LanesDoc } from "./yon/lanes-write.js";
export { parseLanesFile } from "./yon/lanes-read.js";
export { renderArcsYon, writeArcsDoc, getArcsYonPath } from "./yon/arcs-write.js";
export type { ArcRecord, ArcMemberRecord, ArcsDoc } from "./yon/arcs-write.js";
export { parseArcsFile, extractArcRecordsFromMarkdownBody } from "./yon/arcs-read.js";
export { renderMemscopeYon } from "./yon/memscope.js";
export type { MemscopeDoc, MemscopeRecord } from "./yon/memscope.js";
export { parseVaultYon } from "./yon/parse.js";
export type { ParsedVaultYon, ParsedVaultHomeMesh } from "./yon/parse.js";
export { parseMeshYon } from "./yon/mesh-read.js";
export { renderMeshYon } from "./yon/mesh-write.js";
export { meshInitFlow } from "./flows/mesh-init.js";
export type { MeshInitOptions, MeshInitResult } from "./flows/mesh-init.js";
export { meshJoinFlow } from "./flows/mesh-join.js";
export type { MeshJoinOptions, MeshJoinResult } from "./flows/mesh-join.js";
export { meshListFlow, meshListUsingDb } from "./flows/mesh-list.js";
export type {
  MeshListEntry,
  MeshListOptions,
  MeshListResult,
  MeshListVaultRef,
} from "./flows/mesh-list.js";
export type { MeshGhClient } from "./util/gh-mesh.js";
export type {
  MeshDoc,
  MeshHomeRecord,
  MeshPushKind as MeshDocPushKind,
  MeshRecord,
} from "./yon/mesh-write.js";
export { parseMeshManifest, applyGhPrefix } from "./yon/manifest.js";
export type {
  ManifestMesh,
  ManifestVault,
  ManifestShareWith,
  ParsedManifest,
} from "./yon/manifest.js";
export { parsePatternYon } from "./yon/pattern.js";
export type { ParsedPattern, PatternRecord, VerbRecord } from "./yon/pattern.js";

export { patternListFlow } from "./flows/pattern-list.js";
export type { PatternListEntry, PatternListResult } from "./flows/pattern-list.js";
export { patternInstallFlow } from "./flows/pattern-install.js";
export type { PatternInstallArgs, PatternInstallResult } from "./flows/pattern-install.js";
export { patternUninstallFlow } from "./flows/pattern-uninstall.js";
export type { PatternUninstallArgs, PatternUninstallResult } from "./flows/pattern-uninstall.js";
export { patternLinkFlow } from "./flows/pattern-link.js";
export type { PatternLinkArgs, PatternLinkResult } from "./flows/pattern-link.js";
export { patternUnlinkFlow } from "./flows/pattern-unlink.js";
export type { PatternUnlinkArgs, PatternUnlinkResult } from "./flows/pattern-unlink.js";
export { patternForkFlow } from "./flows/pattern-fork.js";
export type { PatternForkArgs, PatternForkResult } from "./flows/pattern-fork.js";
export { patternVerbsFlow } from "./flows/pattern-verbs.js";
export type { PatternVerbsResult } from "./flows/pattern-verbs.js";
export { patternRunFlow } from "./flows/pattern-run.js";
export type { PatternRunArgs, PatternRunResult } from "./flows/pattern-run.js";
// keystone Phase C C8 — the vault share/unshare access verbs (gh-as-SoT).
export { shareVaultFlow, unshareVaultFlow } from "./flows/share.js";
export type {
  ShareLevel,
  ShareVaultArgs,
  ShareVaultResult,
  UnshareVaultArgs,
  UnshareVaultResult,
  ShareVaultFlowOpts,
} from "./flows/share.js";
// keystone Phase C — the vault access (read-only) + invites (list/accept)
// verbs (gh-as-SoT, through the AccessProvider port).
export { vaultAccessFlow } from "./flows/access.js";
export type {
  VaultAccessArgs,
  VaultAccessFlowOpts,
  VaultAccessResult,
  AccessDrift,
  SubscriberView,
} from "./flows/access.js";
export { vaultInvitesFlow } from "./flows/invites.js";
export type {
  VaultInvitesArgs,
  VaultInvitesFlowOpts,
  VaultInvitesResult,
  VaultInvitesListResult,
  VaultInvitesAcceptResult,
} from "./flows/invites.js";
export { relinkAllPatternsForVault } from "./flows/pattern-relink-vault.js";
export {
  getUserPatternsDir,
  getVaultPatternsLinkDir,
  getBundledPatternsDir,
  listPatternNames,
  copyBundledPatterns,
  healPatterns,
} from "./util/pattern-paths.js";
export type {
  PatternHealEntry,
  PatternHealResult,
  HealPatternsOptions,
} from "./util/pattern-paths.js";
export {
  hashPatternDir,
  readPatternVersion,
  renderPatternManifest,
  parsePatternManifest,
  PATTERN_MANIFEST_FILENAME,
} from "./util/pattern-manifest.js";
export type { PatternManifestEntry } from "./util/pattern-manifest.js";
export { buildPatternCommand } from "./commands/pattern.js";
export { buildHelpCommand } from "./commands/help.js";
export { buildDoctorCommand } from "./commands/doctor.js";
export { buildIdentityCommand } from "./commands/identity.js";
export {
  getIdentity,
  refreshIdentity,
  slugifyVaultName,
  realIdentityRunner,
  isValidGhHandle,
  // provisional-handle derivation (default OS username).
  deriveProvisionalHandle,
  IDENTITY_CACHE_TTL_MS,
} from "./util/identity.js";
export type { IdentityRunner, GetIdentityOptions } from "./util/identity.js";
export {
  getIdentityCachePath,
  getLegacyIdentityCachePath,
  migrateIdentityCache,
  readIdentityCache,
  writeIdentityCache,
  parseIdentityYon,
  renderIdentityYon,
  renderMachineIdentity,
  renderPodIdentity,
  getPodIdentityPath,
  readPodIdentity,
  writePodIdentity,
  ensurePodIdentityMetadata,
  deriveInitialPodAlias,
  fallbackPodAlias,
  sanitizePodAlias,
  resolvePodIdentity,
  reconcileIdentity,
  // provisional identity surface (local-first init +
  // connect self-heal): write/detect a provisional identity + the source consts.
  writeProvisionalIdentity,
  isProvisionalIdentity,
  IDENTITY_SOURCE_PROVISIONAL,
  IDENTITY_SOURCE_GH,
} from "./util/identity-cache.js";
export type {
  CachedIdentity,
  PodIdentity,
  ResolvePodIdentityOptions,
  ReconcileIdentityOutcome,
} from "./util/identity-cache.js";

export { freezeVaultFlow } from "./flows/freeze.js";
export type { FreezeFlowArgs, FreezeFlowResult } from "./flows/freeze.js";
export { unfreezeVaultFlow } from "./flows/unfreeze.js";
export type { UnfreezeFlowArgs, UnfreezeFlowResult } from "./flows/unfreeze.js";
export { snapshotVaultFlow, SNAPSHOT_BRANCH_PREFIX } from "./flows/snapshot.js";
export type { SnapshotFlowArgs, SnapshotFlowResult } from "./flows/snapshot.js";
export { restoreVaultFlow } from "./flows/restore.js";
export type { RestoreFlowArgs, RestoreFlowResult } from "./flows/restore.js";
export { listSnapshotsFlow } from "./flows/list-snapshots.js";
export type { ListSnapshotsArgs, ListSnapshotsResult } from "./flows/list-snapshots.js";
export { DEFAULT_FREEZE_DURATION, formatRemaining, parseFreezeDuration } from "./util/duration.js";
export { inspectWindowsGitPath } from "./util/paths.js";
export type {
  InspectWindowsGitPathOptions,
  WindowsGitPathInspection,
  WindowsGitPathRefusal,
  WindowsGitPathRefusalCode,
} from "./util/paths.js";
export {
  FROZEN_LOCK_BASENAME,
  enforceNotFrozen,
  frozenLockPath,
  isNearExpiry,
  nearExpiryWindowHours,
  readFrozenLock,
} from "./util/freeze-check.js";
export type { FrozenLockContent, FrozenState } from "./util/freeze-check.js";
export {
  aheadBehind,
  branchExists,
  getCurrentBranch,
  getDefaultBranch,
  GIT_COMMAND_TIMEOUT_MS,
  GitRunTerminatedError,
  GIT_LOCAL_MUTATION_POLICY,
  GIT_READ_ONLY_POLICY,
  GIT_REMOTE_OBSERVATION_POLICY,
  gitStatusPorcelain,
  hasUpstream,
  isGitRepo,
  listBranchesWithPrefix,
  runGit,
  runGitCommitWithIdentityFallback,
  runGitLocalMutation,
  runGitReadOnly,
  runGitRemoteObservation,
  slugify,
  timestampForBranchName,
} from "./util/git-run.js";

export { PUBLICATION_LOCK_RECOVERY_QUARANTINE_MS } from "./flows/federation/destination-policy-lock.js";
export type {
  AheadBehind,
  BranchInfo,
  GitRunPolicy,
  GitRunPolicyKind,
  GitRunOptions,
  GitRunResult,
  GitTerminationEvidence,
  PorcelainStatus,
} from "./util/git-run.js";

export { buildVaultSubcommand, buildRegistrySubcommand } from "./vault-command.js";
export { registerVaultVerbs } from "./register-verbs.js";
export { buildReceiptCommand } from "./commands/receipt.js";

// Block-B Commit 6 — automator verb-group surface.
export { buildAutomatorCommand } from "./commands/automator.js";
export { listAutomatorsFlow } from "./flows/automator-list.js";
export type {
  AutomatorListArgs,
  AutomatorListEntry,
  AutomatorListResult,
} from "./flows/automator-list.js";
export { automatorLogFlow } from "./flows/automator-log.js";
export type {
  AutomatorLogArgs,
  AutomatorLogEntry,
  AutomatorLogResult,
} from "./flows/automator-log.js";
export { automatorStatusFlow } from "./flows/automator-status.js";
export type {
  AutomatorStatusArgs,
  AutomatorStatusEntry,
  AutomatorStatusLeaseEntry,
  AutomatorStatusResult,
} from "./flows/automator-status.js";
export {
  buildAutomatorRunPlan,
  closeAutomatorRunPlan,
  recordCliInvocation,
} from "./flows/automator-run.js";
export type { AutomatorRunPlan, AutomatorRunPlanArgs } from "./flows/automator-run.js";
export {
  MACHINE_ROLES,
  DEFAULT_MACHINE_ROLES,
  machineRegionConfigFlow,
  machineAliasUpdateFlow,
  machineRoleDisableFlow,
  machineRoleEnableFlow,
  machineStatusFlow,
  readMachineState,
} from "./flows/machine-state.js";
export type {
  MachineRole,
  MachineStatus,
  MachineRoleEnableArgs,
  MachineRoleDisableArgs,
  MachineRegionConfigArgs,
} from "./flows/machine-state.js";
export { buildMachineCommand } from "./commands/machine.js";
export { buildFederationCommand } from "./commands/federation.js";

export { DEFAULT_TEMPLATE } from "./templates/index.js";
export type { TemplateName } from "./templates/index.js";
// Phase B (frontmatter-contract lane, slice 1) — the machine-readable
// frontmatter Source-of-Truth. The `lyt contract` verb + downstream slices
// (capture --dir, topic picker, MCP schema, agent-manual generation) consume
// FRONTMATTER_CONTRACT so there is one bump point and no parallel field lists.
export {
  FRONTMATTER_CONTRACT,
  FRONTMATTER_CONTRACT_VERSION,
  FRONTMATTER_FIELDS,
  MANDATORY_FRONTMATTER_TOKENS,
  DEFAULT_MESH_VISIBILITY,
  DEFAULT_WEIGHT,
  buildFrontmatter,
  validateFrontmatterBlock,
  gitCommitterDateToIso,
} from "./templates/contract.js";
export { buildVaultInstallProviderObjectsV1 } from "./install-provider.js";
export type { VaultInstallProviderObjectV1 } from "./install-provider.js";
export type {
  FrontmatterContractField,
  FrontmatterFieldSource,
  FrontmatterField,
  MandatoryFrontmatterToken,
  FrontmatterInput,
  FrontmatterValidationError,
} from "./templates/contract.js";
export {
  getLytHome,
  getDefaultVaultsRoot,
  resolveVaultPath,
  validateLytHome,
} from "./util/paths.js";
// v1.GP F7 — Claude-style spinner for long/network ops (hand-rolled; non-TTY
// fallback prints a plain label with zero escape codes).
export { withSpinner, startSpinner, spinnerWordForOp, renderSpinnerLine } from "./util/spinner.js";
export type {
  SpinnerOp,
  WithSpinnerOptions,
  PhaseSpinnerHandle,
  StartSpinnerOptions,
} from "./util/spinner.js";
// v1.GP WS4 — pod summary card + OSC 8 clickable links (graceful plain-text
// fallback when the terminal / pipe doesn't support hyperlinks).
export { hyperlink, fileUrlFor, renderPodCard, renderNextSteps } from "./util/pod-card.js";
export type { PodCardData, PodCardMeshRow, NextStepsOpts } from "./util/pod-card.js";
// Brief C (F2) — metadata-driven vault commit message helpers (pure; consumed
// by the lyt-mesh `lyt sync` flow to replace the terse `lyt sync: <ts>` message).
export {
  buildVaultCommitMessage,
  readFigmentTitle,
  classifyPorcelainLine,
  isFigmentPath,
  isConfigPath,
} from "./util/sync-helpers.js";
export type {
  ChangedFigment,
  FigmentChangeType,
  PorcelainChange,
  VaultCommitMessageOpts,
} from "./util/sync-helpers.js";
