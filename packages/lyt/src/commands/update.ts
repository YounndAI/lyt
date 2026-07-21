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

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";

import { Command, InvalidArgumentError } from "commander";

import {
  checkCurrency,
  formatCurrencyLine,
  isUpdateChannel,
  readUpdateChannel,
  resolveUpdateAction,
  writeUpdateChannel,
  type CurrencyResult,
  type UpdateChannel,
} from "@younndai/lyt-vault";
import {
  canonicalJson,
  digestCanonical,
  applyExactUpdatePlanV1,
  parseUpdatePlanV1,
  prepareUpdatePlanV1,
  UPDATE_PLAN_PACKAGES,
  type RegistryPackageFactV1,
  type UpdatePlanV1,
} from "../install/update-plan.js";
import {
  prepareInstallReconcilePlanV1,
  type InstallReconcilePlanV1,
} from "../install/reconcile-engine.js";
import {
  beginUpdateOperationV1,
  defaultUpdateOperationRoot,
  readUpdateOperationPlanV1,
  type UpdateOperationHandleV1,
} from "../install/update-operation.js";
import {
  inspectTargetTarballBytes,
  materializeTargetProviders,
  providersFromUpdatePlan,
  stageTargetArtifactsV1,
  verifyInstalledPayloadV1,
  writeInstalledStateAnchorV1,
  type TargetProviderManifestV1,
} from "../install/target-artifacts.js";
import { detectInstalledRuntimes } from "@younndai/lyt-vault";

interface UpdateCliOpts {
  check?: boolean;
  yes?: boolean;
  json?: boolean;
  channel?: UpdateChannel;
  switchChannel?: boolean;
  allowDowngrade?: boolean;
  resume?: string;
  configure?: boolean;
}

export interface UpdateChannelConfiguredV1 {
  readonly schema_id: "lyt.update-channel-configured";
  readonly schema_version: Readonly<{ major: 1; minor: 0 }>;
  readonly channel: UpdateChannel;
  readonly persisted: true;
  readonly next_action: "lyt update --check --json";
}

export function configureUpdateChannel(
  channel: UpdateChannel,
  write: (value: UpdateChannel) => void = writeUpdateChannel,
): UpdateChannelConfiguredV1 {
  write(channel);
  return Object.freeze({
    schema_id: "lyt.update-channel-configured",
    schema_version: Object.freeze({ major: 1, minor: 0 }),
    channel,
    persisted: true,
    next_action: "lyt update --check --json",
  });
}

export interface ReconcileReceiptV1 {
  schema_id: "lyt.receipt";
  schema_version: Readonly<{ major: 1; minor: 0 }>;
  operation_id: string;
  attempt_id: string;
  status: string;
  operation: "install-reconcile";
  mutations: Readonly<{ local: number; remote: number }>;
  next_action: unknown;
}

interface ReconcileEnvelopeV1 {
  schema_id: "lyt.install-reconcile-result";
  schema_version: Readonly<{ major: 1; minor: 0 }>;
  operation_id: string;
  attempt_id: string;
  status: string;
  success: boolean;
  mutations: number;
  completed: unknown[];
  pending: unknown[];
  refused: unknown[];
  next_action: unknown;
  receipt: ReconcileReceiptV1;
  plan: Readonly<{
    objects: readonly Readonly<{
      object_id: string;
      expected_digest: string;
      expected_applied_digest: string;
    }>[];
  }>;
}

export interface ReconcileEffectResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Injected effects — so the update boundary is testable without touching the
// network, readline, a real global npm install, or a newly installed CLI.
export interface UpdateEffects {
  log: (msg: string) => void;
  error: (msg: string) => void;
  confirm: (prompt: string) => Promise<boolean>;
  preparePlan: (currency: CurrencyResult) => Promise<UpdatePlanV1>;
  revalidatePlan: (plan: UpdatePlanV1) => Promise<boolean>;
  verifyInstalledPlan: (plan: UpdatePlanV1) => Promise<boolean>;
  beginOperation: (plan: UpdatePlanV1) => Promise<UpdateOperationHandleV1 | null>;
  stageArtifacts: (plan: UpdatePlanV1) => Promise<readonly string[]>;
  writeInstalledAnchor: (plan: UpdatePlanV1) => boolean;
  /** Runs the global exact-version npm install; returns npm's exit status. */
  install: (plan: UpdatePlanV1, artifacts: readonly string[]) => number;
  /** Invokes the replacement binary's exact `install reconcile` command. */
  reconcile: (plan: UpdatePlanV1) => ReconcileEffectResult;
}

export interface UpdateFlowResult {
  /** npm completed the package replacement. This is NOT an atomic managed-content claim. */
  installed: boolean;
  /** A separately launched 0.20+ reconcile emitted and passed a Receipt V1. */
  reconciled: boolean;
  reconcileReceipt: ReconcileReceiptV1 | null;
  exitCode: number;
  nextAction?: string;
  updatePlan?: UpdatePlanV1;
}

export interface UpdateChannelResolution {
  channel: UpdateChannel | null;
  source: "persisted" | "explicit" | "interactive" | "unconfigured";
  refusal?: "channel-unconfigured" | "channel-switch-requires-explicit";
  nextAction?: string;
}

function parseChannel(value: string): UpdateChannel {
  if (isUpdateChannel(value)) return value;
  throw new InvalidArgumentError("--channel must be alpha or latest");
}

function readMetaVersion(): string {
  return (createRequire(import.meta.url)("../../package.json") as { version: string }).version;
}

export function resolveConfiguredChannel(
  requested: UpdateChannel | undefined,
  persisted: UpdateChannel | null,
  opts: {
    switchChannel?: boolean;
    interactive: boolean;
    selectedInteractive?: UpdateChannel | null;
  },
): UpdateChannelResolution {
  if (requested !== undefined) {
    if (persisted !== null && requested !== persisted && opts.switchChannel !== true) {
      return {
        channel: null,
        source: "explicit",
        refusal: "channel-switch-requires-explicit",
        nextAction: `lyt update --channel ${requested} --switch-channel`,
      };
    }
    return { channel: requested, source: "explicit" };
  }
  if (persisted !== null) return { channel: persisted, source: "persisted" };
  if (opts.interactive && opts.selectedInteractive !== undefined) {
    if (opts.selectedInteractive !== null)
      return { channel: opts.selectedInteractive, source: "interactive" };
    return {
      channel: null,
      source: "unconfigured",
      refusal: "channel-unconfigured",
      nextAction: "lyt update --channel alpha",
    };
  }
  return {
    channel: null,
    source: "unconfigured",
    refusal: "channel-unconfigured",
    nextAction: "lyt update --channel alpha",
  };
}

export function parseReconcileReceipt(
  raw: string,
  updatePlan?: UpdatePlanV1,
): ReconcileReceiptV1 | null {
  try {
    const value = JSON.parse(raw) as Partial<ReconcileEnvelopeV1>;
    const receipt = value.receipt;
    if (
      value.schema_id !== "lyt.install-reconcile-result" ||
      value.schema_version?.major !== 1 ||
      value.schema_version?.minor !== 0 ||
      typeof value.operation_id !== "string" ||
      typeof value.attempt_id !== "string" ||
      typeof value.status !== "string" ||
      typeof value.success !== "boolean" ||
      value.success !== true ||
      (value.status !== "success" && value.status !== "no-op") ||
      !Number.isInteger(value.mutations) ||
      (value.mutations ?? -1) < 0 ||
      !Array.isArray(value.completed) ||
      !Array.isArray(value.pending) ||
      !Array.isArray(value.refused) ||
      value.pending.length !== 0 ||
      value.refused.length !== 0 ||
      value.next_action !== null ||
      !("mutations" in value) ||
      !("next_action" in value) ||
      receipt?.schema_id !== "lyt.receipt" ||
      receipt.schema_version?.major !== 1 ||
      receipt.schema_version?.minor !== 0 ||
      receipt.operation !== "install-reconcile" ||
      receipt.operation_id !== value.operation_id ||
      receipt.attempt_id !== value.attempt_id ||
      receipt.status !== value.status ||
      !receipt.mutations ||
      receipt.mutations.local !== value.mutations ||
      receipt.mutations.remote !== 0 ||
      receipt.next_action !== null
    ) {
      return null;
    }
    if (updatePlan !== undefined) {
      const completed = [...value.completed].sort();
      const expected = [...updatePlan.target_provider_objects].sort((a, b) =>
        a.object_id.localeCompare(b.object_id),
      );
      const actual = [...(value.plan?.objects ?? [])]
        .filter((object) => expected.some((entry) => entry.object_id === object.object_id))
        .sort((a, b) => a.object_id.localeCompare(b.object_id));
      if (
        canonicalJson(completed) !== canonicalJson(expected.map((object) => object.object_id)) ||
        canonicalJson(
          actual.map((object) => ({
            object_id: object.object_id,
            expected_digest: object.expected_digest,
            expected_applied_digest: object.expected_applied_digest,
          })),
        ) !==
          canonicalJson(
            expected.map((object) => ({
              object_id: object.object_id,
              expected_digest: object.expected_digest,
              expected_applied_digest: object.expected_applied_digest,
            })),
          )
      )
        return null;
    }
    return receipt;
  } catch {
    return null;
  }
}

// The load-bearing safety flow: map a sealed currency observation → explicit
// confirmation → npm replacement → a NEW process running reconciliation. The
// running updater never claims atomicity across its own replacement and managed
// skills/manual homes.
export async function runUpdateFlow(
  result: CurrencyResult,
  opts: { yes?: boolean; interactive: boolean; allowDowngrade?: boolean },
  fx: UpdateEffects,
): Promise<UpdateFlowResult> {
  const action = resolveUpdateAction(result, {
    yes: opts.yes,
    interactive: opts.interactive,
    allowDowngrade: opts.allowDowngrade,
  });
  switch (action.kind) {
    case "channel-unconfigured":
      fx.error(action.message);
      return {
        installed: false,
        reconciled: false,
        reconcileReceipt: null,
        exitCode: 2,
        nextAction: action.nextAction,
      };
    case "offline":
    case "current":
    case "ahead-of-channel":
      (action.kind === "ahead-of-channel" ? fx.error : fx.log)(action.message);
      return {
        installed: false,
        reconciled: false,
        reconcileReceipt: null,
        exitCode: action.kind === "ahead-of-channel" ? 2 : 0,
      };
    case "blocked-noninteractive":
      fx.error(action.message);
      return { installed: false, reconciled: false, reconcileReceipt: null, exitCode: 1 };
    case "needs-confirm": {
      return prepareAndFinishInstall(result, fx, async (plan) =>
        fx.confirm(
          `${action.message} Exact target ${plan.target_version}; sealed plan ${plan.plan_digest}. [y/N] `,
        ),
      );
    }
    case "proceed":
      fx.log(action.message);
      return prepareAndFinishInstall(result, fx);
  }
}

async function prepareAndFinishInstall(
  currency: CurrencyResult,
  fx: UpdateEffects,
  confirmation?: (plan: UpdatePlanV1) => Promise<boolean>,
): Promise<UpdateFlowResult> {
  let plan: UpdatePlanV1;
  try {
    plan = parseUpdatePlanV1(await fx.preparePlan(currency));
  } catch (error) {
    fx.error(`lyt update: could not seal the exact update plan (${String(error)}).`);
    return { installed: false, reconciled: false, reconcileReceipt: null, exitCode: 1 };
  }
  if (confirmation !== undefined && !(await confirmation(plan))) {
    fx.log("Update cancelled.");
    return {
      installed: false,
      reconciled: false,
      reconcileReceipt: null,
      exitCode: 0,
      updatePlan: plan,
    };
  }
  return finishInstall(plan, fx);
}

async function finishInstall(plan: UpdatePlanV1, fx: UpdateEffects): Promise<UpdateFlowResult> {
  const alreadyInstalled = await fx.verifyInstalledPlan(plan);
  if (!alreadyInstalled && !(await fx.revalidatePlan(plan))) {
    fx.error(
      "lyt update: sealed registry, package graph, or destination evidence changed; no install started.",
    );
    return {
      installed: false,
      reconciled: false,
      reconcileReceipt: null,
      exitCode: 1,
      updatePlan: plan,
    };
  }
  let operation: UpdateOperationHandleV1 | null;
  try {
    operation = await fx.beginOperation(plan);
  } catch (error) {
    fx.error(`lyt update: could not open the durable update operation (${String(error)}).`);
    return {
      installed: false,
      reconciled: false,
      reconcileReceipt: null,
      exitCode: 1,
      nextAction: "lyt doctor --json",
      updatePlan: plan,
    };
  }
  if (operation === null) {
    fx.error("lyt update: the Phase-A update receipt store is unavailable; no install started.");
    return {
      installed: false,
      reconciled: false,
      reconcileReceipt: null,
      exitCode: 1,
      updatePlan: plan,
    };
  }
  if (operation.alreadyCompleted) {
    fx.log(`lyt update: sealed operation ${plan.operation_id} is already complete.`);
    return {
      installed: true,
      reconciled: true,
      reconcileReceipt: null,
      exitCode: 0,
      updatePlan: plan,
    };
  }
  let artifactPaths: readonly string[] = [];
  if (!alreadyInstalled) {
    try {
      artifactPaths = await fx.stageArtifacts(plan);
    } catch (error) {
      fx.error(`lyt update: exact target artifacts could not be staged (${String(error)}).`);
      return {
        installed: false,
        reconciled: false,
        reconcileReceipt: null,
        exitCode: 1,
        nextAction: `lyt update --resume ${plan.operation_id} --yes`,
        updatePlan: plan,
      };
    }
  }
  const status = alreadyInstalled ? 0 : fx.install(plan, artifactPaths);
  if (status !== 0) {
    fx.error(
      `lyt update: exact @younndai/lyt@${plan.target_version} install failed (exit ${status}).`,
    );
    return {
      installed: false,
      reconciled: false,
      reconcileReceipt: null,
      exitCode: 1,
      nextAction: `lyt update --resume ${plan.operation_id} --yes`,
      updatePlan: plan,
    };
  }
  if (!(await fx.verifyInstalledPlan(plan))) {
    fx.error(
      "lyt update: npm returned success, but the seven exact installed versions or sealed same-registry package graph did not verify.",
    );
    return {
      installed: false,
      reconciled: false,
      reconcileReceipt: null,
      exitCode: 1,
      nextAction: `lyt update --resume ${plan.operation_id} --yes`,
      updatePlan: plan,
    };
  }
  if (!(await operation.finalizeCompleted())) {
    fx.error(
      "lyt update: npm replacement verified, but the authoritative update receipt was not persisted.",
    );
    return {
      installed: true,
      reconciled: false,
      reconcileReceipt: null,
      exitCode: 1,
      nextAction: `lyt update --resume ${plan.operation_id} --yes`,
      updatePlan: plan,
    };
  }

  const reconciliation = fx.reconcile(plan);
  const receipt =
    reconciliation.exitCode === 0 ? parseReconcileReceipt(reconciliation.stdout, plan) : null;
  if (receipt === null || (receipt.status !== "success" && receipt.status !== "no-op")) {
    const detail = reconciliation.stderr.trim() || reconciliation.stdout.trim();
    fx.error(
      "lyt update: npm replacement completed, but the replacement Lyt did not return an authoritative reconciliation Receipt. " +
        "Run `lyt install reconcile --apply --json` in a new process; start a fresh agent session before expecting managed skills or manuals to be loaded." +
        (detail.length > 0 ? ` Detail: ${detail.slice(0, 500)}` : ""),
    );
    return {
      installed: true,
      reconciled: false,
      reconcileReceipt: receipt,
      exitCode: 1,
      nextAction: "lyt install reconcile --apply --json",
      updatePlan: plan,
    };
  }
  const receiptDigest = digestCanonical(receipt);
  if (!fx.writeInstalledAnchor(plan)) {
    fx.error(
      "lyt update: reconciliation succeeded, but installed-state evidence was not anchored.",
    );
    return {
      installed: true,
      reconciled: false,
      reconcileReceipt: receipt,
      exitCode: 1,
      nextAction: `lyt update --resume ${plan.operation_id} --yes`,
      updatePlan: plan,
    };
  }
  if (!(await operation.recordReconciled(receiptDigest))) {
    fx.error("lyt update: reconciliation succeeded, but its boundary evidence was not journaled.");
    return {
      installed: true,
      reconciled: false,
      reconcileReceipt: receipt,
      exitCode: 1,
      nextAction: `lyt update --resume ${plan.operation_id} --yes`,
      updatePlan: plan,
    };
  }
  const applied = await applyExactUpdatePlanV1(plan, {
    alreadyCompleted: async (boundary) => operation.isBoundaryCompleted(boundary.boundary_id),
    revalidate: async () => false,
    apply: async () => {
      throw new Error("update-operation-boundary-not-journaled");
    },
  });
  if (applied.pending.length > 0) {
    fx.error("lyt update: the exact update plan still has unjournaled boundaries.");
    return {
      installed: true,
      reconciled: false,
      reconcileReceipt: receipt,
      exitCode: 1,
      nextAction: `lyt update --resume ${plan.operation_id} --yes`,
      updatePlan: plan,
    };
  }

  fx.log(
    `lyt update: npm replacement completed; reconciliation Receipt ${receipt.operation_id}/${receipt.attempt_id} is authoritative. ` +
      "Start a fresh agent session before treating injected manuals or skills as loaded.",
  );
  return {
    installed: true,
    reconciled: true,
    reconcileReceipt: receipt,
    exitCode: 0,
    updatePlan: plan,
  };
}

export async function resumeUpdateFlow(
  operationId: string,
  fx: UpdateEffects,
): Promise<UpdateFlowResult> {
  return finishInstall(readUpdateOperationPlanV1(operationId), fx);
}

function resolveNpmCliPath(): string | null {
  const candidates = [
    process.env.npm_execpath,
    process.env.NPM_EXECPATH,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(dirname(process.execPath)), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  const found = candidates.find((candidate) => existsSync(candidate));
  return found === undefined ? null : resolve(found);
}

function packageRoot(packageName: string): string | null {
  try {
    const require = createRequire(import.meta.url);
    let cursor = dirname(require.resolve(packageName));
    for (let depth = 0; depth < 8; depth += 1) {
      if (existsSync(join(cursor, "package.json"))) return cursor;
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  } catch {
    return null;
  }
  return null;
}

async function fetchExactPackageGraph(plan: {
  registry: string;
  version: string;
}): Promise<readonly RegistryPackageFactV1[]> {
  return Promise.all(
    UPDATE_PLAN_PACKAGES.map(async (name) => {
      const url = new URL(
        `${encodeURIComponent(name)}/${encodeURIComponent(plan.version)}`,
        plan.registry,
      );
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`update-plan-registry-${response.status}`);
      const manifest = (await response.json()) as {
        version?: unknown;
        dist?: { integrity?: unknown; tarball?: unknown };
        dependencies?: Record<string, string>;
      };
      if (
        manifest.version !== plan.version ||
        typeof manifest.dist?.integrity !== "string" ||
        typeof manifest.dist.tarball !== "string"
      ) {
        throw new Error("update-plan-registry-manifest-invalid");
      }
      const dependencies = Object.keys(manifest.dependencies ?? {})
        .filter((candidate): candidate is (typeof UPDATE_PLAN_PACKAGES)[number] =>
          UPDATE_PLAN_PACKAGES.includes(candidate as (typeof UPDATE_PLAN_PACKAGES)[number]),
        )
        .sort();
      return Object.freeze({
        name,
        version: plan.version,
        integrity: manifest.dist.integrity,
        tarball_url: manifest.dist.tarball,
        dependencies,
      });
    }),
  );
}

function observeInstalledState() {
  const packages = UPDATE_PLAN_PACKAGES.map((name) => {
    const root = packageRoot(name);
    if (root === null) return { name, version: null, integrity: null };
    try {
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        version?: unknown;
      };
      return {
        name,
        version: typeof manifest.version === "string" ? manifest.version : null,
        integrity: null,
      };
    } catch {
      return { name, version: null, integrity: null };
    }
  });
  const cli = typeof process.argv[1] === "string" ? resolve(process.argv[1]) : null;
  const bins =
    cli === null
      ? []
      : [
          {
            path: cli,
            digest: existsSync(cli)
              ? createHash("sha256").update(readFileSync(cli)).digest("hex")
              : null,
          },
        ];
  return { packages, bins };
}

export function providerDestinationsFromReconcilePlan(
  reconcilePlan: Pick<InstallReconcilePlanV1, "objects">,
) {
  return reconcilePlan.objects.map((object) => ({
    object_id: object.object_id,
    kind: object.kind === "directory-link" ? ("skill" as const) : ("manual" as const),
    path: object.target_path,
    source_package: object.provider_package as (typeof UPDATE_PLAN_PACKAGES)[number],
    evidence_kind: "provider-content-digest" as const,
    expected_before_digest: object.observed_digest,
    expected_after_digest: object.expected_applied_digest,
  }));
}

export function targetProviderObjectsFromTargetManifests(
  reconcilePlan: Pick<InstallReconcilePlanV1, "objects">,
  manifests: readonly TargetProviderManifestV1[],
) {
  const declared = new Map<string, TargetProviderManifestV1["objects"][number]>();
  for (const manifest of manifests) {
    for (const object of manifest.objects) {
      const id =
        object.kind === "directory-link"
          ? `skill:${object.runtime}:${object.name}`
          : `manual:${object.runtime}`;
      declared.set(id, object);
    }
  }
  return reconcilePlan.objects.map((object) => {
    const target = declared.get(object.object_id);
    if (target === undefined) throw new Error("update-target-provider-object-missing");
    return {
      object_id: object.object_id,
      kind: object.kind,
      provider_package: object.provider_package as (typeof UPDATE_PLAN_PACKAGES)[number],
      provider_version: object.provider_version,
      target_path: object.target_path,
      source_relative_path: target.kind === "directory-link" ? target.source_relative_path : null,
      content: target.kind === "marker-file" ? target.content : null,
      expected_digest: object.expected_digest,
      expected_applied_digest: object.expected_applied_digest,
      marker_begin: target.kind === "marker-file" ? target.marker_begin : null,
      marker_end: target.kind === "marker-file" ? target.marker_end : null,
    };
  });
}

export async function prepareProductionUpdatePlan(currency: CurrencyResult): Promise<UpdatePlanV1> {
  if (currency.latest === null || currency.integrity === null || currency.channel === null) {
    throw new Error("update-plan-currency-incomplete");
  }
  const graph = await fetchExactPackageGraph({
    registry: currency.registry,
    version: currency.latest,
  });
  const meta = graph.find((entry) => entry.name === "@younndai/lyt");
  if (meta?.integrity !== currency.integrity)
    throw new Error("update-plan-currency-integrity-drift");
  const inspected = await Promise.all(
    graph.map(async (fact) => {
      const response = await fetch(fact.tarball_url);
      if (!response.ok) throw new Error(`update-target-fetch-${response.status}`);
      return inspectTargetTarballBytes({
        package: fact.name,
        version: fact.version,
        integrity: fact.integrity,
        tarballUrl: fact.tarball_url,
        bytes: new Uint8Array(await response.arrayBuffer()),
      });
    }),
  );
  const targetArtifacts = inspected.map((entry) => entry.artifact);
  const manifests = inspected
    .map((entry) => entry.provider_manifest)
    .filter((entry): entry is TargetProviderManifestV1 => entry !== null);
  const extractedRoots = new Map(
    UPDATE_PLAN_PACKAGES.map((name) => [name, join(homedir(), "lyt", ".update-target", name)]),
  );
  const providers = materializeTargetProviders({
    manifests,
    extractedRoots,
    homeDir: homedir(),
    runtimes: detectInstalledRuntimes(homedir()),
  });
  const reconcilePlan = prepareInstallReconcilePlanV1(providers);
  const targetProviderObjects = targetProviderObjectsFromTargetManifests(reconcilePlan, manifests);
  const beforeState = observeInstalledState();
  const packageDestinations = UPDATE_PLAN_PACKAGES.map((name) => {
    const root = packageRoot(name);
    const manifestPath = root === null ? `unresolved:${name}` : join(root, "package.json");
    const before =
      root !== null && existsSync(manifestPath)
        ? createHash("sha256").update(readFileSync(manifestPath)).digest("hex")
        : null;
    const artifact = targetArtifacts.find((entry) => entry.package === name)!;
    return {
      object_id: `package:${name.slice("@younndai/".length)}`,
      kind: "package" as const,
      path: root ?? manifestPath,
      source_package: name,
      evidence_kind: "registry-version-sri" as const,
      expected_before_digest: before,
      expected_after_digest: artifact.payload_digest,
    };
  });
  const binDestinations = beforeState.bins.map((bin, index) => ({
    object_id: `bin:lyt:${index}`,
    kind: "bin" as const,
    path: bin.path,
    source_package: "@younndai/lyt" as const,
    evidence_kind: "bounded-target-identity" as const,
    expected_before_digest: bin.digest,
    expected_after_digest: digestCanonical({ kind: "bin-target", path: resolve(bin.path) }),
  }));
  const providerDestinations = providerDestinationsFromReconcilePlan(reconcilePlan);
  const destinations = [...packageDestinations, ...binDestinations, ...providerDestinations];
  const npmObjectIds = [...packageDestinations, ...binDestinations].map((entry) => entry.object_id);
  const skillObjectIds = providerDestinations
    .filter((entry) => entry.kind === "skill")
    .map((entry) => entry.object_id);
  const manualObjectIds = providerDestinations
    .filter((entry) => entry.kind === "manual")
    .map((entry) => entry.object_id);
  return prepareUpdatePlanV1({
    registryUrl: currency.registry,
    channel: currency.channel,
    targetVersion: currency.latest,
    distIntegrity: currency.integrity,
    packageGraph: graph,
    targetArtifacts,
    targetProviderObjects,
    beforeState,
    destinations,
    boundaries: [
      {
        boundary_id: "npm-self-replacement",
        kind: "npm-self-replacement",
        object_ids: npmObjectIds,
      },
      ...(skillObjectIds.length > 0
        ? [
            {
              boundary_id: "skill-leaves",
              kind: "skill-leaves" as const,
              object_ids: skillObjectIds,
            },
          ]
        : []),
      ...(manualObjectIds.length > 0
        ? [
            {
              boundary_id: "agent-manuals",
              kind: "agent-manuals" as const,
              object_ids: manualObjectIds,
            },
          ]
        : []),
    ],
    expectedEvidence: [
      "registry-version-sri",
      "package-graph",
      "provider-content-digest",
      "bin-target-identity",
      "receipt-v1",
    ],
  });
}

export async function revalidateProductionUpdatePlan(plan: UpdatePlanV1): Promise<boolean> {
  try {
    const parsed = parseUpdatePlanV1(plan);
    const graph = await fetchExactPackageGraph({
      registry: parsed.registry_url,
      version: parsed.target_version,
    });
    if (canonicalJson(graph) !== canonicalJson(parsed.package_graph)) return false;
    const observed = observeInstalledState();
    if (canonicalJson(observed) !== canonicalJson(parsed.before_state)) return false;
    const currentRoots = new Map(
      UPDATE_PLAN_PACKAGES.map((name) => [name, packageRoot(name) ?? "missing-target-package"]),
    );
    const currentProviders = providersFromUpdatePlan(parsed, currentRoots);
    const currentProviderPlan = prepareInstallReconcilePlanV1(currentProviders);
    const providerObserved = new Map(
      currentProviderPlan.objects.map((object) => [object.object_id, object.observed_digest]),
    );
    for (const destination of parsed.destinations) {
      if (destination.expected_before_digest === null) continue;
      const digest =
        destination.evidence_kind === "registry-version-sri"
          ? existsSync(join(destination.path, "package.json"))
            ? createHash("sha256")
                .update(readFileSync(join(destination.path, "package.json")))
                .digest("hex")
            : null
          : destination.evidence_kind === "bounded-target-identity"
            ? existsSync(destination.path)
              ? createHash("sha256").update(readFileSync(destination.path)).digest("hex")
              : null
            : (providerObserved.get(destination.object_id) ?? null);
      if (digest !== destination.expected_before_digest) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function verifyProductionInstalledPlan(plan: UpdatePlanV1): Promise<boolean> {
  try {
    const parsed = parseUpdatePlanV1(plan);
    const installed = observeInstalledState();
    const graph = await fetchExactPackageGraph({
      registry: parsed.registry_url,
      version: parsed.target_version,
    });
    if (!installedEvidenceMatchesPlan(parsed, installed, graph)) return false;
    return parsed.target_artifacts.every((artifact) => {
      const root = packageRoot(artifact.package);
      return root !== null && verifyInstalledPayloadV1(root, artifact);
    });
  } catch {
    return false;
  }
}

export function installedEvidenceMatchesPlan(
  plan: UpdatePlanV1,
  installed: UpdatePlanV1["before_state"],
  graph: readonly RegistryPackageFactV1[],
): boolean {
  const versions = new Map(installed.packages.map((entry) => [entry.name, entry.version]));
  return (
    versions.size === UPDATE_PLAN_PACKAGES.length &&
    UPDATE_PLAN_PACKAGES.every((name) => versions.get(name) === plan.target_version) &&
    canonicalJson(graph) === canonicalJson(plan.package_graph)
  );
}

export function npmInstallArgsForUpdatePlan(
  plan: UpdatePlanV1,
  artifactPaths: readonly string[],
): readonly string[] {
  const parsed = parseUpdatePlanV1(plan);
  if (artifactPaths.length !== UPDATE_PLAN_PACKAGES.length) {
    throw new Error("update-target-exact-seven-tarballs-required");
  }
  return Object.freeze(["i", "-g", ...artifactPaths, "--registry", parsed.registry_url]);
}

function runNpmInstall(
  plan: UpdatePlanV1,
  artifactPaths: readonly string[],
  quiet: boolean,
): number {
  const npmCli = resolveNpmCliPath();
  if (npmCli === null) return 1;
  const res = spawnSync(
    process.execPath,
    [npmCli, ...npmInstallArgsForUpdatePlan(plan, artifactPaths)],
    {
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: false,
    },
  );
  return res.status ?? 1;
}

function runReplacementReconcile(plan: UpdatePlanV1): ReconcileEffectResult {
  const cliPath = process.argv[1];
  if (typeof cliPath !== "string" || cliPath.length === 0 || !existsSync(cliPath)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "current Lyt CLI entrypoint is unavailable after npm replacement",
    };
  }
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "install",
      "reconcile",
      "--apply",
      "--json",
      "--update-operation",
      plan.operation_id,
      "--plan-digest",
      plan.plan_digest,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    },
  );
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function printUpdateJson(result: UpdateFlowResult, currency: CurrencyResult | null): void {
  process.stdout.write(
    `${JSON.stringify(
      {
        schema_id: "lyt.update.v1",
        schema_version: 1,
        status: result.exitCode === 0 ? "completed" : "failed",
        success: result.exitCode === 0,
        npm_replacement_completed: result.installed,
        reconciliation_completed: result.reconciled,
        reconciliation_receipt: result.reconcileReceipt,
        update_plan: result.updatePlan ?? null,
        next_action: result.nextAction ?? null,
        currency,
      },
      null,
      2,
    )}\n`,
  );
}

async function selectChannelInteractively(): Promise<UpdateChannel | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Select Lyt update channel [alpha/latest] (default alpha): "))
      .trim()
      .toLowerCase();
    if (answer.length === 0) return "alpha";
    return isUpdateChannel(answer) ? answer : null;
  } finally {
    rl.close();
  }
}

function productionUpdateEffects(json: boolean): UpdateEffects {
  return {
    log: (message) => {
      if (!json) console.log(message);
    },
    error: (message) => {
      if (!json) console.error(message);
    },
    confirm: async (prompt) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = (await rl.question(prompt)).trim().toLowerCase();
        return answer === "y" || answer === "yes";
      } finally {
        rl.close();
      }
    },
    preparePlan: prepareProductionUpdatePlan,
    revalidatePlan: revalidateProductionUpdatePlan,
    verifyInstalledPlan: verifyProductionInstalledPlan,
    beginOperation: beginUpdateOperationV1,
    stageArtifacts: (plan) => stageTargetArtifactsV1(plan, defaultUpdateOperationRoot()),
    writeInstalledAnchor: (plan) => {
      try {
        writeInstalledStateAnchorV1(plan, defaultUpdateOperationRoot());
        return true;
      } catch {
        return false;
      }
    },
    install: (plan, artifacts) => runNpmInstall(plan, artifacts, json),
    reconcile: runReplacementReconcile,
  };
}

// `lyt update`: explicit channel policy + confirmation-gated global install.
// `--check` is read-only and maps to currency inspection, while an actual update
// persists only an explicit/interactive channel selection before probing it.
export function buildUpdateCommand(): Command {
  return new Command("update")
    .description(
      "Update Lyt on one explicit alpha/latest channel, then launch the replacement binary's `lyt install reconcile --apply --json` boundary. Confirms before changing the global install.",
    )
    .option("--check", "Only check for a newer version; do not install")
    .option("--yes", "Skip the confirmation prompt (required to update non-interactively)")
    .option("--json", "Emit a deterministic update result")
    .option("--channel <alpha|latest>", "Select and persist an update channel", parseChannel)
    .option("--switch-channel", "Allow changing a previously selected channel (requires --channel)")
    .option("--allow-downgrade", "Allow the explicit selected channel to replace an ahead install")
    .option("--resume <operation-id>", "Resume one durable update operation after npm replacement")
    .option("--configure", "Persist --channel without checking or installing")
    .action(async (opts: UpdateCliOpts) => {
      const interactive =
        process.stdin.isTTY === true && process.stdout.isTTY === true && opts.json !== true;
      const effects = productionUpdateEffects(opts.json === true);
      if (opts.configure === true) {
        if (opts.channel === undefined || opts.resume !== undefined || opts.check === true) {
          const nextAction = "lyt update --channel <alpha|latest> --configure --json";
          if (opts.json) {
            process.stdout.write(
              `${JSON.stringify({
                schema_id: "lyt.update-channel-configure-refusal",
                schema_version: { major: 1, minor: 0 },
                status: "refused",
                error_code: "update-channel-configure-requires-channel-only",
                next_action: nextAction,
              })}\n`,
            );
          } else console.error(`lyt update: run \`${nextAction}\`.`);
          process.exitCode = 2;
          return;
        }
        const configured = configureUpdateChannel(opts.channel);
        if (opts.json) process.stdout.write(`${JSON.stringify(configured)}\n`);
        else console.log(`Lyt update channel saved: ${configured.channel}.`);
        return;
      }
      if (opts.resume !== undefined) {
        let result: UpdateFlowResult;
        try {
          result = await resumeUpdateFlow(opts.resume, effects);
        } catch (error) {
          effects.error(
            `lyt update: could not resume the sealed update operation (${String(error)}).`,
          );
          result = {
            installed: false,
            reconciled: false,
            reconcileReceipt: null,
            exitCode: 1,
            nextAction: "lyt doctor --json",
          };
        }
        if (opts.json) printUpdateJson(result, null);
        if (result.exitCode !== 0) process.exitCode = result.exitCode;
        return;
      }
      if (opts.switchChannel === true && opts.channel === undefined) {
        const result: UpdateFlowResult = {
          installed: false,
          reconciled: false,
          reconcileReceipt: null,
          exitCode: 2,
          nextAction: "lyt update --channel alpha --switch-channel",
        };
        if (opts.json)
          printUpdateJson(result, await checkCurrency({ installedVersion: readMetaVersion() }));
        else console.error("lyt update: --switch-channel requires --channel alpha|latest.");
        process.exitCode = 2;
        return;
      }
      if (opts.allowDowngrade === true && opts.channel === undefined) {
        const result: UpdateFlowResult = {
          installed: false,
          reconciled: false,
          reconcileReceipt: null,
          exitCode: 2,
          nextAction: "lyt update --channel alpha --allow-downgrade",
        };
        if (opts.json)
          printUpdateJson(result, await checkCurrency({ installedVersion: readMetaVersion() }));
        else console.error("lyt update: --allow-downgrade requires --channel alpha|latest.");
        process.exitCode = 2;
        return;
      }

      const persisted = readUpdateChannel();
      // `--check --channel` is a read-only inspection of a different channel,
      // not a request to switch durable policy. Actual updates retain the
      // separate --switch-channel gate.
      const initial =
        opts.check === true && opts.channel !== undefined
          ? ({ channel: opts.channel, source: "explicit" } satisfies UpdateChannelResolution)
          : resolveConfiguredChannel(opts.channel, persisted, {
              switchChannel: opts.switchChannel,
              interactive,
            });
      const resolved =
        initial.channel === null && initial.refusal === "channel-unconfigured" && interactive
          ? resolveConfiguredChannel(opts.channel, persisted, {
              switchChannel: opts.switchChannel,
              interactive,
              selectedInteractive: await selectChannelInteractively(),
            })
          : initial;
      if (resolved.channel === null) {
        const currency = await checkCurrency({ installedVersion: readMetaVersion() });
        const result: UpdateFlowResult = {
          installed: false,
          reconciled: false,
          reconcileReceipt: null,
          exitCode: 2,
          nextAction: resolved.nextAction,
        };
        if (opts.json) printUpdateJson(result, currency);
        else
          console.error(
            resolved.refusal === "channel-switch-requires-explicit"
              ? `lyt update: run \`${resolved.nextAction}\` to switch the saved channel.`
              : formatCurrencyLine(currency),
          );
        process.exitCode = 2;
        return;
      }

      // A deliberate selection is durable policy. `--check` remains read-only;
      // it may inspect an explicit channel but never configures one.
      if (
        opts.check !== true &&
        (resolved.source === "explicit" || resolved.source === "interactive")
      ) {
        writeUpdateChannel(resolved.channel);
      }

      const currency = await checkCurrency({
        force: true,
        channel: resolved.channel,
        installedVersion: readMetaVersion(),
      });
      if (opts.check === true) {
        if (opts.json) process.stdout.write(`${JSON.stringify(currency, null, 2)}\n`);
        else console.log(formatCurrencyLine(currency));
        process.exitCode = currency.stale ? 1 : currency.channelUnconfigured ? 2 : 0;
        return;
      }

      const { exitCode, ...flowResult } = await runUpdateFlow(
        currency,
        { yes: opts.yes, interactive, allowDowngrade: opts.allowDowngrade },
        effects,
      );
      const result: UpdateFlowResult = { ...flowResult, exitCode };
      if (opts.json) printUpdateJson(result, currency);
      if (exitCode !== 0) process.exitCode = exitCode;
    });
}
