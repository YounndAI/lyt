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

import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const UPDATE_PLAN_SCHEMA_ID = "lyt.update-plan";
export const UPDATE_PLAN_PACKAGES = [
  "@younndai/lyt-vault",
  "@younndai/lyt-llm",
  "@younndai/lyt-mesh",
  "@younndai/lyt-skills",
  "@younndai/lyt-runner",
  "@younndai/lyt-mcp",
  "@younndai/lyt",
] as const;

export type UpdatePackageName = (typeof UPDATE_PLAN_PACKAGES)[number];
export type UpdateChannel = "alpha" | "latest";
export type UpdateBoundaryKind =
  "npm-self-replacement" | "package-provider-content" | "skill-leaves" | "agent-manuals";
export type ManagedDestinationKind = "package" | "bin" | "skill" | "manual";
export type ManagedDestinationEvidenceKind =
  "registry-version-sri" | "provider-content-digest" | "bounded-target-identity";

export interface RegistryPackageFactV1 {
  readonly name: UpdatePackageName;
  readonly version: string;
  readonly integrity: string;
  readonly dependencies: readonly UpdatePackageName[];
  readonly tarball_url: string;
}

export interface TargetPayloadFileV1 {
  readonly path: string;
  readonly digest: string;
  readonly size: number;
}

export interface TargetArtifactV1 {
  readonly package: UpdatePackageName;
  readonly version: string;
  readonly integrity: string;
  readonly tarball_url: string;
  readonly payload_digest: string;
  readonly files: readonly TargetPayloadFileV1[];
}

export type TargetProviderObjectV1 = Readonly<{
  object_id: string;
  kind: "directory-link" | "marker-file";
  provider_package: UpdatePackageName;
  provider_version: string;
  target_path: string;
  source_relative_path: string | null;
  content: string | null;
  expected_digest: string;
  expected_applied_digest: string;
  marker_begin: string | null;
  marker_end: string | null;
}>;

export interface InstalledPackageFactV1 {
  readonly name: UpdatePackageName;
  readonly version: string | null;
  readonly integrity: string | null;
}

export interface InstalledBinFactV1 {
  readonly path: string;
  readonly digest: string | null;
}

export interface ManagedDestinationV1 {
  readonly object_id: string;
  readonly kind: ManagedDestinationKind;
  readonly path: string;
  readonly source_package: UpdatePackageName;
  readonly evidence_kind: ManagedDestinationEvidenceKind;
  readonly expected_before_digest: string | null;
  readonly expected_after_digest: string;
}

export interface UpdateBoundaryV1 {
  readonly ordinal: number;
  readonly boundary_id: string;
  readonly kind: UpdateBoundaryKind;
  readonly object_ids: readonly string[];
}

export interface UpdatePlanPayloadV1 {
  readonly schema_id: typeof UPDATE_PLAN_SCHEMA_ID;
  readonly schema_version: Readonly<{ major: 1; minor: 0 }>;
  readonly registry_url: string;
  readonly package: "@younndai/lyt";
  readonly channel: UpdateChannel;
  readonly target_version: string;
  readonly dist_integrity: string;
  readonly package_graph: readonly RegistryPackageFactV1[];
  readonly target_artifacts: readonly TargetArtifactV1[];
  readonly target_provider_objects: readonly TargetProviderObjectV1[];
  readonly before_state: Readonly<{
    packages: readonly InstalledPackageFactV1[];
    bins: readonly InstalledBinFactV1[];
  }>;
  readonly destinations: readonly ManagedDestinationV1[];
  readonly logical_replay_key: string;
  readonly operation_id: string;
  readonly boundaries: readonly UpdateBoundaryV1[];
  readonly expected_evidence: readonly string[];
}

export interface UpdatePlanV1 extends UpdatePlanPayloadV1 {
  readonly plan_digest: string;
}

export interface PrepareUpdatePlanV1Input {
  readonly registryUrl: string;
  readonly channel: UpdateChannel;
  readonly targetVersion: string;
  readonly distIntegrity: string;
  readonly packageGraph: readonly RegistryPackageFactV1[];
  readonly targetArtifacts: readonly TargetArtifactV1[];
  readonly targetProviderObjects: readonly TargetProviderObjectV1[];
  readonly beforeState: Readonly<{
    packages: readonly InstalledPackageFactV1[];
    bins: readonly InstalledBinFactV1[];
  }>;
  readonly destinations: readonly ManagedDestinationV1[];
  readonly boundaries: readonly Omit<UpdateBoundaryV1, "ordinal">[];
  readonly expectedEvidence: readonly string[];
}

export type UpdateApplyObjectState = Readonly<{
  boundary_id: string;
  status: "completed" | "pending";
  receipt_digest: string | null;
}>;

export interface ExactUpdateApplyResultV1 {
  readonly operation_id: string;
  readonly plan_digest: string;
  readonly completed: readonly string[];
  readonly pending: readonly string[];
  readonly objects: readonly UpdateApplyObjectState[];
  readonly next_action: string | null;
}

export interface ExactUpdateApplyEffects {
  revalidate(boundary: UpdateBoundaryV1, plan: UpdatePlanV1): Promise<boolean>;
  apply(boundary: UpdateBoundaryV1, plan: UpdatePlanV1): Promise<void>;
  alreadyCompleted(boundary: UpdateBoundaryV1, plan: UpdatePlanV1): Promise<boolean>;
  recordCompleted?(boundary: UpdateBoundaryV1, plan: UpdatePlanV1): Promise<string>;
}

const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SRI = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_ID = /^[a-z][a-z0-9]*(?:[-:.][a-z0-9]+)*$/;

export function prepareUpdatePlanV1(input: PrepareUpdatePlanV1Input): UpdatePlanV1 {
  const registryUrl = normalizeRegistryUrl(input.registryUrl);
  const packageGraph = [...input.packageGraph]
    .map((entry) => ({ ...entry, dependencies: [...entry.dependencies].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const beforePackages = [...input.beforeState.packages].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const beforeBins = [...input.beforeState.bins].sort((a, b) => a.path.localeCompare(b.path));
  const destinations = [...input.destinations].sort((a, b) =>
    a.object_id.localeCompare(b.object_id),
  );
  const targetArtifacts = [...input.targetArtifacts]
    .map((entry) => ({
      ...entry,
      files: [...entry.files].sort((a, b) => a.path.localeCompare(b.path)),
    }))
    .sort((a, b) => a.package.localeCompare(b.package));
  const targetProviderObjects = [...input.targetProviderObjects].sort((a, b) =>
    a.object_id.localeCompare(b.object_id),
  );
  const boundaries = input.boundaries.map((boundary, ordinal) => ({
    ...boundary,
    ordinal,
    object_ids: [...boundary.object_ids].sort(),
  }));
  const expectedEvidence = [...new Set(input.expectedEvidence)].sort();

  assertTargetVersion(input.targetVersion);
  assertIntegrity(input.distIntegrity);
  assertExactGraph(packageGraph, input.targetVersion, input.distIntegrity);
  assertTargetArtifacts(targetArtifacts, packageGraph, input.targetVersion);
  assertTargetProviderObjects(targetProviderObjects, destinations, input.targetVersion);
  assertBeforeState(beforePackages, beforeBins);
  assertDestinations(destinations);
  for (const destination of destinations.filter((entry) => entry.kind === "package")) {
    const artifact = targetArtifacts.find((entry) => entry.package === destination.source_package);
    if (artifact?.payload_digest !== destination.expected_after_digest) {
      throw new Error("update-plan-invalid-destination: package payload digest mismatch");
    }
  }
  assertBoundaries(boundaries, destinations);
  if (expectedEvidence.length === 0 || expectedEvidence.some((item) => !SAFE_ID.test(item))) {
    throw new Error("update-plan-invalid-evidence: expected evidence must be non-empty stable IDs");
  }

  const replayPayload = {
    registry_url: registryUrl,
    package: "@younndai/lyt" as const,
    channel: input.channel,
    target_version: input.targetVersion,
    dist_integrity: input.distIntegrity,
    package_graph: packageGraph,
    target_artifacts: targetArtifacts,
    target_provider_objects: targetProviderObjects,
    destinations,
  };
  const logicalReplayKey = digestCanonical(replayPayload);
  const payload: UpdatePlanPayloadV1 = {
    schema_id: UPDATE_PLAN_SCHEMA_ID,
    schema_version: { major: 1, minor: 0 },
    registry_url: registryUrl,
    package: "@younndai/lyt",
    channel: input.channel,
    target_version: input.targetVersion,
    dist_integrity: input.distIntegrity,
    package_graph: packageGraph,
    target_artifacts: targetArtifacts,
    target_provider_objects: targetProviderObjects,
    before_state: { packages: beforePackages, bins: beforeBins },
    destinations,
    logical_replay_key: logicalReplayKey,
    operation_id: digestToUuidV7(logicalReplayKey),
    boundaries,
    expected_evidence: expectedEvidence,
  };
  return Object.freeze({ ...payload, plan_digest: digestCanonical(payload) });
}

export function parseUpdatePlanV1(value: unknown): UpdatePlanV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("update-plan-invalid: expected an object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "schema_id",
    "schema_version",
    "registry_url",
    "package",
    "channel",
    "target_version",
    "dist_integrity",
    "package_graph",
    "target_artifacts",
    "target_provider_objects",
    "before_state",
    "destinations",
    "logical_replay_key",
    "operation_id",
    "boundaries",
    "expected_evidence",
    "plan_digest",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("update-plan-invalid: unknown top-level field");
  }
  const plan = record as unknown as UpdatePlanV1;
  if (
    plan.schema_id !== UPDATE_PLAN_SCHEMA_ID ||
    plan.schema_version?.major !== 1 ||
    plan.schema_version?.minor !== 0 ||
    plan.package !== "@younndai/lyt" ||
    (plan.channel !== "alpha" && plan.channel !== "latest") ||
    !UUID_V7.test(plan.operation_id ?? "") ||
    !SHA256.test(plan.logical_replay_key ?? "") ||
    !SHA256.test(plan.plan_digest ?? "")
  ) {
    throw new Error("update-plan-invalid: identity fields do not satisfy UpdatePlanV1");
  }
  const rebuilt = prepareUpdatePlanV1({
    registryUrl: plan.registry_url,
    channel: plan.channel,
    targetVersion: plan.target_version,
    distIntegrity: plan.dist_integrity,
    packageGraph: plan.package_graph,
    targetArtifacts: plan.target_artifacts,
    targetProviderObjects: plan.target_provider_objects,
    beforeState: plan.before_state,
    destinations: plan.destinations,
    boundaries: plan.boundaries.map(({ boundary_id, kind, object_ids }) => ({
      boundary_id,
      kind,
      object_ids,
    })),
    expectedEvidence: plan.expected_evidence,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(plan)) {
    throw new Error("update-plan-tampered: plan bytes do not match the sealed digest");
  }
  return rebuilt;
}

export async function applyExactUpdatePlanV1(
  value: unknown,
  effects: ExactUpdateApplyEffects,
): Promise<ExactUpdateApplyResultV1> {
  const plan = parseUpdatePlanV1(value);
  const completed: string[] = [];
  const pending: string[] = [];
  const objects: UpdateApplyObjectState[] = [];
  for (const boundary of plan.boundaries) {
    if (await effects.alreadyCompleted(boundary, plan)) {
      completed.push(boundary.boundary_id);
      objects.push({
        boundary_id: boundary.boundary_id,
        status: "completed",
        receipt_digest: null,
      });
      continue;
    }
    if (!(await effects.revalidate(boundary, plan))) {
      pending.push(boundary.boundary_id);
      objects.push({ boundary_id: boundary.boundary_id, status: "pending", receipt_digest: null });
      for (const later of plan.boundaries.slice(boundary.ordinal + 1)) {
        pending.push(later.boundary_id);
        objects.push({ boundary_id: later.boundary_id, status: "pending", receipt_digest: null });
      }
      break;
    }
    await effects.apply(boundary, plan);
    const receiptDigest = (await effects.recordCompleted?.(boundary, plan)) ?? null;
    completed.push(boundary.boundary_id);
    objects.push({
      boundary_id: boundary.boundary_id,
      status: "completed",
      receipt_digest: receiptDigest,
    });
  }
  return Object.freeze({
    operation_id: plan.operation_id,
    plan_digest: plan.plan_digest,
    completed: Object.freeze(completed),
    pending: Object.freeze(pending),
    objects: Object.freeze(objects),
    next_action:
      pending.length === 0 ? null : `lyt install reconcile --resume ${plan.operation_id} --apply`,
  });
}

function normalizeRegistryUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("update-plan-invalid-registry: registry URL is invalid");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new Error(
      "update-plan-invalid-registry: registry URL must be HTTP(S) without credentials",
    );
  }
  url.hash = "";
  url.search = "";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url.toString();
}

function assertTargetVersion(value: string): void {
  if (!SEMVER.test(value))
    throw new Error("update-plan-invalid-version: target must be exact semver");
}

function assertIntegrity(value: string): void {
  if (!SRI.test(value)) throw new Error("update-plan-invalid-integrity: expected sha512 SRI");
  const bytes = Buffer.from(value.slice("sha512-".length), "base64");
  if (bytes.length !== 64 || `sha512-${bytes.toString("base64")}` !== value) {
    throw new Error("update-plan-invalid-integrity: expected canonical 64-byte SHA512 SRI");
  }
}

function assertExactGraph(
  graph: readonly RegistryPackageFactV1[],
  targetVersion: string,
  targetIntegrity: string,
): void {
  const names = graph.map((entry) => entry.name).sort();
  const expected = [...UPDATE_PLAN_PACKAGES].sort();
  if (canonicalJson(names) !== canonicalJson(expected)) {
    throw new Error("update-plan-invalid-graph: exact seven-package graph required");
  }
  for (const entry of graph) {
    assertTargetVersion(entry.version);
    assertIntegrity(entry.integrity);
    if (entry.version !== targetVersion) {
      throw new Error("update-plan-invalid-graph: all seven packages must use the target version");
    }
    try {
      const tarball = new URL(entry.tarball_url);
      if (tarball.protocol !== "https:" || tarball.username || tarball.password)
        throw new Error("unsafe");
    } catch {
      throw new Error("update-plan-invalid-graph: exact HTTPS tarball URL required");
    }
    if (entry.dependencies.some((name) => !UPDATE_PLAN_PACKAGES.includes(name))) {
      throw new Error("update-plan-invalid-graph: dependency is outside the seven-package graph");
    }
  }
  const meta = graph.find((entry) => entry.name === "@younndai/lyt");
  if (meta?.integrity !== targetIntegrity) {
    throw new Error("update-plan-invalid-graph: meta-package SRI must match dist.integrity");
  }
}

function assertTargetArtifacts(
  artifacts: readonly TargetArtifactV1[],
  graph: readonly RegistryPackageFactV1[],
  targetVersion: string,
): void {
  if (artifacts.length !== UPDATE_PLAN_PACKAGES.length) {
    throw new Error("update-plan-invalid-artifacts: exact seven target artifacts required");
  }
  for (const artifact of artifacts) {
    const fact = graph.find((entry) => entry.name === artifact.package);
    if (
      fact === undefined ||
      artifact.version !== targetVersion ||
      artifact.integrity !== fact.integrity ||
      artifact.tarball_url !== fact.tarball_url ||
      !SHA256.test(artifact.payload_digest) ||
      artifact.files.length === 0 ||
      artifact.files.length > 10_000
    ) {
      throw new Error("update-plan-invalid-artifacts: artifact identity or payload invalid");
    }
    const paths = new Set<string>();
    for (const file of artifact.files) {
      if (
        !safePayloadPath(file.path) ||
        paths.has(file.path) ||
        !SHA256.test(file.digest) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0
      ) {
        throw new Error("update-plan-invalid-artifacts: file manifest invalid");
      }
      paths.add(file.path);
    }
    if (digestCanonical(artifact.files) !== artifact.payload_digest) {
      throw new Error("update-plan-invalid-artifacts: payload digest mismatch");
    }
  }
}

function assertTargetProviderObjects(
  objects: readonly TargetProviderObjectV1[],
  destinations: readonly ManagedDestinationV1[],
  targetVersion: string,
): void {
  const ids = new Set<string>();
  for (const object of objects) {
    const destination = destinations.find((entry) => entry.object_id === object.object_id);
    if (
      !SAFE_ID.test(object.object_id) ||
      ids.has(object.object_id) ||
      !UPDATE_PLAN_PACKAGES.includes(object.provider_package) ||
      (object.kind === "directory-link" && object.provider_package !== "@younndai/lyt-skills") ||
      (object.kind === "marker-file" && object.provider_package !== "@younndai/lyt-vault") ||
      object.provider_version !== targetVersion ||
      !object.target_path ||
      !SHA256.test(object.expected_digest) ||
      !SHA256.test(object.expected_applied_digest) ||
      destination?.expected_after_digest !== object.expected_applied_digest
    ) {
      throw new Error("update-plan-invalid-provider-objects");
    }
    if (
      object.kind === "directory-link"
        ? object.content !== null || !safePayloadPath(object.source_relative_path ?? "")
        : object.source_relative_path !== null ||
          typeof object.content !== "string" ||
          object.marker_begin === null ||
          object.marker_end === null
    ) {
      throw new Error("update-plan-invalid-provider-objects");
    }
    ids.add(object.object_id);
  }
}

function safePayloadPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length < 500 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function assertBeforeState(
  packages: readonly InstalledPackageFactV1[],
  bins: readonly InstalledBinFactV1[],
): void {
  if (packages.length !== UPDATE_PLAN_PACKAGES.length) {
    throw new Error("update-plan-invalid-before-state: exact seven-package state required");
  }
  if (new Set(packages.map((entry) => entry.name)).size !== packages.length) {
    throw new Error("update-plan-invalid-before-state: duplicate package");
  }
  for (const entry of packages) {
    if (!UPDATE_PLAN_PACKAGES.includes(entry.name)) {
      throw new Error("update-plan-invalid-before-state: unknown package");
    }
    if (entry.version !== null) assertTargetVersion(entry.version);
    if (entry.integrity !== null) assertIntegrity(entry.integrity);
  }
  for (const entry of bins) {
    if (!entry.path || (entry.digest !== null && !SHA256.test(entry.digest))) {
      throw new Error("update-plan-invalid-before-state: invalid bin observation");
    }
  }
}

function assertDestinations(destinations: readonly ManagedDestinationV1[]): void {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const destination of destinations) {
    const normalizedPath = resolve(destination.path).replace(/\\/g, "/").toLowerCase();
    if (
      !SAFE_ID.test(destination.object_id) ||
      ids.has(destination.object_id) ||
      !destination.path ||
      !["registry-version-sri", "provider-content-digest", "bounded-target-identity"].includes(
        destination.evidence_kind,
      ) ||
      !UPDATE_PLAN_PACKAGES.includes(destination.source_package) ||
      !SHA256.test(destination.expected_after_digest) ||
      (destination.expected_before_digest !== null &&
        !SHA256.test(destination.expected_before_digest)) ||
      paths.has(normalizedPath)
    ) {
      throw new Error("update-plan-invalid-destination: destination identity or digest invalid");
    }
    ids.add(destination.object_id);
    paths.add(normalizedPath);
  }
}

function assertBoundaries(
  boundaries: readonly UpdateBoundaryV1[],
  destinations: readonly ManagedDestinationV1[],
): void {
  const objectIds = new Set(destinations.map((entry) => entry.object_id));
  const seenBoundary = new Set<string>();
  const seenObject = new Set<string>();
  for (const [ordinal, boundary] of boundaries.entries()) {
    if (
      boundary.ordinal !== ordinal ||
      !SAFE_ID.test(boundary.boundary_id) ||
      seenBoundary.has(boundary.boundary_id) ||
      ![
        "npm-self-replacement",
        "package-provider-content",
        "skill-leaves",
        "agent-manuals",
      ].includes(boundary.kind)
    ) {
      throw new Error("update-plan-invalid-boundary: order or identity invalid");
    }
    seenBoundary.add(boundary.boundary_id);
    for (const objectId of boundary.object_ids) {
      if (!objectIds.has(objectId) || seenObject.has(objectId)) {
        throw new Error("update-plan-invalid-boundary: object missing or repeated");
      }
      seenObject.add(objectId);
    }
  }
  if (seenObject.size !== objectIds.size) {
    throw new Error("update-plan-invalid-boundary: every destination must belong to one boundary");
  }
}

function digestToUuidV7(digest: string): string {
  const chars = digest.slice(0, 32).split("");
  chars[12] = "7";
  chars[16] = ["8", "9", "a", "b"][Number.parseInt(chars[16]!, 16) % 4]!;
  const raw = chars.join("");
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

export function digestCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
