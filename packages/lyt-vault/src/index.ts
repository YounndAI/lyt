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

export { initVault } from "./scaffold/init.js";
export type { InitOptions, InitResult } from "./scaffold/init.js";
export { adoptVault } from "./scaffold/adopt.js";
export type { AdoptOptions, AdoptResult } from "./scaffold/adopt.js";
export { deleteVaultDerivedState } from "./scaffold/delete.js";
export type { DeleteScaffoldResult } from "./scaffold/delete.js";

export { initVaultFlow, HomeMeshNotFoundError } from "./flows/init.js";
export type { InitFlowOptions, InitFlowResult, MeshSelfHealOptions } from "./flows/init.js";
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
} from "./flows/mesh-adopt-cluster.js";
export type {
  AdoptCloneFn,
  AdoptClusterArgs,
  AdoptClusterCloneArgs,
  AdoptClusterCloneResult,
  AdoptClusterResult,
  AdoptedMemberSummary,
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
export { buildAgentManualCommand } from "./commands/agent-manual.js";
// v1.G.4 — setup wizard surface (runWizard + IPromptHandler default impl).
// Consumed by packages/lyt/src/commands/init.ts via `lyt init --wizard`.
// Release review Arch-M1 fix-pass: the 10 individual phase functions are NOT
// exported here — they are wizard-internal. Tests import them via the
// `../../src/flows/wizard.js` relative path, keeping the public surface
// minimal (runWizard is the only public entry). v1.G.10 preserves this
// — `phase9_podMapInit` stays wizard-internal per G.4 Arch-M1 precedent.
export { ReadlinePromptHandler, runWizard } from "./flows/wizard.js";
export type {
  AgentRuntimeChoice,
  IPromptHandler,
  WizardPhaseResult,
  WizardRunOptions,
  WizardRunResult,
} from "./flows/wizard.js";
// v1.G.10 — pod-map vault generator (markdown emitter; the Pod Manager
// Obsidian plugin reads `vault.kind: pod-map` to activate). Generator
// is invoked by wizard P9 (first-time setup) and is the future surface
// for /lyt-sync regen hooks (deferred per @DELTA_FROM_BRIEF — no TS
// sync flow exists today; see retro). `installPodManagerPlugin` is
// exported for wizard P9b consumption + future post-alpha community-
// store distribution surface.
export { generatePodMapFlow, installPodManagerPlugin } from "./flows/pod-map-generate.js";
export type {
  InstallPluginArgs,
  InstallPluginResult,
  PodMapArgs,
  PodMapResult,
  PodMapVaultPaths,
} from "./flows/pod-map-generate.js";
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
  isScaffoldNote,
  toVaultRelPosix,
} from "./flows/upsert-fts-cache.js";
export type {
  UpsertFtsCacheResult,
  UpsertFtsCacheOpts,
  ExtractedFtsBody,
  FigmentDates,
} from "./flows/upsert-fts-cache.js";
export {
  insertFtsDoc,
  deleteAllFts,
  deleteFtsByPath,
  upsertFtsDocByPath,
  countFtsDocs,
  searchFts,
} from "./registry/fts-repo.js";
export type { FtsHitRow, InsertFtsDocArgs } from "./registry/fts-repo.js";
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
} from "./registry/figment-meta-repo.js";
export type { FigmentMeta, RecentFigmentRow, KeywordSignal } from "./registry/figment-meta-repo.js";
// Lane V Phase 0 (0.5 / C1-C3) — all-tiers rebuild umbrella + pod/mesh/vault reindex.
export { rebuildVaultFlow } from "./flows/rebuild-vault.js";
export type { RebuildVaultArgs, RebuildVaultResult } from "./flows/rebuild-vault.js";
export { reindexFlow } from "./flows/reindex.js";
export type { ReindexArgs, ReindexResult, ReindexScope } from "./flows/reindex.js";
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
// V-C-1 (Lane V Track C) — index-on-write (L1): the single seam every capture
// path calls after writing a figment so search/recall/primer hit with NO manual
// reindex (FTS reconcile + per-vault lanes/arcs; cross-vault rollup deferred).
export { captureIndexFlow } from "./flows/capture-index.js";
export type { CaptureIndexArgs, CaptureIndexResult } from "./flows/capture-index.js";
// v1.G.2 writability derivation + the hardening pass cheap-local read-only
// signal. `isPureSubscriberVault` is the no-gh-probe pure-subscriber detector
// the capture write-gate and the sync skip-decision share so a
// known-unwritable vault is refused/skipped without a network round-trip.
export {
  deriveVaultWritable,
  isPureSubscriberVault,
  loadRoleSummary,
  __clearWritabilityCache,
} from "./flows/writability.js";
export type {
  WritabilityVerdict,
  DeriveVaultWritableOpts,
  RoleSummary,
} from "./flows/writability.js";
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
} from "./flows/search-cascade.js";
export type {
  SearchCascadeArgs,
  SearchCascadeResult,
  SearchCascadeScope,
  SearchResult,
  SearchTrace,
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
export { doctorFlow, renderHumanReport } from "./flows/doctor.js";
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
  DESCRIPTION_PREFIX,
  DESCRIPTION_SUFFIX,
  formatRepoDescription,
  mergeTopics,
} from "./scaffold/github-defaults.js";
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
  getNotesIndexContent,
  regenInstalledPatternsSection,
  regenInstalledPrimerSection,
} from "./templates/priming.js";
export type { AgentsMdInput, InstalledPatternSummary } from "./templates/priming.js";
export { regenAgentsMd, collectInstalledPatterns } from "./flows/agents-md-regen.js";
export type { RegenAgentsMdResult } from "./flows/agents-md-regen.js";
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
export { deleteAllSubscriptionsByMesh } from "./registry/mesh-subscriptions-repo.js";
export { deleteAllVaultsByMesh } from "./registry/mesh-vaults-repo.js";
export type { GhClient, GhRepoInfo } from "./util/gh.js";
export { parseOwnerRepoFromUrl } from "./util/gh.js";

export { openRegistry, closeRegistry, getRegistryPath } from "./registry/client.js";
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
  insertMesh,
  getMeshByRid,
  getMeshByName,
  listMeshes,
  updateMeshMainVault,
  deleteMesh,
} from "./registry/meshes-repo.js";
export type { MeshRow, InsertMeshArgs, MeshPushKind } from "./registry/meshes-repo.js";
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
// D31 (Brief A) — the derived pod manifest (`pod.yon`) regen surface. The meta
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
export { materializeVaultPublishable, commitPodRepo } from "./flows/federation/vault-publish.js";
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
// Brief B (B.2) — the reconcile/publish engine + the resumable outbox.
export { reconcilePublishFlow } from "./flows/federation/reconcile-publish.js";
export type {
  ReconcilePublishArgs,
  ReconcilePublishResult,
  VaultPublishOutcome,
  VaultPublishStatus,
} from "./flows/federation/reconcile-publish.js";
// Brief D (D.3, OD-D1) — the connect self-heal: `lyt sync` reconciles a
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
export { recoverVaultsFromPodManifest } from "./flows/federation/recover-pod.js";
export type {
  RecoverPodArgs,
  RecoverPodResult,
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
export { getFederationRepoDir, getFederationYonPath } from "./util/federation-paths.js";
// Brief B (D31 §3-§6) — minimal config seam (publish/visibility/conflict
// defaults). The full config.yon layer is deferred (flagged for oversight).
export {
  resolveConfig,
  DEFAULT_LYT_CONFIG,
  type LytConfig,
  type PublishPromptDefault,
  type ConflictPosture,
  type ResolveConfigOptions,
} from "./util/config.js";
// Brief B (OD-B1 scheme D) — vault repo-name chokepoint family + the pod repo
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
  // D34 (OD-LOCALFIRST) — provisional→real handle remap (preserves fed_rid).
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

// v1.B.6 — public-mesh hygiene check + publish/info flows + commands.
export { checkPublicMeshHygiene, DEFAULT_PUBLIC_MESH_HYGIENE_PATTERNS } from "./flows/doctor.js";
export type { PublicMeshHygieneOptions } from "./flows/doctor.js";
export {
  publishMeshFlow,
  isMeshPublic,
  PublishMeshNotFoundError,
  PublishMeshStrictFailureError,
} from "./flows/mesh-publish.js";
export type {
  PublishMeshArgs,
  PublishMeshResult,
  PublishSubActionResult,
  PublishSubActionStatus,
} from "./flows/mesh-publish.js";
export {
  meshInfoFlow,
  MeshInfoNotFoundError,
  MeshInfoRemoteGhUnavailableError,
  MeshInfoRemoteMeshYonMissingError,
} from "./flows/mesh-info.js";
export type {
  MeshInfoArgs,
  MeshInfoResult,
  MeshInfoPublicMeta,
  MeshInfoUpdateCadence,
  MeshInfoHomeVault,
} from "./flows/mesh-info.js";
export { realPublishGhClient, makeFakePublishGhClient } from "./util/gh-mesh-publish.js";
export type {
  PublishGhClient,
  FakePublishGhClient,
  FakePublishGhClientInit,
} from "./util/gh-mesh-publish.js";
export { detectLicenseFromContent } from "./util/license-detect.js";
export type { DetectedLicense, LicenseBucket } from "./util/license-detect.js";
// v1.B.6 Commit 3 — cadence + license-warnings + extended info.
export {
  setVaultUpdateCadenceFlow,
  VaultUpdateCadenceNotFoundError,
  VaultUpdateCadenceNoHomeMeshError,
  VaultUpdateCadenceFlagComboError,
} from "./flows/vault-update-cadence.js";
export type {
  VaultUpdateCadenceArgs,
  VaultUpdateCadenceResult,
} from "./flows/vault-update-cadence.js";
export {
  setMeshDefaultCadenceFlow,
  MeshUpdateCadenceNotFoundError,
} from "./flows/mesh-update-cadence.js";
export type {
  MeshUpdateCadenceArgs,
  MeshUpdateCadenceResult,
} from "./flows/mesh-update-cadence.js";
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
export { recordAudit, reinjectAuditRecord, getAuditLedgerPath } from "./registry/audit-write.js";
export type {
  RecordAuditArgs,
  RecordAuditResult,
  AuditLedgerFields,
} from "./registry/audit-write.js";
export {
  recordProvenance,
  reinjectProvenanceRecord,
  getProvenanceLedgerPath,
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
export { parseMeshYon, parseMeshPublic, parseMeshUpdateCadences } from "./yon/mesh-read.js";
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
  MeshEdgeRecord,
  MeshHomeRecord,
  MeshPublicRecord,
  MeshPushKind as MeshDocPushKind,
  MeshRecord,
  MeshSubscriptionRecord,
  MeshUpdateCadenceRecord,
  MeshUpdateCadenceType,
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
export { relinkAllPatternsForVault } from "./flows/pattern-relink-vault.js";
export {
  getUserPatternsDir,
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
  // D34 (OD-LOCALFIRST) — provisional-handle derivation (default OS username).
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
  resolvePodIdentity,
  reconcileIdentity,
  // D34 (OD-LOCALFIRST) — provisional identity surface (local-first init +
  // connect self-heal): write/detect a provisional identity + the source consts.
  writeProvisionalIdentity,
  isProvisionalIdentity,
  IDENTITY_SOURCE_PROVISIONAL,
  IDENTITY_SOURCE_GH,
} from "./util/identity-cache.js";
export type {
  CachedIdentity,
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
  gitStatusPorcelain,
  hasUpstream,
  isGitRepo,
  listBranchesWithPrefix,
  runGit,
  slugify,
  timestampForBranchName,
} from "./util/git-run.js";
export type {
  AheadBehind,
  BranchInfo,
  GitRunOptions,
  GitRunResult,
  PorcelainStatus,
} from "./util/git-run.js";

export { buildVaultSubcommand, buildRegistrySubcommand } from "./vault-command.js";
export { registerVaultVerbs } from "./register-verbs.js";

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

export { DEFAULT_TEMPLATE } from "./templates/index.js";
export type { TemplateName } from "./templates/index.js";
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
