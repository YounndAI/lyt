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

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { cwd } from "node:process";
import { join, posix as posixPath, relative, sep } from "node:path";

import type { Client } from "@libsql/client";

import { isIndexable, walkVaultMarkdownFiles } from "../util/indexable.js";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { listFederationStates } from "../registry/federation-state.js";
import { listMeshes } from "../registry/meshes-repo.js";
import { getVaultByName, getVaultByRid, listVaults, type VaultRow } from "../registry/repo.js";
import { getFederationRoot, slugifyHandle } from "../util/federation-paths.js";
import {
  getInitFailureLogPath,
  readInitFailures,
  type InitFailureRecord,
} from "../util/failure-log.js";
import { isNearExpiry, readFrozenLock } from "../util/freeze-check.js";
import { checkReadmePresent } from "./readme-regen.js";
import { findLegacyAgentFiles } from "../util/agent-file-paths.js";
import { baseTopicsForClass } from "../scaffold/github-defaults.js";
import { parseOwnerRepoFromUrl, realGhClient, type GhClient } from "../util/gh.js";
import { resolvePublicVaultNames } from "../yon/federation-read.js";
import { parseVaultYon } from "../yon/parse.js";
import {
  getIdentityCachePath,
  getPodIdentityPath,
  migrateIdentityCache,
  readIdentityCache,
  readPodIdentity,
  reconcileIdentity,
} from "../util/identity-cache.js";
import { isValidGhHandle } from "../util/identity.js";
import { getLytHome } from "../util/paths.js";
import {
  getBundledPatternsDir,
  getUserPatternsDir,
  listPatternNames,
} from "../util/pattern-paths.js";
import { parseMeshYon } from "../yon/mesh-read.js";
import {
  closeVaultDb,
  getLytDbPath,
  isCorruptDatabaseError,
  isLytDbCorrupt,
  openAuditDb,
  openProvenanceDb,
} from "../registry/vault-db.js";
import { createClient } from "@libsql/client";
import { readGitRemoteOriginUrl } from "../util/git.js";
import { readMachineState } from "./machine-state.js";

export type CheckStatus = "pass" | "warn" | "fail" | "info";

export interface CheckResult {
  id: string;
  group: string;
  label: string;
  status: CheckStatus;
  message: string;
  remediation?: string | undefined;
  detail?: Record<string, unknown> | undefined;
}

export interface DoctorOptions {
  full?: boolean | undefined;
  binaryRunner?: BinaryRunner | undefined;
  ghAuthChecker?: GhAuthChecker | undefined;
  networkProbe?: NetworkProbe | undefined;
  cwdResolver?: (() => string) | undefined;
  sampleLimit?: number | undefined;
  // Brief F (P3/P4) — when true, doctor REPAIRS instead of just reporting:
  // - migrates a legacy `~/lyt/identity.yon` machine cache → `machine.yon`
  // - reconciles the machine cache against the pod SoT (pod wins on handle
  // conflict; re-stamps verified_at drift to the fresher value)
  // Default false (report-only). Wired to `lyt doctor --apply`.
  apply?: boolean | undefined;
  // Test seam — override the pod root the identity check reads. Defaults to
  // getFederationRoot() (the flat `~/lyt/pod/`).
  podRootResolver?: (() => string) | undefined;
  // Phase E — GitHub client seam for the topic-conformance check. Defaults to
  // realGhClient (live `gh api`). Tests inject a fake. The check only runs when
  // gh is authenticated AND a client is present; otherwise it emits `info`
  // (skipped) so an offline doctor never fails on it.
  ghClient?: GhClient | undefined;
}

export interface DoctorResult {
  checks: CheckResult[];
  summary: { passes: number; warnings: number; failures: number };
  exitCode: number;
}

export type BinaryRunner = (binary: string, args: readonly string[]) => string | null;
export type GhAuthChecker = () => boolean | null;
export type NetworkProbe = () => boolean;

interface BinaryRequirement {
  binary: string;
  versionArgs: readonly string[];
  minVersion: string;
  remediation: string;
}

const BINARY_REQUIREMENTS: BinaryRequirement[] = [
  {
    binary: "git",
    versionArgs: ["--version"],
    minVersion: "2.40",
    remediation: "Install git ≥ 2.40 from https://git-scm.com/downloads",
  },
  {
    binary: "node",
    versionArgs: ["--version"],
    minVersion: "20.9",
    remediation: "Install Node.js ≥ 20.9 from https://nodejs.org",
  },
  {
    binary: "npm",
    versionArgs: ["--version"],
    minVersion: "10.0",
    remediation: "Upgrade npm to ≥ 10 via `npm install -g npm@latest`",
  },
  {
    binary: "gh",
    versionArgs: ["--version"],
    minVersion: "2.50",
    remediation: "Install gh ≥ 2.50 from https://cli.github.com",
  },
];

const defaultBinaryRunner: BinaryRunner = (binary, args) => {
  // On Windows, npm/gh/git can be .cmd shims that execFileSync doesn't resolve
  // without shell=true. Args are hardcoded literals (no user input), so shell
  // expansion is safe here.
  try {
    return execFileSync(binary, args as string[], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: process.platform === "win32",
    });
  } catch {
    return null;
  }
};

const defaultGhAuthChecker: GhAuthChecker = () => {
  try {
    execFileSync("gh", ["auth", "status"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
};

const defaultNetworkProbe: NetworkProbe = () => {
  try {
    execFileSync("gh", ["api", "/user"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
};

export async function doctorFlow(opts: DoctorOptions = {}): Promise<DoctorResult> {
  const runner = opts.binaryRunner ?? defaultBinaryRunner;
  const ghAuth = opts.ghAuthChecker ?? defaultGhAuthChecker;
  const network = opts.networkProbe ?? defaultNetworkProbe;
  const cwdFn = opts.cwdResolver ?? cwd;
  const sampleLimit = opts.sampleLimit ?? 10;
  const apply = opts.apply === true;
  const podRoot = (opts.podRootResolver ?? getFederationRoot)();

  const checks: CheckResult[] = [];

  // Brief F (P4) — migrate the legacy `~/lyt/identity.yon` machine cache to
  // `machine.yon` before the identity check reads it. Idempotent + safe (the
  // cache is re-derivable); fires on EVERY doctor run (not just --apply) so a
  // pod that predates the rename is healed even on a read-only doctor.
  const migrated = migrateIdentityCache();

  for (const req of BINARY_REQUIREMENTS) {
    checks.push(checkBinary(req, runner));
  }

  checks.push(checkLytHomeShape());
  checks.push(checkLytHomeWritable());
  checks.push(checkPatternsHealth());
  checks.push(checkRegistryOpenable());
  checks.push(checkIdentityConsistency(podRoot, { apply, migrated }));
  checks.push(checkRecentInitFailures());

  // gh-related checks: warn (not fail) if gh is not authed — Lyt is usable offline.
  const ghAuthed = ghAuth();
  checks.push({
    id: "gh.auth",
    group: "github",
    label: "gh auth status",
    status: ghAuthed === true ? "pass" : "warn",
    message:
      ghAuthed === true
        ? "authenticated"
        : "gh is not authenticated (sync + sync-metadata require auth)",
    remediation: ghAuthed === true ? undefined : "Run: gh auth login",
  });

  // Network smoke — only meaningful if gh is authed.
  if (ghAuthed === true) {
    const ok = network();
    checks.push({
      id: "network.gh-api",
      group: "github",
      label: "gh api /user",
      status: ok ? "pass" : "warn",
      message: ok ? "reachable" : "gh api /user failed (offline or rate-limited?)",
    });
  } else {
    checks.push({
      id: "network.gh-api",
      group: "github",
      label: "gh api /user",
      status: "info",
      message: "skipped (gh not authed)",
    });
  }

  const registryChecks = await checkRegistry({ sampleLimit, full: opts.full === true });
  for (const r of registryChecks) checks.push(r);

  // v1.B.5 — open-once seam for the federation/mesh/ledger/marker checks.
  // The new checks all probe state derived from the registry; opening once
  // here + threading the client through avoids 4× open/close cycles on a
  // hot doctor run. They fire AFTER checkRegistry (logical
  // grouping: federation/mesh/ledger checks are downstream of the registry
  // probe). If registry.db is missing the new checks emit `info` rows so
  // the JSON shape stays stable per the ratified default (additive checks[]).
  //
  // Fed-v2 Slice 1b (#13 DELETE) — checkPublicMeshHygiene removed (the
  // @MESH_PUBLIC surface it guarded no longer exists).
  const registryDbPath = join(getLytHome(), "registry.db");
  if (existsSync(registryDbPath)) {
    const db = await openRegistry();
    try {
      checks.push(await checkFederationRepoState(db));
      for (const r of await checkMeshYonParses(db)) checks.push(r);
      for (const r of await checkLedgersYonDbPairs(db, { sampleLimit, full: opts.full === true })) {
        checks.push(r);
      }
      for (const r of await checkMarkersRender(db, { sampleLimit })) checks.push(r);
      // hardening fix-pass (2026-06-10) — the index-tier canary doctor was
      // blind to (the F15 shape one level up): per-vault lyt.db integrity +
      // behavioral FTS smoke + duplicate-origin (F8 defense-in-depth) +
      // orphan-vault surfacing (repair detected orphans, doctor said
      // exit 0 — the two health verbs disagreed).
      for (const r of await checkVaultIndexHealth(db, { sampleLimit, full: opts.full === true })) {
        checks.push(r);
      }
      checks.push(await checkDuplicateOrigins(db));
      checks.push(await checkOrphanVaults(db));
      // Phase E — GitHub repo-topic drift. Detect-only (the heal lives in
      // `lyt sync-metadata --apply`). Skipped (`info`) when gh is not authed.
      checks.push(
        await checkTopicConformance(db, {
          ghClient: opts.ghClient ?? realGhClient,
          ghAuthed: ghAuthed === true,
          sampleLimit,
          full: opts.full === true,
        }),
      );
    } finally {
      await closeRegistry(db);
    }
  } else {
    checks.push({
      id: "federation.repo-state",
      group: "federation",
      label: "federation_state ↔ disk symmetry",
      status: "info",
      message: "skipped (no registry yet)",
    });
    checks.push({
      id: "mesh.yon.parses",
      group: "mesh",
      label: "every mesh.yon parses",
      status: "info",
      message: "skipped (no registry yet)",
    });
    checks.push({
      id: "ledgers.yon-db-pairs",
      group: "vaults",
      label: "ledger YON + DB pairs in sync (most-recent month)",
      status: "info",
      message: "skipped (no registry yet)",
    });
    checks.push({
      id: "markers.render",
      group: "mesh",
      label: "★ main-vault markers render",
      status: "info",
      message: "skipped (no registry yet)",
    });
    checks.push({
      id: "vaults.index-db-integrity",
      group: "vaults",
      label: "per-vault lyt.db openable + integrity",
      status: "info",
      message: "skipped (no registry yet)",
    });
    checks.push({
      id: "vaults.index-fts-smoke",
      group: "vaults",
      label: "FTS index reflects on-disk figments",
      status: "info",
      message: "skipped (no registry yet)",
    });
    checks.push({
      id: "vaults.duplicate-origin",
      group: "vaults",
      label: "no two vaults share a git origin",
      status: "info",
      message: "skipped (no registry yet)",
    });
    checks.push({
      id: "registry.orphan-vaults",
      group: "registry",
      label: "every active vault has a home mesh",
      status: "info",
      message: "skipped (no registry yet)",
    });
    checks.push({
      id: "github.topic-conformance",
      group: "github",
      label: "GitHub repo topics match the brand set",
      status: "info",
      message: "skipped (no registry yet)",
    });
  }

  checks.push(await checkMachineState());

  checks.push(checkSettingsJson(cwdFn()));

  const summary = summarize(checks);
  const exitCode = summary.failures > 0 ? 1 : summary.warnings > 0 ? 2 : 0;
  return { checks, summary, exitCode };
}

function summarize(checks: readonly CheckResult[]): DoctorResult["summary"] {
  let passes = 0;
  let warnings = 0;
  let failures = 0;
  for (const c of checks) {
    if (c.status === "pass") passes++;
    else if (c.status === "warn") warnings++;
    else if (c.status === "fail") failures++;
  }
  return { passes, warnings, failures };
}

function checkBinary(req: BinaryRequirement, runner: BinaryRunner): CheckResult {
  const raw = runner(req.binary, req.versionArgs);
  if (raw === null) {
    return {
      id: `binary.${req.binary}`,
      group: "binaries",
      label: `${req.binary} (>= ${req.minVersion})`,
      status: req.binary === "gh" ? "warn" : "fail",
      message: `not found on PATH`,
      remediation: req.remediation,
    };
  }
  const version = extractVersion(raw);
  if (!version) {
    return {
      id: `binary.${req.binary}`,
      group: "binaries",
      label: `${req.binary} (>= ${req.minVersion})`,
      status: "warn",
      message: `present but version unparseable: ${raw.split("\n")[0]}`,
    };
  }
  const ok = compareVersions(version, req.minVersion) >= 0;
  return {
    id: `binary.${req.binary}`,
    group: "binaries",
    label: `${req.binary} (>= ${req.minVersion})`,
    status: ok ? "pass" : req.binary === "gh" ? "warn" : "fail",
    message: ok ? `${version}` : `${version} (below required ${req.minVersion})`,
    remediation: ok ? undefined : req.remediation,
  };
}

function extractVersion(s: string): string | null {
  const m = s.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1]! : null;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number(n));
  const pb = b.split(".").map((n) => Number(n));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function checkLytHomeShape(): CheckResult {
  const home = getLytHome();
  const exists = existsSync(home);
  return {
    id: "lyt-home.exists",
    group: "lyt-home",
    label: "~/lyt/ exists",
    status: exists ? "pass" : "info",
    message: exists ? home : `${home} does not exist (will be created on first vault init)`,
  };
}

function checkLytHomeWritable(): CheckResult {
  const home = getLytHome();
  if (!existsSync(home)) {
    return {
      id: "lyt-home.writable",
      group: "lyt-home",
      label: "~/lyt/ writable",
      status: "info",
      message: "skipped (~/lyt/ does not exist yet)",
    };
  }
  const probe = join(home, `.lyt-doctor-probe-${process.pid}`);
  try {
    writeFileSync(probe, "doctor", "utf8");
    unlinkSync(probe);
    return {
      id: "lyt-home.writable",
      group: "lyt-home",
      label: "~/lyt/ writable",
      status: "pass",
      message: "write-probe ok",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: "lyt-home.writable",
      group: "lyt-home",
      label: "~/lyt/ writable",
      status: "warn",
      message: `write-probe failed: ${msg}`,
      remediation: "Ensure the user has full control over the lyt home directory.",
    };
  }
}

// 0.9.4 — capture-loop / hollow-pattern check. `lyt capture`/`recall`
// run a pattern (knowledge-capture) out of `~/lyt/patterns/<name>/`. A hollow
// pod (the patterns dir missing, empty, or any bundled pattern present but
// missing its `pattern.yon`) means the capture loop is DEAD pod-wide — the exact
// hollow-pod upgrade failure this check guards. doctor must FAIL on it (not warn)
// so a hollow pod is machine-detectable, and point at the heal path. On a truly
// fresh machine (no `~/lyt/`) it's `info` (nothing installed yet — first init seeds it).
function checkPatternsHealth(): CheckResult {
  const id = "patterns.capture-loop";
  const group = "patterns";
  const label = "capture-loop patterns installed (not hollow)";
  const home = getLytHome();
  if (!existsSync(home)) {
    return {
      id,
      group,
      label,
      status: "info",
      message: "skipped (~/lyt/ does not exist yet — patterns seed on first init)",
    };
  }
  const bundledDir = getBundledPatternsDir();
  const userDir = getUserPatternsDir();

  // The patterns dir being ENTIRELY ABSENT is not, by itself, a hollow-pod
  // failure: a fresh machine (or an isolated test env) simply hasn't installed
  // patterns yet — the first `init`/postinstall seeds them. The hollow-pod
  // failure mode is specifically a patterns dir that EXISTS but is hollow/incomplete
  // (the broken pre-upgrade state the postinstall + init-heal now repair). So
  // only an EXISTING patterns dir is graded; an absent one is `info`.
  if (!existsSync(userDir)) {
    return {
      id,
      group,
      label,
      status: "info",
      message: "skipped (~/lyt/patterns not present yet — seeds on first init/postinstall)",
    };
  }

  const expected = existsSync(bundledDir) ? listPatternNames(bundledDir) : [];
  const installed = new Set(listPatternNames(userDir));

  // The patterns dir exists but holds ZERO valid patterns → hollow pod.
  if (installed.size === 0) {
    return {
      id,
      group,
      label,
      status: "fail",
      message: `~/lyt/patterns exists but holds no valid pattern (no pattern.yon) — the capture loop is dead pod-wide.`,
      remediation:
        "Reinstall @younndai/lyt-vault (postinstall re-seeds) or run `lyt mesh init` / `lyt vault init` to trigger init-heal (healPatterns).",
    };
  }

  // A bundled default present-but-hollow (dir exists, no pattern.yon) is broken.
  const hollow: string[] = [];
  for (const name of expected) {
    if (installed.has(name)) continue;
    const dir = join(userDir, name);
    if (existsSync(dir)) hollow.push(name);
    // A bundled default entirely ABSENT from an otherwise-populated user dir is
    // not graded as a failure here (the user may have removed a default they
    // don't want); only HOLLOW dirs are the hollow-pod trap.
  }

  if (hollow.length > 0) {
    return {
      id,
      group,
      label,
      status: "fail",
      message: `hollow capture-loop pattern(s): ${hollow.join(", ")} — \`lyt capture\`/\`recall\` will fail.`,
      remediation:
        "Reinstall @younndai/lyt-vault or run a `lyt mesh init`/`lyt vault init` to trigger init-heal (re-seeds hollow pattern dirs).",
    };
  }

  return {
    id,
    group,
    label,
    status: "pass",
    message: `${installed.size} pattern${installed.size === 1 ? "" : "s"} installed; none hollow`,
  };
}

function checkRegistryOpenable(): CheckResult {
  const home = getLytHome();
  const dbPath = join(home, "registry.db");
  if (!existsSync(dbPath)) {
    return {
      id: "registry.exists",
      group: "registry",
      label: "registry.db exists",
      status: "info",
      message: "no registry yet (no vaults registered on this machine)",
    };
  }
  return {
    id: "registry.exists",
    group: "registry",
    label: "registry.db exists",
    status: "pass",
    message: dbPath,
  };
}

// Lane O Phase 0 — surface recent `lyt init` / wizard failure records (the
// PROTO-StepOutcome instrumentation in util/failure-log.ts). The init flow +
// wizard write a LOCAL, AI-readable record at each real death point (gh-auth,
// network probe, first-vault create, federation init). This check reads the tail
// of that log and surfaces it so a later doctor run — or an agent priming on the
// pod — can see what actually went wrong, in machine-parseable form (detail
// carries the structured records).
//
// Status: `info` when recent failures exist (they are diagnostic history, not a
// live fault — the failing init may since have succeeded on a re-run); `pass`
// when the log is empty / absent. Never `warn`/`fail`: a recorded failure does
// NOT mean the system is currently broken, so it must not push the doctor exit
// code. Read is fully tolerant (readInitFailures never throws).
function checkRecentInitFailures(): CheckResult {
  const id = "init.recent-failures";
  const group = "init";
  const label = "recent init failures";
  const recent: InitFailureRecord[] = readInitFailures(20);
  if (recent.length === 0) {
    return {
      id,
      group,
      label,
      status: "pass",
      message: "no recent init/wizard failures recorded",
    };
  }
  const last = recent[recent.length - 1]!;
  return {
    id,
    group,
    label,
    status: "info",
    message: `${recent.length} recent init/wizard failure(s) recorded; latest: [${last.site}] ${last.summary} (${last.ts})`,
    remediation: `Review ${getInitFailureLogPath()} (most-recent last) — re-run \`lyt init\` after addressing the cause.`,
    detail: { count: recent.length, records: recent },
  };
}

// Brief F (P2) — validity + consistency of the machine cache vs the pod SoT.
// Parses `~/lyt/machine.yon` + (if a pod exists) `<pod>/identity.yon`; asserts
// each is a valid @IDENTITY (provider+handle+verified_at present; handle passes
// isValidGhHandle); asserts the two AGREE on `handle`.
// - handle drift → warn (a real conflict)
// - verified_at drift only → info (cosmetic lag; reconcile closes it)
// - invalid handle / unparse → warn
// With `apply` (= `lyt doctor --apply`) it reconciles in place (pod wins on
// handle conflict; re-stamps verified_at to the fresher value) and reports the
// repair it performed.
function checkIdentityConsistency(
  podRoot: string,
  ctx: { apply: boolean; migrated: boolean },
): CheckResult {
  const id = "identity.consistency";
  const group = "identity";
  const label = "machine.yon ↔ pod identity.yon";
  const machinePath = getIdentityCachePath();
  const podPath = getPodIdentityPath(podRoot);

  const machine = readIdentityCache();
  const podExists = existsSync(podPath);
  const pod = podExists ? readPodIdentity(podRoot) : null;
  const migratedNote = ctx.migrated ? " (migrated legacy identity.yon → machine.yon)" : "";

  // No machine cache yet — fresh install before any vault init.
  if (machine === null) {
    return {
      id,
      group,
      label,
      status: "info",
      message: `no machine cache yet (${machinePath} absent)${migratedNote}`,
    };
  }

  // Validate the machine cache shape.
  if (!isValidGhHandle(machine.handle)) {
    return {
      id,
      group,
      label,
      status: "warn",
      message: `machine.yon handle ${JSON.stringify(machine.handle)} is not a valid GitHub handle${migratedNote}`,
      remediation: "Run: lyt identity refresh (re-pull the handle from gh)",
      detail: { machinePath, handle: machine.handle },
    };
  }

  // No pod materialised — machine cache stands alone; nothing to reconcile.
  if (!podExists || pod === null) {
    return {
      id,
      group,
      label,
      status: "pass",
      message: `machine.yon valid (github:${machine.handle}); no pod identity to cross-check${migratedNote}`,
    };
  }

  if (!isValidGhHandle(pod.handle)) {
    return {
      id,
      group,
      label,
      status: "warn",
      message: `pod identity.yon handle ${JSON.stringify(pod.handle)} is not a valid GitHub handle${migratedNote}`,
      remediation:
        "Run: lyt doctor --apply (reconcile from the machine cache) or repair the pod identity",
      detail: { podPath, handle: pod.handle },
    };
  }

  // Handle conflict — the real drift WARN. --apply reconciles (pod wins).
  if (pod.handle !== machine.handle) {
    if (ctx.apply) {
      const outcome = reconcileIdentity(podRoot);
      return {
        id,
        group,
        label,
        status: "pass",
        message: `reconciled handle conflict — pod wins (github:${pod.handle} over github:${machine.handle}); machine.yon rewritten${migratedNote}`,
        detail: { reconcile: outcome },
      };
    }
    return {
      id,
      group,
      label,
      status: "warn",
      message: `handle CONFLICT — machine.yon=github:${machine.handle} vs pod identity.yon=github:${pod.handle}${migratedNote}`,
      remediation: "Run: lyt doctor --apply (pod wins: rewrites the machine cache from the pod)",
      detail: { machineHandle: machine.handle, podHandle: pod.handle, machinePath, podPath },
    };
  }

  // Handles agree — only verified_at may drift (cosmetic). info, not warn.
  if (pod.verifiedAtMs !== machine.verifiedAtMs) {
    if (ctx.apply) {
      const outcome = reconcileIdentity(podRoot);
      return {
        id,
        group,
        label,
        status: "pass",
        message: `consistent (github:${machine.handle}); re-stamped verified_at drift to the fresher value${migratedNote}`,
        detail: { reconcile: outcome },
      };
    }
    return {
      id,
      group,
      label,
      status: "info",
      message: `consistent on handle (github:${machine.handle}); verified_at drift (cosmetic — \`lyt doctor --apply\` closes it)${migratedNote}`,
      detail: {
        machineVerifiedAt: new Date(machine.verifiedAtMs).toISOString(),
        podVerifiedAt: new Date(pod.verifiedAtMs).toISOString(),
      },
    };
  }

  return {
    id,
    group,
    label,
    status: "pass",
    message: `valid + consistent (github:${machine.handle})${migratedNote}`,
  };
}

async function checkRegistry(opts: { sampleLimit: number; full: boolean }): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const home = getLytHome();
  const dbPath = join(home, "registry.db");
  if (!existsSync(dbPath)) return out;

  const db = await openRegistry();
  let vaults: VaultRow[] = [];
  try {
    vaults = await listVaults(db);
  } finally {
    await closeRegistry(db);
  }

  const active = vaults.filter((v) => v.status === "active");
  const orphans: VaultRow[] = [];
  for (const v of active) {
    if (!existsSync(v.path)) orphans.push(v);
  }
  out.push({
    id: "registry.orphans",
    group: "registry",
    label: "registry path consistency",
    status: orphans.length === 0 ? "pass" : "warn",
    message:
      orphans.length === 0
        ? `${active.length} active vaults; all paths exist`
        : `${orphans.length} active rows have missing paths`,
    remediation:
      orphans.length === 0 ? undefined : "Run: lyt vault verify (auto-flags missing rows)",
    detail:
      orphans.length === 0
        ? undefined
        : { orphans: orphans.map((o) => ({ name: o.name, path: o.path })) },
  });

  const subjects = opts.full ? active : active.slice(0, opts.sampleLimit);
  const lytDirIssues: { name: string; reason: string }[] = [];
  for (const v of subjects) {
    if (!existsSync(v.path)) continue;
    const yon = join(v.path, ".lyt", "vault.yon");
    if (!existsSync(yon)) {
      lytDirIssues.push({ name: v.name, reason: "missing .lyt/vault.yon" });
    }
  }
  out.push({
    id: "vaults.lyt-dir-shape",
    group: "vaults",
    label: opts.full
      ? `per-vault .lyt/ shape (all ${active.length})`
      : `per-vault .lyt/ shape (sample ${subjects.length}/${active.length})`,
    status: lytDirIssues.length === 0 ? "pass" : "warn",
    message:
      lytDirIssues.length === 0
        ? `all ${subjects.length} sampled vaults have .lyt/vault.yon`
        : `${lytDirIssues.length} vault(s) missing .lyt/vault.yon`,
    detail: lytDirIssues.length === 0 ? undefined : { issues: lytDirIssues },
  });

  const nearExpiry: { name: string; until: string; remaining: string }[] = [];
  const expired: { name: string; until: string }[] = [];
  for (const v of active) {
    if (!existsSync(v.path)) continue;
    const state = readFrozenLock(v.path);
    if (!state.frozen) continue;
    if (state.expired) {
      expired.push({ name: v.name, until: state.frozenUntil ?? "" });
      continue;
    }
    if (isNearExpiry(state)) {
      nearExpiry.push({
        name: v.name,
        until: state.frozenUntil ?? "",
        remaining: state.remaining ?? "?",
      });
    }
  }
  if (nearExpiry.length > 0 || expired.length > 0) {
    out.push({
      id: "vaults.frozen-near-expiry",
      group: "vaults",
      label: "frozen vaults near expiry",
      status: "warn",
      message:
        nearExpiry.length > 0 && expired.length > 0
          ? `${nearExpiry.length} near expiry, ${expired.length} expired (next mutation auto-unfreezes)`
          : nearExpiry.length > 0
            ? `${nearExpiry.length} vault(s) within 24h of frozen_until`
            : `${expired.length} vault(s) past frozen_until (next mutation auto-unfreezes)`,
      remediation:
        nearExpiry.length > 0
          ? `Run: lyt vault unfreeze <name> (e.g. ${nearExpiry[0]!.name})`
          : undefined,
      detail: { nearExpiry, expired },
    });
  }

  return out;
}

// Block-A.3 Commit 11 — surface roles + region so doctor handles them as
// part of the first-line diagnostic output. machine_state ships in 001-init
// per arc §7. Region is handler-declared per arc §7.10; unset = info, not
// warn (every fresh install is unset until the handler runs
// `lyt machine config region <r>`).
async function checkMachineState(): Promise<CheckResult> {
  const home = getLytHome();
  const dbPath = join(home, "registry.db");
  if (!existsSync(dbPath)) {
    return {
      id: "machine.state",
      group: "machine",
      label: "machine roles + region",
      status: "info",
      message: "no registry yet (machine_state will be seeded on first vault init)",
    };
  }
  try {
    const state = await readMachineState();
    return {
      id: "machine.state",
      group: "machine",
      label: "machine roles + region",
      status: "pass",
      message: `roles=[${state.roles.join(",")}]; region=${state.region.length === 0 ? "(unset)" : state.region}`,
    };
  } catch (err) {
    return {
      id: "machine.state",
      group: "machine",
      label: "machine roles + region",
      status: "warn",
      message: `machine_state read failed: ${(err as Error).message}`,
    };
  }
}

function checkSettingsJson(repoCwd: string): CheckResult {
  const settingsPath = join(repoCwd, ".claude", "settings.json");
  const exists = existsSync(settingsPath) && statSync(settingsPath).isFile();
  return {
    id: "claude.settings",
    group: "settings",
    label: "<repo>/.claude/settings.json",
    status: "info",
    message: exists
      ? `found at ${settingsPath}`
      : `not found at ${settingsPath} (optional — see 'lyt help settings')`,
  };
}

export function renderHumanReport(result: DoctorResult): string {
  const groups = new Map<string, CheckResult[]>();
  for (const c of result.checks) {
    const bucket = groups.get(c.group) ?? [];
    bucket.push(c);
    groups.set(c.group, bucket);
  }
  const lines: string[] = [];
  lines.push("lyt doctor");
  lines.push("");
  for (const [group, checks] of groups.entries()) {
    lines.push(`${group}:`);
    for (const c of checks) {
      const marker = statusMarker(c.status);
      lines.push(`  ${marker} ${c.label}: ${c.message}`);
      if (c.remediation) {
        lines.push(`      → ${c.remediation}`);
      }
    }
    lines.push("");
  }
  lines.push(
    `summary: ${result.summary.passes} pass | ${result.summary.warnings} warn | ${result.summary.failures} fail`,
  );
  return lines.join("\n");
}

function statusMarker(s: CheckStatus): string {
  switch (s) {
    case "pass":
      return "✓";
    case "warn":
      return "⚠";
    case "fail":
      return "✗";
    case "info":
      return "i";
  }
}

// Re-exported so tests can stat sample directories without round-tripping
// through fs in the test fixture.
export function _listForTests(dir: string): string[] {
  return readdirSync(dir);
}

// v1.B.5 — federation_state ↔ ~/lyt/pod/ symmetry probe.
//
// the pod dir is FLAT — a single `~/lyt/pod/` holds `pod.yon`
// directly (no per-handle subdir). The disk side is therefore the presence of
// `~/lyt/pod/pod.yon` (renamed it from federation.yon), NOT a set of
// per-handle subdirectories. v1 is
// single-pod / single-handle, so the symmetry is binary: a `federation_state`
// row (any handle) should agree with the materialised pod on disk. Drift:
// - The handler ran `lyt federation init` on machine A, then copied the
// ~/lyt/ tree to machine B but skipped registry.db (orphan dir).
// - The registry was rebuilt from scratch but the pod dir was deleted
// manually (orphan row).
//
// SEE ALSO federation-paths.ts getFederationRoot / getFederationRepoDir —
// both this probe and the path chokepoint now compute the same FLAT root.
//
// Outcome:
// - 0 rows + no pod on disk → info ("no federation yet")
// - rows present + pod on disk → pass
// - rows present + no pod on disk → warn (orphan row → re-forge)
// - 0 rows + pod on disk → warn (orphan dir → rebuild)
export async function checkFederationRepoState(db: Client): Promise<CheckResult> {
  // WS3 + route through the federation-paths chokepoint so the
  // dir ("pod", flat) can never drift from getFederationRepoDir /
  // getFederationYonPath. Disk presence = the flat pod's pod.yon.
  const fedRoot = getFederationRoot();
  const fedYonPath = join(fedRoot, "pod.yon");
  const rows = await listFederationStates(db);
  const rowHandles = rows.map((r) => slugifyHandle(r.handle));
  const podOnDisk = existsSync(fedYonPath);

  if (rows.length === 0 && !podOnDisk) {
    return {
      id: "federation.repo-state",
      group: "federation",
      label: "federation_state ↔ disk symmetry",
      status: "info",
      message: "no federation yet (run `lyt federation init` or `lyt init`)",
    };
  }

  // Orphan row: a federation_state row exists but the flat pod was never
  // materialised (or was deleted) on this machine.
  if (rows.length > 0 && !podOnDisk) {
    return {
      id: "federation.repo-state",
      group: "federation",
      label: "federation_state ↔ disk symmetry",
      status: "warn",
      message: `${rows.length} orphan row(s)`,
      remediation: "Run: lyt federation init (re-forges the missing repo)",
      detail: { orphanRows: rowHandles, orphanDirs: [] },
    };
  }

  // Orphan dir: the flat pod exists on disk but no federation_state row
  // points at it (registry rebuilt from scratch / copied tree).
  if (rows.length === 0 && podOnDisk) {
    return {
      id: "federation.repo-state",
      group: "federation",
      label: "federation_state ↔ disk symmetry",
      status: "warn",
      message: `1 orphan dir(s)`,
      remediation: "Run: lyt federation rebuild (re-syncs the orphan directory)",
      detail: { orphanRows: [], orphanDirs: [fedRoot] },
    };
  }

  // Both present → symmetric.
  return {
    id: "federation.repo-state",
    group: "federation",
    label: "federation_state ↔ disk symmetry",
    status: "pass",
    message: `${rows.length} handle(s) registered; pod present`,
  };
}

// v1.B.5 — per-mesh `parseMeshYon` probe. Iterates every registered mesh;
// resolves its main vault path; attempts to read + parse `.lyt/mesh.yon`.
//
// Per one CheckResult row per mesh — gives precise remediation
// guidance ("rebuild THIS mesh's registry") rather than an aggregate.
//
// Status mapping:
// - Mesh has no main_vault_rid (structural invariant violation per
// v1.B.1) → warn
// - Main vault rid resolves to no vault row → warn (orphaned main)
// - Main vault dir absent on disk → warn (mesh dir removed)
// - `.lyt/mesh.yon` absent under existing main vault → warn (rebuild from SoT)
// - `parseMeshYon` throws → fail (corruption; rebuild-registry --mesh <name>)
// - parse succeeds → pass
export async function checkMeshYonParses(db: Client): Promise<CheckResult[]> {
  const meshes = await listMeshes(db);
  if (meshes.length === 0) {
    return [
      {
        id: "mesh.yon.parses",
        group: "mesh",
        label: "every mesh.yon parses",
        status: "info",
        message: "no meshes registered yet",
      },
    ];
  }

  const out: CheckResult[] = [];
  for (const m of meshes) {
    const id = `mesh.yon.parses:${m.name}`;
    const label = `mesh.yon parses (${m.name})`;
    if (m.mainVaultRid === null) {
      out.push({
        id,
        group: "mesh",
        label,
        status: "warn",
        message: `mesh '${m.name}' has no main_vault_rid (structural invariant)`,
        remediation: `Run: lyt repair --apply (heals the adopt mesh-link drift)`,
      });
      continue;
    }
    const vault = await getVaultByRid(db, m.mainVaultRid);
    if (vault === null) {
      out.push({
        id,
        group: "mesh",
        label,
        status: "warn",
        message: `mesh '${m.name}' main_vault_rid points at no vault row`,
        remediation: `Run: lyt mesh rebuild-registry --mesh ${m.name}`,
      });
      continue;
    }
    if (!existsSync(vault.path)) {
      out.push({
        id,
        group: "mesh",
        label,
        status: "warn",
        message: `mesh '${m.name}' main vault dir missing: ${vault.path}`,
        remediation: `Run: lyt vault reconnect ${vault.name} --path <new>`,
      });
      continue;
    }
    const meshYonPath = join(vault.path, ".lyt", "mesh.yon");
    if (!existsSync(meshYonPath)) {
      out.push({
        id,
        group: "mesh",
        label,
        status: "warn",
        message: `mesh '${m.name}' main vault is missing .lyt/mesh.yon`,
        remediation: `Run: lyt mesh rebuild-registry`,
      });
      continue;
    }
    try {
      const content = readFileSync(meshYonPath, "utf8");
      parseMeshYon(content);
      out.push({
        id,
        group: "mesh",
        label,
        status: "pass",
        message: `mesh '${m.name}' mesh.yon parses cleanly`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      out.push({
        id,
        group: "mesh",
        label,
        status: "fail",
        message: `mesh '${m.name}' mesh.yon parse failed: ${msg}`,
        remediation: `Run: lyt mesh rebuild-registry --mesh ${m.name}`,
        detail: { meshYonPath },
      });
    }
  }
  return out;
}

// v1.B.5 — ledger YON ↔ DB pair sanity probe. Fast sanity probe
// reading only the most-recent month's ledger. Cross-month integrity (every
// archived YON has matching DB rows) is a slower probe deferred to v1.B.6d.
//
// Per active vault, the check verifies the current open ledger and its DB
// cache are both present + agreeing. If only one side exists → warn with
// remediation `lyt vault rebuild-index <name>`. The actual on-disk layout
// is `<vault>/.lyt/ledgers/<name>.yon` (the SoT) + `<vault>/.lyt/indexes/
// <name>.db` (the cache) per the v1.A.2c DB SPLIT.
export async function checkLedgersYonDbPairs(
  db: Client,
  opts: { sampleLimit: number; full: boolean },
): Promise<CheckResult[]> {
  const vaults = await listVaults(db);
  const active = vaults.filter((v) => v.status === "active");
  if (active.length === 0) {
    return [
      {
        id: "ledgers.yon-db-pairs",
        group: "vaults",
        label: "ledger YON + DB pairs in sync (most-recent month)",
        status: "info",
        message: "no active vaults yet",
      },
    ];
  }
  const subjects = opts.full ? active : active.slice(0, opts.sampleLimit);
  const LEDGERS = ["audit", "provenance"] as const;
  const out: CheckResult[] = [];
  for (const v of subjects) {
    const id = `ledgers.yon-db-pairs:${v.name}`;
    const label = opts.full ? `ledgers (${v.name})` : `ledgers sample (${v.name})`;
    if (!existsSync(v.path)) {
      // checkRegistry already surfaces orphan vaults with full remediation;
      // skip the duplicate warning here.
      out.push({
        id,
        group: "vaults",
        label,
        status: "info",
        message: `vault dir missing — see registry.orphans`,
      });
      continue;
    }
    // V-C-1 Phase D (L4). Two genuine drift directions — and one FALSE POSITIVE
    // a fresh `lyt init` pod always tripped: initVaultDbs creates the empty
    // audit.db + provenance.db caches, but no ledger event has fired yet, so
    // there is no `.lyt/ledgers/*.yon` SoT. An EMPTY cache (0 rows) with no SoT
    // is a never-written ledger — both sides empty = IN SYNC, not drift. Only
    // flag the cache-has-rows-but-SoT-missing case (the SoT actually went away).
    const issues: { ledger: string; reason: string; dir: "cache-lost" | "sot-lost" }[] = [];
    for (const ledger of LEDGERS) {
      const yonPath = join(v.path, ".lyt", "ledgers", `${ledger}.yon`);
      const dbPath = join(v.path, ".lyt", "indexes", `${ledger}.db`);
      const yon = existsSync(yonPath);
      const dbf = existsSync(dbPath);
      if (yon && !dbf) {
        // SoT present, cache gone → re-injectable from YON (non-destructive).
        issues.push({ ledger, reason: "YON SoT present but DB cache missing", dir: "cache-lost" });
      } else if (!yon && dbf) {
        const rows = await countLedgerRows(v.path, ledger);
        if (rows > 0) {
          // Cache holds rows the (deleted) SoT can't back — a real SoT loss.
          issues.push({
            ledger,
            reason: `DB cache has ${rows} row(s) but YON SoT missing`,
            dir: "sot-lost",
          });
        }
        // rows === 0 → fresh/empty ledger; both sides empty → in sync (no issue).
      }
    }
    if (issues.length === 0) {
      out.push({
        id,
        group: "vaults",
        label,
        status: "pass",
        message: `${v.name}: audit + provenance YON/DB pairs in sync`,
      });
    } else {
      out.push({
        id,
        group: "vaults",
        label,
        status: "warn",
        message: `${v.name}: ${issues.length} ledger pair(s) out of sync`,
        // V-C-1 Phase D (L4) — DROP the misnamed/destructive bare
        // `lyt vault rebuild-index <name>` (Track-A C4: full schema drop+recreate
        // that discards libSQL-only provenance/audit rows). Recommend the
        // SURGICAL, NON-destructive per-ledger heal instead — and for a lost SoT
        // (the cache is the only copy), point at restoring the committed YON from
        // git rather than a rebuild that would wipe it. NOT `lyt reindex` here:
        // reindex rebuilds the CONTENT tiers (lanes/arcs/fts/rollup), it does not
        // touch the audit/provenance ledger caches this check is about.
        remediation: ledgerRemediation(v.name, v.path, issues),
        detail: { issues },
      });
    }
  }
  return out;
}

// V-C-1 Phase D (L4) — count rows in a per-vault ledger cache so doctor can tell
// a FRESH/empty ledger (0 rows, no SoT — in sync) apart from a real SoT loss
// (rows present, SoT gone). Best-effort: any open/query failure returns 0, which
// errs toward NOT flagging — a doctor check must never crash or false-alarm.
async function countLedgerRows(vaultPath: string, ledger: "audit" | "provenance"): Promise<number> {
  const table = ledger === "audit" ? "audit_log" : "provenance";
  let db: Client | null = null;
  try {
    db = ledger === "audit" ? await openAuditDb(vaultPath) : await openProvenanceDb(vaultPath);
    const r = await db.execute(`SELECT COUNT(*) AS n FROM ${table}`);
    return Number((r.rows[0]?.["n"] as number | bigint | undefined) ?? 0);
  } catch {
    return 0;
  } finally {
    if (db !== null) await closeVaultDb(db);
  }
}

// V-C-1 Phase D (L4) — direction-aware, NON-destructive ledger remedy. Replaces
// the bare destructive `lyt vault rebuild-index <name>`:
// • cache-lost (YON SoT present, DB cache gone) → surgical per-ledger re-inject
// from the YON SoT: `lyt vault rebuild-index <name> --ledger <ledger>`.
// • sot-lost (DB cache has rows, YON SoT gone) → the SoT is the durable record
// and is committed to git; restore it (the rebuild would WIPE the cache that
// holds the only copy), then re-inject.
export function ledgerRemediation(
  vaultName: string,
  vaultPath: string,
  issues: readonly { ledger: string; dir: "cache-lost" | "sot-lost" }[],
): string {
  const parts: string[] = [];
  const cacheLost = issues.filter((i) => i.dir === "cache-lost").map((i) => i.ledger);
  const sotLost = issues.filter((i) => i.dir === "sot-lost").map((i) => i.ledger);
  for (const ledger of cacheLost) {
    parts.push(`lyt vault rebuild-index ${vaultName} --ledger ${ledger}`);
  }
  if (sotLost.length > 0) {
    parts.push(
      `restore the committed YON SoT (cd ${vaultPath} && git restore .lyt/ledgers/), or \`lyt sync\`, ` +
        `then: ${sotLost.map((l) => `lyt vault rebuild-index ${vaultName} --ledger ${l}`).join("; ")}`,
    );
  }
  return `Run: ${parts.join("  |  ")}`;
}

// v1.B.5 — `★ {mesh}/main` marker render probe. Sample meshes via
// `listMeshes`; for each, verify `meshes.main_vault_rid IS NOT NULL` AND
// `getVaultByName(db, '<mesh>/main') !== null`. If both hold the visual
// marker in `lyt vault list` + `lyt mesh list` renders correctly; otherwise
// it silently disappears — a `warn`-shaped data-shape regression caught
// here before the user notices.
export async function checkMarkersRender(
  db: Client,
  opts: { sampleLimit: number },
): Promise<CheckResult[]> {
  const meshes = await listMeshes(db);
  if (meshes.length === 0) {
    return [
      {
        id: "markers.render",
        group: "mesh",
        label: "★ main-vault markers render",
        status: "info",
        message: "no meshes registered yet",
      },
    ];
  }
  // Default limit 3 per brief OD §8; opts.sampleLimit honours the existing
  // doctor knob when callers tune it.
  const limit = Math.min(opts.sampleLimit, meshes.length);
  const subjects = meshes.slice(0, limit);
  const out: CheckResult[] = [];
  for (const m of subjects) {
    const id = `markers.render:${m.name}`;
    const label = `★ marker (${m.name}/main)`;
    if (m.mainVaultRid === null) {
      out.push({
        id,
        group: "mesh",
        label,
        status: "warn",
        message: `mesh '${m.name}' has no main_vault_rid; ★ won't render`,
        remediation: `Run: lyt repair --apply (heals the adopt mesh-link drift)`,
      });
      continue;
    }
    const expected = `${m.name}/main`;
    const mainByName = await getVaultByName(db, expected);
    if (mainByName === null) {
      out.push({
        id,
        group: "mesh",
        label,
        status: "warn",
        message: `expected vault '${expected}' not found; ★ won't render for ${m.name}`,
        remediation: `Run: lyt mesh rebuild-registry`,
      });
      continue;
    }
    out.push({
      id,
      group: "mesh",
      label,
      status: "pass",
      message: `★ ${expected} will render`,
    });
  }
  return out;
}


// Fed-v2 Slice 1b (#13 DELETE) — DEFAULT_PUBLIC_MESH_HYGIENE_PATTERNS,
// PublicMeshHygieneOptions, and checkPublicMeshHygiene removed.
// The @MESH_PUBLIC surface they guarded no longer exists.


// ---------------------------------------------------------------------------
// hardening fix-pass (2026-06-10) — index-tier + registry-shape
// checks. Historically doctor NEVER opened a per-vault lyt.db ("22 doctor
// passes on a corrupt db" — F15 — persisted at the doctor level as hardening pass);
// only `lyt reindex` carried the heal. These checks make doctor the canary:
// detect-only (the heal stays with `lyt reindex` / `lyt repair --apply`).
// ---------------------------------------------------------------------------

// hardening pass (a): per-vault lyt.db openable + integrity (read-only quick_check via
// isLytDbCorrupt — no migrations, safe on frozen vaults), and (b) behavioral
// FTS smoke: a vault with figments on disk must have an index that is neither
// EMPTY nor fully divergent (zero on-disk figments indexed). Deliberately
// conservative: ONE freshly-written-not-yet-indexed figment never warns (L3 /
// sync legitimately heal that window); a dead index tier does.
async function checkVaultIndexHealth(
  db: Client,
  opts: { sampleLimit: number; full: boolean },
): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const active = (await listVaults(db)).filter((v) => v.status === "active" && existsSync(v.path));
  const subjects = opts.full ? active : active.slice(0, opts.sampleLimit);
  const sampleLabel = opts.full
    ? `all ${active.length}`
    : `sample ${subjects.length}/${active.length}`;

  const corrupt: { name: string; path: string }[] = [];
  const probeErrors: { name: string; reason: string }[] = [];
  for (const v of subjects) {
    try {
      if (await isLytDbCorrupt(v.path)) corrupt.push({ name: v.name, path: v.path });
    } catch (err) {
      probeErrors.push({ name: v.name, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  out.push({
    id: "vaults.index-db-integrity",
    group: "vaults",
    label: `per-vault lyt.db openable + integrity (${sampleLabel})`,
    status: corrupt.length > 0 ? "fail" : probeErrors.length > 0 ? "warn" : "pass",
    message:
      corrupt.length > 0
        ? `${corrupt.length} vault(s) have a CORRUPT search index (.lyt/indexes/lyt.db): ${corrupt.map((c) => c.name).join(", ")} — search/recall/primer are dead for them`
        : probeErrors.length > 0
          ? `${probeErrors.length} vault(s) could not be probed`
          : `${subjects.length} sampled vault index db(s) open + quick_check ok`,
    remediation:
      corrupt.length > 0
        ? `Run: ${corrupt.map((c) => `lyt reindex --vault '${c.name}'`).join(" ; ")} — quarantines the corrupt lyt.db aside and rebuilds it from the vault's markdown (or: lyt repair --apply)`
        : undefined,
    detail: corrupt.length > 0 || probeErrors.length > 0 ? { corrupt, probeErrors } : undefined,
  });

  // Behavioral smoke — skip vaults already flagged corrupt (covered above).
  const corruptNames = new Set(corrupt.map((c) => c.name));
  const smokeIssues: { name: string; reason: string }[] = [];
  let smoked = 0;
  for (const v of subjects) {
    if (corruptNames.has(v.name)) continue;
    if (!existsSync(getLytDbPath(v.path))) continue; // never indexed — not a divergence
    const figments = listDiskFigments(v.path, 200);
    if (figments.length === 0) continue; // nothing to find — vacuously healthy
    smoked++;
    let indexed: Set<string>;
    try {
      indexed = await readIndexedFigmentPaths(v.path, 500);
    } catch (err) {
      smokeIssues.push({
        name: v.name,
        reason: `FTS read failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    if (indexed.size === 0) {
      smokeIssues.push({
        name: v.name,
        reason: `index is EMPTY though the vault has ${figments.length} figment(s) on disk — search misses everything`,
      });
    } else if (!figments.some((f) => indexed.has(f))) {
      smokeIssues.push({
        name: v.name,
        reason: "index is fully divergent — no on-disk figment is indexed",
      });
    }
  }
  out.push({
    id: "vaults.index-fts-smoke",
    group: "vaults",
    label: `FTS index reflects on-disk figments (${sampleLabel})`,
    status: smokeIssues.length > 0 ? "warn" : "pass",
    message:
      smokeIssues.length > 0
        ? `${smokeIssues.length} vault(s) have a stale/dead FTS index: ${smokeIssues.map((i) => i.name).join(", ")}`
        : `${smoked} vault(s) smoked; known figments FTS-hit`,
    remediation:
      smokeIssues.length > 0
        ? `Run: ${smokeIssues.map((i) => `lyt reindex --vault '${i.name}'`).join(" ; ")}`
        : undefined,
    detail: smokeIssues.length > 0 ? { issues: smokeIssues } : undefined,
  });

  // Phase C (UNIT 4 / SC4) — README present-from-birth, init-once v1. doctor
  // WARNS when a vault's README is missing but does NOT auto-recreate
  // (surface-don't-act; the git-tombstone primitive that would distinguish a
  // deliberate delete is deferred). A present-but-marker-less README is fine
  // (hand-authored READMEs are respected) — only a MISSING README warns.
  const missingReadme: string[] = [];
  for (const v of subjects) {
    if (!checkReadmePresent(v.path).present) missingReadme.push(v.name);
  }
  out.push({
    id: "vaults.readme-present",
    group: "vaults",
    label: `vault README present (${sampleLabel})`,
    status: missingReadme.length > 0 ? "warn" : "pass",
    message:
      missingReadme.length > 0
        ? `${missingReadme.length} vault(s) are missing README.md: ${missingReadme.join(", ")} — Lyt does not auto-recreate it (init-once v1)`
        : `${subjects.length} sampled vault(s) have a README.md`,
    remediation:
      missingReadme.length > 0
        ? `If the README was deleted by mistake, restore it from git (e.g. cd <vault> && git checkout README.md), or re-run scaffold conformance (lyt vault adopt / clone re-applies it)`
        : undefined,
    detail: missingReadme.length > 0 ? { missingReadme } : undefined,
  });

  // Phase D (SC6) — audience-split location. Surface vaults that still carry the
  // agent-priming files (agents.md / lyt-overview.md) at the LEGACY vault root.
  // Detect-only (the heal lives in `lyt repair --apply`, snapshot-first per the
  // pod's diagnose/fix verb split). A vault already under `.lyt/` passes.
  const legacyAgentVaults: { name: string; files: string[] }[] = [];
  for (const v of subjects) {
    const legacy = findLegacyAgentFiles(v.path);
    if (legacy.length > 0) {
      legacyAgentVaults.push({ name: v.name, files: legacy.map((l) => l.filename) });
    }
  }
  out.push({
    id: "vaults.agent-files-location",
    group: "vaults",
    label: `agent-priming files under .lyt/ (${sampleLabel})`,
    status: legacyAgentVaults.length > 0 ? "warn" : "pass",
    message:
      legacyAgentVaults.length > 0
        ? `${legacyAgentVaults.length} vault(s) still keep agents.md/lyt-overview.md at the vault root: ${legacyAgentVaults.map((v) => v.name).join(", ")} — Lyt relocates them under .lyt/`
        : `${subjects.length} sampled vault(s) keep agent-priming files under .lyt/ (or have none)`,
    remediation:
      legacyAgentVaults.length > 0
        ? `Run: lyt repair --apply (snapshots each vault, then moves agents.md/lyt-overview.md into .lyt/; idempotent)`
        : undefined,
    detail: legacyAgentVaults.length > 0 ? { legacyAgentVaults } : undefined,
  });

  return out;
}

// F8 defense-in-depth (Wave-3 logged; folded into the hardening pass/08 pass): two
// registered vaults sharing one git origin means both push to the same repo —
// the clone-without-detach hazard the a review finding detach-by-intent fix manages at
// clone time. Doctor surfaces any survivors.
async function checkDuplicateOrigins(db: Client): Promise<CheckResult> {
  const active = (await listVaults(db)).filter((v) => v.status === "active" && existsSync(v.path));
  const byOrigin = new Map<string, string[]>();
  for (const v of active) {
    const url = readGitRemoteOriginUrl(v.path);
    if (url === null || url.length === 0) continue;
    const list = byOrigin.get(url) ?? [];
    list.push(v.name);
    byOrigin.set(url, list);
  }
  const dups = [...byOrigin.entries()].filter(([, names]) => names.length > 1);
  return {
    id: "vaults.duplicate-origin",
    group: "vaults",
    label: "no two vaults share a git origin",
    status: dups.length === 0 ? "pass" : "warn",
    message:
      dups.length === 0
        ? `${active.length} active vault(s); all origins distinct`
        : dups
            .map(
              ([url, names]) => `${names.join(" + ")} share origin ${url} — their pushes collide`,
            )
            .join("; "),
    remediation:
      dups.length === 0
        ? undefined
        : "If one is a local working copy, detach its origin (git remote remove origin) or re-clone it via 'lyt vault clone --to-mesh' (detaches by default).",
    detail:
      dups.length === 0
        ? undefined
        : { duplicates: dups.map(([url, names]) => ({ url, vaults: names })) },
  };
}

// repair detects orphan vaults (exit non-zero) while doctor said
// exit 0 — the pod's two health verbs disagreed about whether an orphan is a
// finding. Doctor now warns with repair's own remediation.
async function checkOrphanVaults(db: Client): Promise<CheckResult> {
  const orphans = (await listVaults(db)).filter(
    (v) => v.status === "active" && v.homeMeshRid === null,
  );
  return {
    id: "registry.orphan-vaults",
    group: "registry",
    label: "every active vault has a home mesh",
    status: orphans.length === 0 ? "pass" : "warn",
    message:
      orphans.length === 0
        ? "no orphan vaults"
        : `${orphans.length} orphan vault(s) with no home mesh: ${orphans.map((o) => o.name).join(", ")}`,
    remediation:
      orphans.length === 0
        ? undefined
        : `Run: lyt repair --target <vault-rid> --apply --mesh <mesh> (re-attaches the vault; see 'lyt repair --json' for rids)`,
    detail:
      orphans.length === 0
        ? undefined
        : { orphans: orphans.map((o) => ({ name: o.name, rid: o.ridHex })) },
  };
}

// Phase E (SC7) — GitHub repo-topic drift. For each active vault with a parseable
// git origin, compute the DESIRED brand-grade topic floor for its repo CLASS
// (public-vault when the vault's per-vault pod.yon visibility === "public", else
// vault) UNIONed with the vault's own extra topics, and compare it to the topics
// actually on GitHub. A repo MISSING any brand topic is drift → warn, with the
// conformance fix (`lyt sync-metadata --vault <name> --apply`, which re-asserts
// the brand set as a union, never clobbering user extras). Detect-only here; the
// heal lives in sync-metadata.
//
// gh-graceful: when gh is not authed the check is `info` (skipped) — Lyt is
// usable offline and doctor must never FAIL on an offline box. Per-repo gh-api
// failures (rate-limit, 404, no-admin) are surfaced as a per-vault probe error,
// not a brand-drift warning, so a transient gh hiccup never masquerades as drift.
export async function checkTopicConformance(
  db: Client,
  opts: { ghClient: GhClient; ghAuthed: boolean; sampleLimit: number; full: boolean },
): Promise<CheckResult> {
  const id = "github.topic-conformance";
  const group = "github";
  const label = "GitHub repo topics match the brand set";

  if (!opts.ghAuthed) {
    return {
      id,
      group,
      label,
      status: "info",
      message: "skipped (gh not authed — run `gh auth login` to check topic drift)",
    };
  }

  const active = (await listVaults(db)).filter((v) => v.status === "active" && existsSync(v.path));
  if (active.length === 0) {
    return { id, group, label, status: "info", message: "no active vaults to check" };
  }

  // LOCKED `lyt-public` trigger — public vault names from the pod.yon SoT.
  // Shared resolver (yon/federation-read.ts), identical to the sync-metadata path.
  const publicVaultNames = await resolvePublicVaultNames(db);

  const subjects = opts.full ? active : active.slice(0, opts.sampleLimit);
  const sampleLabel = opts.full
    ? `all ${active.length}`
    : `sample ${subjects.length}/${active.length}`;

  const drift: { name: string; missing: string[] }[] = [];
  const probeErrors: { name: string; reason: string }[] = [];

  for (const v of subjects) {
    const yonPath = join(v.path, ".lyt", "vault.yon");
    let gitUrl: string | null = v.gitUrl;
    if (!gitUrl && existsSync(yonPath)) {
      try {
        gitUrl = parseVaultYon(readFileSync(yonPath, "utf8")).gitUrl;
      } catch {
        // unparseable vault.yon — fall through; no remote resolved
      }
    }
    if (!gitUrl) continue; // no remote → nothing to conform on GitHub

    const ownerRepo = parseOwnerRepoFromUrl(gitUrl);
    if (!ownerRepo) continue;

    const repoClass = publicVaultNames.has(v.name) ? "public-vault" : "vault";
    // Drift = any BRAND topic absent on GitHub. We only flag MISSING brand
    // topics (union-not-clobber: extra topics on GitHub are never drift). The
    // vault's own extra topics are merged by the CONFORMANCE fix (sync-metadata),
    // not part of the drift floor checked here.
    const brandFloor = baseTopicsForClass(repoClass);

    let info;
    try {
      info = await opts.ghClient.getRepo(ownerRepo.owner, ownerRepo.repo);
    } catch (err) {
      probeErrors.push({
        name: v.name,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const have = new Set(info.topics.map((t) => t.trim().toLowerCase()));
    const missing = brandFloor.filter((t) => !have.has(t));
    if (missing.length > 0) {
      drift.push({ name: v.name, missing });
    }
  }

  if (drift.length > 0) {
    return {
      id,
      group,
      label: `${label} (${sampleLabel})`,
      status: "warn",
      message: `${drift.length} vault repo(s) have drifted GitHub topics (missing brand topic[s]): ${drift
        .map((d) => `${d.name} [${d.missing.join(", ")}]`)
        .join("; ")}`,
      remediation: `Run: ${drift
        .map((d) => `lyt sync-metadata --vault '${d.name}' --apply`)
        .join(" ; ")} — re-asserts the brand set as a UNION (your extra topics are preserved)`,
      detail: { drift, probeErrors: probeErrors.length > 0 ? probeErrors : undefined },
    };
  }

  if (probeErrors.length > 0) {
    return {
      id,
      group,
      label: `${label} (${sampleLabel})`,
      status: "warn",
      message: `${probeErrors.length} vault repo(s) could not be probed for topic drift: ${probeErrors
        .map((p) => p.name)
        .join(", ")}`,
      detail: { probeErrors },
    };
  }

  return {
    id,
    group,
    label: `${label} (${sampleLabel})`,
    status: "pass",
    message: `${subjects.length} probed vault repo(s) carry the brand topic set`,
  };
}

// On-disk figment relpaths (vault-relative POSIX), capped to `cap` entries so
// the doctor diff only SAMPLES a bounded window of figments (paired with the
// indexed-paths cap in readIndexedFigmentPaths). B-4: rooted at the VAULT ROOT
// (not notes/) via the shared `walkVaultMarkdownFiles` + `isIndexable` — the SAME
// key shape + inclusion set upsertFtsCache now writes (floor + scaffold +
// size/binary gates uniform). The output prefix is the actual vault-relative
// POSIX path (e.g. `identity/me.md`), no longer a hardcoded `notes/` prefix.
// NOTE: the shared walker enumerates the FULL tree first; the `cap` only bounds
// the RETURNED sample, not the walk itself (the walker has no early-exit hook).
// For a doctor sample this is acceptable — the walk is the same one a reindex
// performs; if it ever becomes a hot path, push the cap into the walker.
function listDiskFigments(vaultPath: string, cap: number): string[] {
  const abs = walkVaultMarkdownFiles(vaultPath, isIndexable);
  const out: string[] = [];
  for (const p of abs) {
    if (out.length >= cap) break;
    out.push(relative(vaultPath, p).split(sep).join(posixPath.sep));
  }
  return out;
}

// Read up to `cap` indexed figment keys from figment_fts via a RAW client
// (no migrations — doctor must not write). A missing figment_fts table reads
// as an empty index (pre-FTS schema = nothing indexed).
// ORDER BY figment_rid (release review): listDiskFigments walks
// lexicographically, so ordering the indexed sample the same way guarantees
// the two samples overlap on an in-sync vault regardless of size — without
// it, a >cap vault indexed in capture order could sample disjoint windows
// and false-warn "fully divergent". The caps (200 disk / 500 indexed) are a
// coupled pair: indexed cap must stay >= disk cap.
async function readIndexedFigmentPaths(vaultPath: string, cap: number): Promise<Set<string>> {
  const raw = createClient({ url: `file:${getLytDbPath(vaultPath)}` });
  try {
    const r = await raw.execute({
      sql: "SELECT figment_rid FROM figment_fts ORDER BY figment_rid LIMIT ?",
      args: [cap],
    });
    return new Set(r.rows.map((row) => String(row["figment_rid"])));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such table/i.test(msg)) return new Set();
    if (isCorruptDatabaseError(err)) return new Set();
    throw err;
  } finally {
    await closeVaultDb(raw);
  }
}
