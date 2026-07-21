/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 * Licensed under the Apache License, Version 2.0.
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  type CheckResult,
  detectInstalledRuntimes,
  INSTALLABLE_RUNTIMES,
  inspectCurrencyStateV1,
} from "@younndai/lyt-vault";

import { buildInstallProviderInventoryV1, type InstallProviderV1 } from "./provider-inventory.js";
import { inspectReconcileJournalV1, prepareInstallReconcilePlanV1 } from "./reconcile-engine.js";
import {
  inspectInstalledPackagePayloadsV1,
  readInstalledStateAnchorV1,
  verifyInstalledStateAnchorV1,
} from "./target-artifacts.js";
import { inspectUpdateOperationJournalV1 } from "./update-operation.js";
import { UPDATE_PLAN_PACKAGES, type UpdatePackageName } from "./update-plan.js";

export interface DoctorInstallHealthOptions {
  readonly topLevelVersion: string;
  /** User profile root used only for optional agent-runtime destinations. */
  readonly homeDir?: string;
  /** Canonical Lyt state root. Explicit override wins over LYT_HOME and ~/lyt. */
  readonly lytHome?: string;
  readonly providers?: readonly InstallProviderV1[];
  readonly providerInventory?: () => Promise<readonly InstallProviderV1[]>;
  readonly updateOperationInspector?: typeof inspectUpdateOperationJournalV1;
  readonly installedPackageRootResolver?: (packageName: UpdatePackageName) => string | null;
  /** Test seam. This is the parent directory containing `@younndai/lyt`. */
  readonly scopedPackageRoot?: string | null;
}

/**
 * Meta-package-owned doctor axes. They stay out of lyt-vault because only the
 * meta CLI can authoritatively state the seven-package installation graph.
 * This routine is diagnostic-only: it never creates, changes, or removes a
 * journal, managed destination, package directory, or npm residue.
 */
export async function checkInstallHealthV1(
  options: DoctorInstallHealthOptions,
): Promise<readonly CheckResult[]> {
  const profileHome = resolve(options.homeDir ?? homedir());
  const lytHome = resolve(
    options.lytHome ??
      (options.homeDir !== undefined
        ? join(profileHome, "lyt")
        : (process.env.LYT_HOME ?? join(profileHome, "lyt"))),
  );
  const checks: CheckResult[] = [];
  let providers: readonly InstallProviderV1[] | null = null;
  try {
    providers =
      options.providers ??
      (await (
        options.providerInventory ??
        (() => buildInstallProviderInventoryV1({ homeDir: profileHome }))
      )());
  } catch (error) {
    checks.push(
      failure(
        "install.package-graph",
        "installed Lyt package graph",
        `could not inspect the exact seven-package graph: ${safeError(error)}`,
      ),
    );
  }

  if (providers !== null) {
    checks.push(...packageVersionChecks(providers, options.topLevelVersion));
    checks.push(graphCheck(providers, options.topLevelVersion));
    checks.push(...providerContentChecks(providers, join(lytHome, ".update-operations")));
  }
  checks.push(
    ...packagePayloadChecks(
      join(lytHome, ".update-operations"),
      options.installedPackageRootResolver,
    ),
  );
  checks.push(...optionalRuntimeChecks(profileHome));
  checks.push(channelCheck(lytHome));
  checks.push(...journalChecks(lytHome));
  checks.push(
    ...updateOperationChecks(
      join(lytHome, ".update-operations"),
      options.updateOperationInspector ?? inspectUpdateOperationJournalV1,
    ),
  );
  checks.push(...residueChecks(options.scopedPackageRoot ?? defaultScopedPackageRoot()));
  return checks;
}

function packageVersionChecks(
  providers: readonly InstallProviderV1[],
  topLevelVersion: string,
): readonly CheckResult[] {
  const byName = new Map(providers.map((provider) => [provider.package, provider]));
  return UPDATE_PLAN_PACKAGES.map((name) => {
    const provider = byName.get(name);
    const observed = provider?.version ?? null;
    const current = observed === topLevelVersion;
    return {
      id: `install.package.${checkId(name)}`,
      group: "install",
      label: `${name} version`,
      status: current ? "pass" : "fail",
      message:
        observed === null
          ? `missing (top-level lyt is v${topLevelVersion})`
          : current
            ? `v${observed} (matches top-level lyt)`
            : `v${observed} (top-level lyt is v${topLevelVersion})`,
      remediation: current ? undefined : "Run: lyt update --check, then lyt update",
      detail: { package: name, observed, authoritative_top_level_version: topLevelVersion },
    };
  });
}

function graphCheck(providers: readonly InstallProviderV1[], topLevelVersion: string): CheckResult {
  const names = providers.map((provider) => provider.package).sort();
  const exactNames = [...UPDATE_PLAN_PACKAGES].sort();
  const exactSet = JSON.stringify(names) === JSON.stringify(exactNames);
  const exactVersions = providers.every((provider) => provider.version === topLevelVersion);
  if (exactSet && exactVersions) {
    try {
      prepareInstallReconcilePlanV1(providers);
      return {
        id: "install.package-graph",
        group: "install",
        label: "installed Lyt package graph",
        status: "pass",
        message: `seven packages at v${topLevelVersion}`,
      };
    } catch (error) {
      return failure(
        "install.package-graph",
        "installed Lyt package graph",
        `incompatible or unsafe provider graph: ${safeError(error)}`,
      );
    }
  }
  return failure(
    "install.package-graph",
    "installed Lyt package graph",
    "the installed Lyt package graph is incomplete or version-skewed",
    {
      expected_packages: exactNames,
      observed_packages: names,
      authoritative_top_level_version: topLevelVersion,
    },
  );
}

function providerContentChecks(
  providers: readonly InstallProviderV1[],
  updateOperationRoot: string,
): readonly CheckResult[] {
  let plan: ReturnType<typeof prepareInstallReconcilePlanV1>;
  try {
    plan = prepareInstallReconcilePlanV1(providers);
  } catch (error) {
    return [
      failure(
        "install.provider-content",
        "managed skills and manuals",
        `cannot safely inspect provider content: ${safeError(error)}`,
      ),
    ];
  }
  if (plan.objects.length === 0) {
    return [
      {
        id: "install.provider-content",
        group: "install",
        label: "managed skills and manuals",
        status: "info",
        message: "no optional agent runtime homes detected",
      },
    ];
  }
  const observed = new Map(
    plan.objects.map((object) => [object.object_id, object.observed_digest] as const),
  );
  const anchorRead = readInstalledStateAnchorV1(updateOperationRoot);
  const verification = verifyInstalledStateAnchorV1(updateOperationRoot, observed);
  const expected = new Map(
    anchorRead.status === "present"
      ? anchorRead.anchor.provider_destinations.map((entry) => [entry.object_id, entry.digest])
      : [],
  );
  const mismatched = new Set(verification.mismatched_object_ids);
  const anchorCheck: CheckResult =
    verification.status === "match"
      ? {
          id: "install.provider-anchor",
          group: "install",
          label: "sealed managed-content anchor",
          status: "pass",
          message: "installed managed content matches externally anchored update evidence",
        }
      : verification.status === "missing"
        ? {
            id: "install.provider-anchor",
            group: "install",
            label: "sealed managed-content anchor",
            status: "warn",
            message:
              "no sealed installed-state anchor is available; managed-content health is unknown",
            remediation: "Run a successful exact Lyt update to create installed-state evidence",
          }
        : failure(
            "install.provider-anchor",
            "sealed managed-content anchor",
            verification.status === "invalid"
              ? "installed-state anchor is invalid or unsafe"
              : "installed managed content does not match its sealed update evidence",
            { mismatched_object_ids: verification.mismatched_object_ids },
            "Run: lyt doctor --json, then resume or repeat the exact Lyt update",
          );
  return [
    anchorCheck,
    ...plan.objects.map((object) => {
      const anchoredDigest = expected.get(object.object_id) ?? null;
      const anchorUnknown = verification.status === "missing" || anchoredDigest === null;
      const anchorInvalid = verification.status === "invalid";
      const anchorMismatch = mismatched.has(object.object_id);
      const status = anchorInvalid || anchorMismatch ? "fail" : anchorUnknown ? "warn" : "pass";
      const message = anchorInvalid
        ? `${object.target_path} cannot be verified because its installed-state anchor is invalid`
        : anchorMismatch
          ? `${object.target_path} differs from its externally anchored digest`
          : anchorUnknown
            ? `${object.target_path} has no externally anchored expected digest; health is unknown`
            : `${object.target_path} matches its externally anchored digest`;
      return {
        id: `install.provider.${checkId(object.object_id)}`,
        group: "install",
        label: `${object.kind === "directory-link" ? "skill" : "agent manual"} ${object.object_id}`,
        status,
        message,
        remediation:
          status === "pass"
            ? undefined
            : "Run: lyt doctor --json, then resume or repeat the exact Lyt update",
        detail: {
          object_id: object.object_id,
          provider_package: object.provider_package,
          provider_version: object.provider_version,
          target_path: object.target_path,
          anchored_expected_digest: anchoredDigest,
          observed_digest: object.observed_digest,
          disposition: object.disposition,
          refusal_code: object.refusal_code,
          anchor_status: verification.status,
        },
      } satisfies CheckResult;
    }),
  ];
}

function packagePayloadChecks(
  updateOperationRoot: string,
  resolveRoot?: (packageName: UpdatePackageName) => string | null,
): readonly CheckResult[] {
  const anchor = readInstalledStateAnchorV1(updateOperationRoot);
  if (anchor.status === "missing") {
    return [
      {
        id: "install.package-payloads",
        group: "install",
        label: "sealed installed package payloads",
        status: "warn",
        message: "no sealed installed-state anchor is available; package payload health is unknown",
        remediation: "Run a successful exact Lyt update to create installed-state evidence",
      },
    ];
  }
  if (anchor.status === "invalid") {
    return [
      failure(
        "install.package-payloads",
        "sealed installed package payloads",
        "installed-state anchor is invalid or unsafe",
        undefined,
        "Run: lyt doctor --json, then resume or repeat the exact Lyt update",
      ),
    ];
  }
  if (anchor.anchor === null) {
    return [
      failure(
        "install.package-payloads",
        "sealed installed package payloads",
        "installed-state anchor could not be read",
      ),
    ];
  }
  return inspectInstalledPackagePayloadsV1(anchor.anchor, resolveRoot).map((inspection) => ({
    id: `install.package-payload.${checkId(inspection.package)}`,
    group: "install",
    label: `${inspection.package} installed payload`,
    status: inspection.status === "match" ? "pass" : "fail",
    message:
      inspection.status === "match"
        ? `${inspection.package} matches its externally anchored payload digest`
        : `${inspection.package} payload is ${inspection.status}`,
    remediation:
      inspection.status === "match"
        ? undefined
        : "Run: lyt doctor --json, then resume or repeat the exact Lyt update",
    detail: {
      package: inspection.package,
      root: inspection.root,
      expected_digest: inspection.expected_digest,
      observed_digest: inspection.observed_digest,
      payload_status: inspection.status,
    },
  }));
}

function optionalRuntimeChecks(home: string): readonly CheckResult[] {
  const detected = new Set(detectInstalledRuntimes(home));
  return INSTALLABLE_RUNTIMES.filter((runtime) => !detected.has(runtime)).map((runtime) => ({
    id: `install.runtime.${runtime}`,
    group: "install",
    label: `${runtime} runtime home`,
    status: "info" as const,
    message: `not detected at ${join(home, `.${runtime}`)} (optional; no managed content expected)`,
  }));
}

function channelCheck(lytHome: string): CheckResult {
  const path = join(lytHome, ".update-channel.json");
  const inspection = inspectCurrencyStateV1({ homeDir: lytHome });
  if (inspection.channelStatus === "missing") {
    return {
      id: "install.update-channel",
      group: "install",
      label: "configured update channel",
      status: "warn",
      message: "no update channel configured",
      remediation: "Run: lyt update --channel <alpha|latest> --configure --json",
      detail: { configured: null, observed: null, path },
    };
  }
  if (inspection.channelStatus === "malformed" || inspection.channel === null) {
    return failure(
      "install.update-channel",
      "configured update channel",
      "update-channel configuration exists but is malformed",
      { configured: null, observed: null, path },
    );
  }
  const configured = inspection.channel;
  const observation = inspection.observation;
  const validObserved = inspection.cacheStatus === "current" && observation !== null;
  const invalidObserved =
    inspection.cacheStatus === "malformed" || inspection.cacheStatus === "tampered";
  return {
    id: "install.update-channel",
    group: "install",
    label: "configured and observed update channel",
    status: validObserved ? "pass" : invalidObserved ? "fail" : "warn",
    message: validObserved
      ? `${configured} configured; canonical cache observation is valid (${observation.version})`
      : `${configured} configured; canonical cache is ${inspection.cacheStatus}`,
    remediation: validObserved
      ? undefined
      : invalidObserved
        ? "Inspect the local currency cache, then run: lyt outdated --channel " + configured
        : `Run: lyt outdated --channel ${configured}`,
    detail: {
      configured,
      observed: observation?.observedTag ?? null,
      channel_status: inspection.channelStatus,
      cache_status: inspection.cacheStatus,
      registry: observation?.registry ?? null,
      package: observation?.packageName ?? null,
      version: observation?.version ?? null,
      integrity: observation?.integrity ?? null,
      checked_at: observation?.checkedAt ?? null,
      channel_path: path,
      cache_path: join(lytHome, ".currency-checks.json"),
    },
  };
}

function journalChecks(lytHome: string): readonly CheckResult[] {
  const journalRoot = join(lytHome, ".install-reconcile");
  const operationsRoot = join(journalRoot, "operations");
  if (!existsSync(operationsRoot)) {
    return [
      {
        id: "install.reconcile-journal",
        group: "install",
        label: "install reconciliation journal",
        status: "pass",
        message: "no pending install reconciliation journal",
      },
    ];
  }
  try {
    if (lstatSync(journalRoot).isSymbolicLink() || lstatSync(operationsRoot).isSymbolicLink()) {
      return [
        failure(
          "install.reconcile-journal",
          "install reconciliation journal",
          "unsafe journal path",
        ),
      ];
    }
    const entries = readdirSync(operationsRoot, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    const checks: CheckResult[] = [];
    if (entries.length > 128) {
      checks.push(
        failure(
          "install.reconcile-journal.truncated",
          "install reconciliation journal",
          `journal inspection refused full coverage: ${entries.length} operations exceed the 128-entry bound`,
          { observed_operations: entries.length, inspected_operations: 128 },
        ),
      );
    }
    let completed = 0;
    for (const entry of entries.slice(0, 128)) {
      const operationPath = join(operationsRoot, entry.name);
      if (
        entry.isSymbolicLink() ||
        lstatSync(operationPath).isSymbolicLink() ||
        !entry.isDirectory()
      ) {
        checks.push(
          failure(
            `install.reconcile-journal.${checkId(entry.name)}`,
            "install reconciliation journal",
            `${operationPath} is an unsafe operation-journal shape`,
          ),
        );
        continue;
      }
      const inspection = inspectReconcileJournalV1(journalRoot, entry.name);
      if (!inspection.valid || inspection.journal === null) {
        checks.push(
          failure(
            `install.reconcile-journal.${checkId(entry.name)}`,
            "install reconciliation journal",
            `operation ${entry.name} is malformed or tampered (${inspection.error_code ?? "unknown"})`,
            { operation_id: entry.name, error_code: inspection.error_code },
          ),
        );
        continue;
      }
      const journal = inspection.journal;
      const incomplete =
        journal.pending.length > 0 ||
        journal.refused.length > 0 ||
        journal.active_attempt_id !== null;
      if (!incomplete) {
        completed += 1;
        continue;
      }
      checks.push(
        failure(
          `install.reconcile-journal.${checkId(entry.name)}`,
          "install reconciliation journal",
          `operation ${entry.name} is incomplete`,
          {
            operation_id: entry.name,
            pending: journal.pending,
            refused: journal.refused,
            active_attempt_id: journal.active_attempt_id,
            resume_command: `lyt install reconcile --resume ${entry.name} --apply --json`,
          },
          `Run: lyt install reconcile --resume ${entry.name} --apply --json`,
        ),
      );
    }
    if (checks.length === 0) {
      return [
        {
          id: "install.reconcile-journal",
          group: "install",
          label: "install reconciliation journal",
          status: "pass",
          message: `${completed} completed journal(s); none pending`,
        },
      ];
    }
    return checks;
  } catch (error) {
    return [
      failure(
        "install.reconcile-journal",
        "install reconciliation journal",
        `cannot safely inspect journal: ${safeError(error)}`,
      ),
    ];
  }
}

function updateOperationChecks(
  root: string,
  inspect: typeof inspectUpdateOperationJournalV1,
): readonly CheckResult[] {
  const operationsRoot = join(root, "operations");
  const pass = (count: number): CheckResult => ({
    id: "install.update-operation",
    group: "install",
    label: "durable update operations",
    status: "pass",
    message: `${count} completed update operation(s); none pending`,
  });
  if (!existsSync(root)) return [pass(0)];
  try {
    if (lstatSync(root).isSymbolicLink()) {
      return [failure("install.update-operation", "durable update operations", "unsafe root path")];
    }
    if (!existsSync(operationsRoot)) return [pass(0)];
    if (lstatSync(operationsRoot).isSymbolicLink()) {
      return [
        failure("install.update-operation", "durable update operations", "unsafe operations path"),
      ];
    }
    const entries = readdirSync(operationsRoot, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    const checks: CheckResult[] = [];
    if (entries.length > 128) {
      checks.push(
        failure(
          "install.update-operation.truncated",
          "durable update operations",
          `update-operation inspection refused full coverage: ${entries.length} operations exceed the 128-entry bound`,
          { observed_operations: entries.length, inspected_operations: 128 },
        ),
      );
    }
    let completed = 0;
    for (const entry of entries.slice(0, 128)) {
      const operationPath = join(operationsRoot, entry.name);
      if (
        entry.isSymbolicLink() ||
        lstatSync(operationPath).isSymbolicLink() ||
        !entry.isDirectory()
      ) {
        checks.push(
          failure(
            `install.update-operation.${checkId(entry.name)}`,
            "durable update operations",
            `${operationPath} is an unsafe operation-journal shape`,
          ),
        );
        continue;
      }
      const inspection = inspect(entry.name, root);
      if (!inspection.valid || inspection.journal === null) {
        checks.push(
          failure(
            `install.update-operation.${checkId(entry.name)}`,
            "durable update operations",
            `operation ${entry.name} is missing, failed, or tampered (${inspection.error_code})`,
            { operation_id: entry.name, error_code: inspection.error_code },
            `Run: lyt update --resume ${entry.name} --yes --json`,
          ),
        );
        continue;
      }
      if (inspection.status === "completed") {
        completed += 1;
        continue;
      }
      checks.push(
        failure(
          `install.update-operation.${checkId(entry.name)}`,
          "durable update operations",
          `operation ${entry.name} is pending or interrupted`,
          {
            operation_id: entry.name,
            status: inspection.status,
            completed_boundaries: inspection.journal.completed_boundaries,
            active_attempt_id: inspection.journal.active_attempt_id,
            resume_command: `lyt update --resume ${entry.name} --yes --json`,
          },
          `Run: lyt update --resume ${entry.name} --yes --json`,
        ),
      );
    }
    return checks.length === 0 ? [pass(completed)] : checks;
  } catch (error) {
    return [
      failure(
        "install.update-operation",
        "durable update operations",
        `cannot safely inspect update operations: ${safeError(error)}`,
      ),
    ];
  }
}

function residueChecks(scopedRoot: string | null): readonly CheckResult[] {
  if (scopedRoot === null || !existsSync(scopedRoot)) {
    return [
      {
        id: "install.npm-residue",
        group: "install",
        label: "npm Lyt temporary residue",
        status: "info",
        message: "global Lyt package parent is unavailable for residue inspection",
      },
    ];
  }
  try {
    if (lstatSync(scopedRoot).isSymbolicLink()) {
      return [
        failure("install.npm-residue", "npm Lyt temporary residue", "unsafe package parent path"),
      ];
    }
    const allCandidates = readdirSync(scopedRoot, { withFileTypes: true })
      .filter((entry) => /^\.lyt-[A-Za-z0-9]+$/u.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (allCandidates.length === 0) {
      return [
        {
          id: "install.npm-residue",
          group: "install",
          label: "npm Lyt temporary residue",
          status: "pass",
          message: "no direct .lyt-* residue beside the installed Lyt package",
        },
      ];
    }
    const checks: CheckResult[] = [];
    if (allCandidates.length > 32) {
      checks.push(
        failure(
          "install.npm-residue.truncated",
          "npm Lyt temporary residue",
          `residue inspection refused full coverage: ${allCandidates.length} candidates exceed the 32-entry bound`,
          { observed_candidates: allCandidates.length, inspected_candidates: 32 },
        ),
      );
    }
    for (const entry of allCandidates.slice(0, 32)) {
      const path = join(scopedRoot, entry.name);
      if (entry.isSymbolicLink() || lstatSync(path).isSymbolicLink()) {
        checks.push(
          failure(
            `install.npm-residue.${checkId(entry.name)}`,
            "npm Lyt temporary residue",
            `${path} is unsafe to inspect or remove`,
          ),
        );
        continue;
      }
      if (!entry.isDirectory()) {
        checks.push(
          failure(
            `install.npm-residue.${checkId(entry.name)}`,
            "npm Lyt temporary residue",
            `${path} has an unsafe non-directory residue shape`,
          ),
        );
        continue;
      }
      const tree = inspectResidueTree(path, 2048);
      if (tree.unsafePath !== null) {
        checks.push(
          failure(
            `install.npm-residue.${checkId(entry.name)}`,
            "npm Lyt temporary residue",
            `${tree.unsafePath} is a nested reparse/symlink path; residue is unsafe`,
          ),
        );
        continue;
      }
      if (tree.truncated) {
        checks.push(
          failure(
            `install.npm-residue.${checkId(entry.name)}`,
            "npm Lyt temporary residue",
            `${path} exceeds the 2048-entry safe inspection bound`,
            { path, inspected_entries: tree.entries, truncated: true },
          ),
        );
        continue;
      }
      const packageJson = join(path, "package.json");
      let attributable = false;
      try {
        const manifest = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: unknown };
        attributable = manifest.name === "@younndai/lyt";
      } catch {
        attributable = false;
      }
      checks.push({
        id: `install.npm-residue.${checkId(entry.name)}`,
        group: "install",
        label: "npm Lyt temporary residue",
        status: attributable ? "warn" : "info",
        message: attributable
          ? `${path} is attributable temporary Lyt residue (preserved; no automatic deletion)`
          : `${path} is unattributed .lyt-* residue (preserved; no automatic deletion)`,
        detail: { path, attributable, automatic_deletion: false },
      } satisfies CheckResult);
    }
    return checks;
  } catch (error) {
    return [
      failure(
        "install.npm-residue",
        "npm Lyt temporary residue",
        `cannot safely inspect package residue: ${safeError(error)}`,
      ),
    ];
  }
}

function inspectResidueTree(
  root: string,
  maximumEntries: number,
): { readonly entries: number; readonly truncated: boolean; readonly unsafePath: string | null } {
  const pending = [root];
  let entries = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const children = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const child of children) {
      entries += 1;
      if (entries > maximumEntries) {
        return { entries: maximumEntries, truncated: true, unsafePath: null };
      }
      const path = join(directory, child.name);
      if (child.isSymbolicLink() || lstatSync(path).isSymbolicLink()) {
        return { entries, truncated: false, unsafePath: path };
      }
      if (child.isDirectory()) pending.push(path);
    }
  }
  return { entries, truncated: false, unsafePath: null };
}

function defaultScopedPackageRoot(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve("@younndai/lyt");
    let current = dirname(entry);
    for (let depth = 0; depth < 6; depth += 1) {
      const manifest = join(current, "package.json");
      if (existsSync(manifest)) {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
        if (parsed.name === "@younndai/lyt") return dirname(current);
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch {
    // Diagnostic-only: unavailable package metadata is an info state.
  }
  return null;
}

function failure(
  id: string,
  label: string,
  message: string,
  detail?: Record<string, unknown>,
  remediation?: string,
): CheckResult {
  return {
    id,
    group: "install",
    label,
    status: "fail",
    message,
    ...(remediation === undefined ? {} : { remediation }),
    ...(detail === undefined ? {} : { detail }),
  };
}

function checkId(value: string): string {
  return value
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\r\n]+/g, " ").slice(0, 240);
}
