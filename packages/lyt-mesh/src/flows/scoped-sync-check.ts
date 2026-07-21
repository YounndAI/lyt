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
import { existsSync } from "node:fs";

import {
  AmbiguousVaultLeafError,
  GitRunTerminatedError,
  RegistryUpgradeRequiredError,
  hexToUuid7Bytes,
  isAccessRemoved,
  newUuidv7Bytes,
  parseReceiptV1ForEmission,
  readFrozenLock,
  resolveVaultSnapshotReadOnly,
  realIdentityRunner,
  runGitReadOnly,
  runGitRemoteObservation,
  uuid7BytesToDashedString,
  type GitRunResult,
  type ReceiptV1,
  type ResolveVaultSnapshotResult,
  type VaultSnapshot,
} from "@younndai/lyt-vault";

import { classifyCheckStatus } from "./sync.js";

const REMOTE_OBSERVATION_TIMEOUT_MS = 10_000;

export interface OneVaultSyncCheckScope {
  readonly kind: "one";
  readonly vault: VaultSnapshot;
}

/** The plan is the closed capability: it has no collection or pod-wide branch. */
export type ScopedSyncCheckPlan = OneVaultSyncCheckScope;

export type ScopedRemoteObservation =
  "current" | "different" | "unknown" | "not-configured" | "access-lost";

export interface LocalObservation {
  readonly state: "inactive" | "missing" | "not-git-repo" | "git";
  readonly dirtyCount: number | null;
  readonly hasUpstream: boolean;
  readonly frozen: boolean;
  readonly frozenUntil: string | null;
  readonly remaining: string | null;
  readonly remoteObjectPresent: boolean | null;
  readonly ahead: number | null;
  readonly behind: number | null;
}

export interface RemoteObservation {
  readonly kind: ScopedRemoteObservation;
}

export interface ScopedSyncCheckKernelResult {
  readonly report: ScopedVaultCheckReport;
  readonly summary: ScopedCheckSummary;
  readonly exitCode: number;
  readonly receiptEvidence: Readonly<{
    before: readonly ReceiptV1["evidence"]["before"][number][];
    after: readonly ReceiptV1["evidence"]["after"][number][];
  }>;
}

export interface ScopedVaultCheckReport {
  readonly rid: string;
  readonly name: string;
  readonly path: string;
  readonly status: string;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly dirtyCount: number | null;
  readonly hasUpstream: boolean;
  readonly frozen: boolean;
  readonly frozenUntil: string | null;
  readonly remaining: string | null;
  readonly vaultStatus: string;
  readonly remoteObservation: ScopedRemoteObservation;
}

export interface ScopedCheckSummary {
  readonly clean: number;
  readonly dirty: number;
  readonly ahead: number;
  readonly behind: number;
  readonly diverged: number;
  readonly frozen: number;
  readonly noUpstream: number;
  readonly skippedNonActive: number;
}

export interface ScopedSyncCheckSuccess {
  readonly kind: "checked";
  readonly scope: ScopedSyncCheckPlan;
  readonly reports: readonly [ScopedVaultCheckReport];
  readonly summary: ScopedCheckSummary;
  readonly receipt: ReceiptV1;
  readonly exitCode: number;
}

export type ScopedSyncCheckRefusalCode =
  "registry-missing" | "vault-not-found" | "vault-ambiguous" | "registry-upgrade-required";

export interface ScopedSyncCheckRefusal {
  readonly kind: "refused";
  readonly scope: Readonly<{ kind: "one"; requested: string }>;
  readonly reports: readonly [];
  readonly summary: ScopedCheckSummary;
  readonly refusal: Readonly<{
    code: ScopedSyncCheckRefusalCode;
    summary: string;
    nextAction: string;
  }>;
  readonly receipt: ReceiptV1;
  readonly exitCode: 2;
}

export type ScopedSyncCheckOutcome = ScopedSyncCheckSuccess | ScopedSyncCheckRefusal;

type LocalGitRunner = (
  args: readonly string[],
  opts: { cwd: string; allowFailure?: boolean; timeoutMs?: number },
) => Promise<GitRunResult>;

type RemoteGitRunner = LocalGitRunner;

export interface ScopedSyncCheckDependencies {
  resolveVaultSnapshot?: (handle: string) => Promise<ResolveVaultSnapshotResult>;
  plan?: (scope: OneVaultSyncCheckScope) => ScopedSyncCheckPlan;
  collect?: (
    plan: ScopedSyncCheckPlan,
    deps?: Pick<
      ScopedSyncCheckDependencies,
      "runGitReadOnly" | "runGitRemoteObservation" | "now" | "ghAuthOk"
    >,
  ) => Promise<Readonly<{ local: LocalObservation; remote: RemoteObservation }>>;
  runGitReadOnly?: LocalGitRunner;
  runGitRemoteObservation?: RemoteGitRunner;
  ghAuthOk?: () => boolean | null;
  now?: () => Date;
  newReceiptId?: () => string;
}

export function planScopedSyncCheck(scope: OneVaultSyncCheckScope): ScopedSyncCheckPlan {
  if (scope.kind !== "one") throw new TypeError("scoped sync check requires exactly one vault");
  return Object.freeze({ kind: "one" as const, vault: scope.vault });
}

export async function collectScopedSyncCheckObservations(
  plan: ScopedSyncCheckPlan,
  deps: Pick<
    ScopedSyncCheckDependencies,
    "runGitReadOnly" | "runGitRemoteObservation" | "now" | "ghAuthOk"
  > = {},
): Promise<Readonly<{ local: LocalObservation; remote: RemoteObservation }>> {
  const local = deps.runGitReadOnly ?? runGitReadOnly;
  const remote = deps.runGitRemoteObservation ?? runGitRemoteObservation;
  const ghAuthOk = deps.ghAuthOk ?? (() => realIdentityRunner.ghAuthStatus());
  const now = (deps.now ?? (() => new Date()))();
  const vault = plan.vault;

  if (vault.status !== "active" && vault.status !== "access_lost") {
    return observations(localObservation({ state: "inactive" }), "not-configured");
  }
  if (!existsSync(vault.path)) {
    return observations(localObservation({ state: "missing" }), "unknown");
  }

  const frozen = readFrozenLock(vault.path, now);
  const isFrozen = frozen.frozen && !frozen.expired;
  const frozenFields = {
    frozen: isFrozen,
    frozenUntil: frozen.frozenUntil,
    remaining: frozen.remaining,
  };
  const gitDir = await local(["rev-parse", "--git-dir"], {
    cwd: vault.path,
    allowFailure: true,
  });
  if (gitDir.code !== 0) {
    return observations(
      localObservation({
        ...frozenFields,
        state: "not-git-repo",
      }),
      "unknown",
    );
  }

  const upstream = await local(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    cwd: vault.path,
    allowFailure: true,
  });
  if (upstream.code !== 0) {
    const dirtyCount = await observeDirtyCount(local, vault.path);
    return observations(
      localObservation({
        ...frozenFields,
        state: "git",
        dirtyCount,
        hasUpstream: false,
      }),
      "not-configured",
    );
  }

  const dirtyCount = await observeDirtyCount(local, vault.path);
  const tracking = await observeConfiguredUpstream(local, vault.path);
  if (tracking === null) {
    return observations(
      localObservation({
        ...frozenFields,
        state: "git",
        dirtyCount,
        hasUpstream: true,
      }),
      "unknown",
    );
  }

  let remoteHead: string | null = null;
  try {
    const observed = await remote(
      ["ls-remote", "--exit-code", tracking.remoteName, tracking.remoteRef],
      {
        cwd: vault.path,
        allowFailure: true,
        timeoutMs: REMOTE_OBSERVATION_TIMEOUT_MS,
      },
    );
    if (observed.code !== 0) {
      const authVerdict = observed.stderr.length === 0 ? null : ghAuthOk();
      const kind = isAccessRemoved(observed.stderr, { ghAuthOk: authVerdict })
        ? "access-lost"
        : "unknown";
      return observations(
        localObservation({
          ...frozenFields,
          state: "git",
          dirtyCount,
          hasUpstream: true,
        }),
        kind,
      );
    }
    remoteHead = parseRemoteHead(observed.stdout, tracking.remoteRef);
  } catch (error) {
    if (!(error instanceof GitRunTerminatedError)) throw error;
    return observations(
      localObservation({
        ...frozenFields,
        state: "git",
        dirtyCount,
        hasUpstream: true,
      }),
      "unknown",
    );
  }
  if (remoteHead === null) {
    return observations(
      localObservation({
        ...frozenFields,
        state: "git",
        dirtyCount,
        hasUpstream: true,
      }),
      "unknown",
    );
  }

  const cached = await local(["rev-parse", "--verify", "@{u}^{commit}"], {
    cwd: vault.path,
    allowFailure: true,
  });
  const cachedHead = cached.code === 0 ? parseObjectId(cached.stdout) : null;
  const remoteObservation: ScopedRemoteObservation =
    cachedHead === remoteHead ? "current" : "different";
  if (remoteObservation === "different") {
    const object = await local(["cat-file", "-e", `${remoteHead}^{commit}`], {
      cwd: vault.path,
      allowFailure: true,
    });
    if (object.code !== 0) {
      return observations(
        localObservation({
          ...frozenFields,
          state: "git",
          dirtyCount,
          hasUpstream: true,
          remoteObjectPresent: false,
        }),
        remoteObservation,
      );
    }
  }

  const counts = await local(["rev-list", "--left-right", "--count", `HEAD...${remoteHead}`], {
    cwd: vault.path,
    allowFailure: true,
  });
  const aheadBehind = counts.code === 0 ? parseAheadBehind(counts.stdout) : null;
  return observations(
    localObservation({
      ...frozenFields,
      state: "git",
      dirtyCount,
      hasUpstream: true,
      remoteObjectPresent: true,
      ahead: aheadBehind?.ahead ?? null,
      behind: aheadBehind?.behind ?? null,
    }),
    aheadBehind === null || dirtyCount === null ? "unknown" : remoteObservation,
  );
}

/** Pure classification kernel: its three immutable facts are the entire capability. */
export function evaluateScopedSyncCheck(
  vault: VaultSnapshot,
  local: LocalObservation,
  remote: RemoteObservation,
): ScopedSyncCheckKernelResult {
  const frozenStatus = local.frozen ? "frozen" : null;
  let checked: ScopedVaultCheckReport;

  if (local.state === "inactive") {
    checked = report(vault, {
      status: vault.status,
      vaultStatus: vault.status,
      remoteObservation: remote.kind,
    });
  } else if (local.state === "missing") {
    checked = report(vault, {
      status: "missing",
      vaultStatus: vault.status,
      remoteObservation: remote.kind,
    });
  } else if (local.state === "not-git-repo") {
    checked = report(vault, {
      ...local,
      status: "not-git-repo",
      vaultStatus: vault.status,
      remoteObservation: remote.kind,
    });
  } else if (!local.hasUpstream || remote.kind === "not-configured") {
    checked = report(vault, {
      ...local,
      status: frozenStatus ?? "no-upstream",
      vaultStatus: vault.status,
      remoteObservation: remote.kind,
    });
  } else if (remote.kind === "access-lost") {
    checked = report(vault, {
      ...local,
      status: frozenStatus ?? "access_lost",
      vaultStatus: "access_lost",
      remoteObservation: remote.kind,
    });
  } else if (remote.kind === "unknown") {
    checked = report(vault, {
      ...local,
      status: frozenStatus ?? (vault.status === "access_lost" ? "access_lost" : "remote-unknown"),
      vaultStatus: vault.status,
      remoteObservation: remote.kind,
    });
  } else if (remote.kind === "different" && local.remoteObjectPresent === false) {
    checked = report(vault, {
      ...local,
      status: frozenStatus ?? "remote-different",
      vaultStatus: vault.status,
      remoteObservation: remote.kind,
    });
  } else if (local.ahead === null || local.behind === null || local.dirtyCount === null) {
    checked = report(vault, {
      ...local,
      status: frozenStatus ?? "remote-unknown",
      vaultStatus: vault.status,
      remoteObservation: "unknown",
    });
  } else {
    checked = report(vault, {
      ...local,
      status: classifyCheckStatus({
        ahead: local.ahead,
        behind: local.behind,
        dirtyCount: local.dirtyCount,
        hasUpstream: true,
        frozen: local.frozen,
      }),
      vaultStatus: vault.status === "access_lost" ? "active" : vault.status,
      remoteObservation: remote.kind,
    });
  }

  const summary = summarize(checked);
  const exitCode = exitCodeFor(checked);
  return Object.freeze({
    report: checked,
    summary,
    exitCode,
    receiptEvidence: Object.freeze({
      before: Object.freeze([
        Object.freeze({
          kind: "vault-snapshot",
          subject: "selected vault snapshot",
          digest: digest(vault),
          count: 1,
        }),
      ]),
      after: Object.freeze([
        Object.freeze({ kind: "sync-observation", subject: checked.status, count: 1 }),
      ]),
    }),
  });
}

export async function inspectScopedSyncCheck(
  plan: ScopedSyncCheckPlan,
  deps: Pick<
    ScopedSyncCheckDependencies,
    "runGitReadOnly" | "runGitRemoteObservation" | "now" | "ghAuthOk"
  > = {},
): Promise<ScopedVaultCheckReport> {
  const observed = await collectScopedSyncCheckObservations(plan, deps);
  return evaluateScopedSyncCheck(plan.vault, observed.local, observed.remote).report;
}

export async function scopedSyncCheckFlow(
  handle: string,
  deps: ScopedSyncCheckDependencies = {},
): Promise<ScopedSyncCheckOutcome> {
  const resolveSnapshot = deps.resolveVaultSnapshot ?? resolveVaultSnapshotReadOnly;
  let resolved: ResolveVaultSnapshotResult;
  try {
    resolved = await resolveSnapshot(handle);
  } catch (error) {
    if (error instanceof AmbiguousVaultLeafError) {
      return refusal(handle, "vault-ambiguous", deps);
    }
    if (error instanceof RegistryUpgradeRequiredError) {
      return refusal(handle, "registry-upgrade-required", deps);
    }
    throw error;
  }
  if (resolved.kind === "missing") return refusal(handle, "registry-missing", deps);
  if (resolved.kind === "not-found") return refusal(handle, "vault-not-found", deps);

  const scope = Object.freeze({ kind: "one" as const, vault: resolved.vault });
  const plan = (deps.plan ?? planScopedSyncCheck)(scope);
  const observed = await (deps.collect ?? collectScopedSyncCheckObservations)(plan, deps);
  const evaluated = evaluateScopedSyncCheck(resolved.vault, observed.local, observed.remote);
  const checked = evaluated.report;
  const reports = Object.freeze([checked]) as unknown as readonly [ScopedVaultCheckReport];
  return Object.freeze({
    kind: "checked" as const,
    scope: plan,
    reports,
    summary: evaluated.summary,
    receipt: successReceipt(resolved.vault, evaluated, deps),
    exitCode: evaluated.exitCode,
  });
}

function localObservation(fields: Partial<LocalObservation>): LocalObservation {
  return Object.freeze({
    state: fields.state ?? "git",
    dirtyCount: fields.dirtyCount ?? null,
    hasUpstream: fields.hasUpstream ?? false,
    frozen: fields.frozen ?? false,
    frozenUntil: fields.frozenUntil ?? null,
    remaining: fields.remaining ?? null,
    remoteObjectPresent: fields.remoteObjectPresent ?? null,
    ahead: fields.ahead ?? null,
    behind: fields.behind ?? null,
  });
}

function observations(
  local: LocalObservation,
  kind: ScopedRemoteObservation,
): Readonly<{ local: LocalObservation; remote: RemoteObservation }> {
  return Object.freeze({ local, remote: Object.freeze({ kind }) });
}

function report(
  vault: VaultSnapshot,
  fields: Partial<Omit<ScopedVaultCheckReport, "rid" | "name" | "path">>,
): ScopedVaultCheckReport {
  return Object.freeze({
    rid: vault.rid,
    name: vault.canonicalName,
    path: vault.path,
    status: fields.status ?? "remote-unknown",
    ahead: fields.ahead ?? null,
    behind: fields.behind ?? null,
    dirtyCount: fields.dirtyCount ?? null,
    hasUpstream: fields.hasUpstream ?? false,
    frozen: fields.frozen ?? false,
    frozenUntil: fields.frozenUntil ?? null,
    remaining: fields.remaining ?? null,
    vaultStatus: fields.vaultStatus ?? vault.status,
    remoteObservation: fields.remoteObservation ?? "unknown",
  });
}

async function observeDirtyCount(run: LocalGitRunner, cwd: string): Promise<number | null> {
  const status = await run(["status", "--porcelain"], { cwd, allowFailure: true });
  if (status.code !== 0) return null;
  return status.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;
}

async function observeConfiguredUpstream(
  run: LocalGitRunner,
  cwd: string,
): Promise<{ remoteName: string; remoteRef: string } | null> {
  const branch = await run(["symbolic-ref", "--quiet", "HEAD"], { cwd, allowFailure: true });
  const branchRef = branch.code === 0 ? branch.stdout.trim() : "";
  if (!branchRef.startsWith("refs/heads/")) return null;
  const configured = await run(
    ["for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)", branchRef],
    { cwd, allowFailure: true },
  );
  if (configured.code !== 0) return null;
  const [remoteName = "", remoteRef = ""] = configured.stdout.trim().split("\0", 2);
  if (remoteName.length === 0 || remoteRef.length === 0) return null;
  return { remoteName, remoteRef };
}

function parseRemoteHead(stdout: string, expectedRef: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const [objectId, ref] = line.trim().split(/\s+/, 2);
    if (ref === expectedRef && objectId !== undefined) return parseObjectId(objectId);
  }
  return null;
}

function parseObjectId(value: string): string | null {
  const candidate = value.trim().toLowerCase();
  return /^[a-f0-9]{40,64}$/.test(candidate) ? candidate : null;
}

function parseAheadBehind(stdout: string): { ahead: number; behind: number } | null {
  const match = /^(\d+)\s+(\d+)$/.exec(stdout.trim());
  if (match === null) return null;
  return { ahead: Number(match[1]), behind: Number(match[2]) };
}

function summarize(checked: ScopedVaultCheckReport): ScopedCheckSummary {
  const summary = {
    clean: 0,
    dirty: 0,
    ahead: 0,
    behind: 0,
    diverged: 0,
    frozen: 0,
    noUpstream: 0,
    skippedNonActive: 0,
  };
  if (checked.vaultStatus !== "active") summary.skippedNonActive = 1;
  else if (checked.status === "clean") summary.clean = 1;
  else if (checked.status === "dirty") summary.dirty = 1;
  else if (checked.status === "dirty-behind") {
    summary.dirty = 1;
    summary.behind = 1;
  } else if (checked.status.startsWith("ahead-")) summary.ahead = 1;
  else if (checked.status.startsWith("behind-")) summary.behind = 1;
  else if (checked.status === "diverged") summary.diverged = 1;
  else if (checked.status === "frozen") summary.frozen = 1;
  else if (checked.status === "no-upstream") summary.noUpstream = 1;
  return Object.freeze(summary);
}

function exitCodeFor(checked: ScopedVaultCheckReport): number {
  if (checked.status === "remote-unknown" || checked.status === "access_lost") return 2;
  if (
    checked.status === "dirty" ||
    checked.status === "dirty-behind" ||
    checked.status === "diverged" ||
    checked.status === "remote-different" ||
    checked.status.startsWith("ahead-") ||
    checked.status.startsWith("behind-")
  ) {
    return 1;
  }
  return 0;
}

const REFUSAL_COPY: Record<ScopedSyncCheckRefusalCode, { summary: string; nextAction: string }> = {
  "registry-missing": {
    summary: "The local registry does not exist, so the requested vault cannot be checked.",
    nextAction: "Initialize or adopt the vault, then retry the scoped check.",
  },
  "vault-not-found": {
    summary: "No registered vault matches the requested address.",
    nextAction: "Use lyt vault list to choose a registered vault, then retry.",
  },
  "vault-ambiguous": {
    summary: "The requested vault address is ambiguous.",
    nextAction: "Retry with a mesh-qualified vault address.",
  },
  "registry-upgrade-required": {
    summary: "The local registry requires an upgrade before read-only inspection.",
    nextAction: "Run a normal mutating Lyt command to upgrade it, then retry.",
  },
};

function refusal(
  handle: string,
  code: ScopedSyncCheckRefusalCode,
  deps: ScopedSyncCheckDependencies,
): ScopedSyncCheckRefusal {
  const copy = REFUSAL_COPY[code];
  const scope = Object.freeze({ kind: "one" as const, requested: handle });
  const reports = Object.freeze([]) as readonly [];
  return Object.freeze({
    kind: "refused" as const,
    scope,
    reports,
    summary: emptySummary(),
    refusal: Object.freeze({ code, ...copy }),
    receipt: refusalReceipt(handle, code, copy, deps),
    exitCode: 2 as const,
  });
}

function successReceipt(
  vault: VaultSnapshot,
  evaluated: ScopedSyncCheckKernelResult,
  deps: ScopedSyncCheckDependencies,
): ReceiptV1 {
  const timestamp = (deps.now ?? (() => new Date()))().toISOString();
  const terminal = checkReceiptTerminal(evaluated.exitCode);
  return parseReceiptV1ForEmission({
    ...receiptIdentity(deps),
    operation: "sync-check",
    scope: { kind: "vault", vault_id: dashedVaultId(vault.rid) },
    timestamps: { started_at: timestamp, finished_at: timestamp },
    replay: { disposition: "new", key_digest: digest(["sync-check", vault.rid]) },
    status: terminal.status,
    exit_code: evaluated.exitCode,
    mutations: { local: 0, remote: 0 },
    evidence: {
      before: [...evaluated.receiptEvidence.before],
      after: [...evaluated.receiptEvidence.after],
    },
    next_action: terminal.next_action,
    error: terminal.error,
  });
}

function checkReceiptTerminal(
  exitCode: number,
): Pick<ReceiptV1, "status" | "next_action" | "error"> {
  if (exitCode === 0) return { status: "no-op", next_action: null, error: null };
  if (exitCode === 1) {
    return {
      status: "failed",
      next_action: {
        code: "run-scoped-sync",
        summary: "Run a scoped sync for the selected vault.",
      },
      error: {
        code: "sync-required",
        summary: "The selected vault has changes that require sync.",
        retryable: true,
      },
    };
  }
  return {
    status: "failed",
    next_action: {
      code: "retry-scoped-check",
      summary: "Retry the scoped check when the online destination is reachable.",
    },
    error: {
      code: "check-incomplete",
      summary: "The scoped check could not determine the selected vault online state.",
      retryable: true,
    },
  };
}

function refusalReceipt(
  handle: string,
  code: ScopedSyncCheckRefusalCode,
  copy: { summary: string; nextAction: string },
  deps: ScopedSyncCheckDependencies,
): ReceiptV1 {
  const timestamp = (deps.now ?? (() => new Date()))().toISOString();
  return parseReceiptV1ForEmission({
    ...receiptIdentity(deps),
    operation: "sync-check",
    scope: { kind: "system" },
    timestamps: { started_at: timestamp, finished_at: timestamp },
    replay: { disposition: "rejected", key_digest: digest(["sync-check", handle]) },
    status: "refused",
    exit_code: 2,
    mutations: { local: 0, remote: 0 },
    evidence: { before: [], after: [] },
    next_action: { code: "retry-scoped-check", summary: copy.nextAction },
    error: { code, summary: copy.summary, retryable: true },
  });
}

function receiptIdentity(deps: ScopedSyncCheckDependencies): {
  schema_id: "lyt.receipt";
  schema_version: { major: 1; minor: 0 };
  operation_id: string;
  attempt_id: string;
} {
  const next = deps.newReceiptId ?? (() => uuid7BytesToDashedString(newUuidv7Bytes()));
  const operationId = next();
  let attemptId = next();
  while (attemptId === operationId) attemptId = next();
  return {
    schema_id: "lyt.receipt",
    schema_version: { major: 1, minor: 0 },
    operation_id: operationId,
    attempt_id: attemptId,
  };
}

function dashedVaultId(rid: string): string {
  return uuid7BytesToDashedString(hexToUuid7Bytes(rid));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function emptySummary(): ScopedCheckSummary {
  return Object.freeze({
    clean: 0,
    dirty: 0,
    ahead: 0,
    behind: 0,
    diverged: 0,
    frozen: 0,
    noUpstream: 0,
    skippedNonActive: 0,
  });
}
