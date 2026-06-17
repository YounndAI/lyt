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

// V-C-1 (Lane V Track C) — index-on-write (L1), the core save→find loop fix.
//
// THE BUG THIS CLOSES: every capture path wrote the figment markdown but
// indexed NOTHING, so `lyt search` / `recall` / `primer` returned empty until
// a manual `lyt reindex` that nothing told the user to run. The per-figment
// FTS reconcile (reconcile-figment-write.ts) existed but was wired ONLY to the
// event-driven watcher (sync-watch.ts) — and the watcher daemon is deferred for
// alpha (brief §1 "Deferred"), so in normal CLI use nothing ever fired it.
//
// THE FIX: a single index-on-write seam every capture path calls right after
// writing the figment. It does the cheap incremental FTS upsert (the SC1
// save→find path) PLUS a per-vault lanes/arcs rebuild (the SC3 keyword/primer
// path — keywords derive from lanes, lanes from a cross-figment tag cluster, so
// there is no per-figment lane primitive; the captured vault is re-clustered).
//
// SCOPE BOUNDARY (brief §1 + A0 GO call): only the captured VAULT is
// re-indexed — never the pod. The heaviest CROSS-vault aggregate (rollup) is
// deliberately deferred to `lyt reindex` / `lyt sync` (brief §1: "Only the
// heaviest cross-figment aggregates … MAY defer"). This is "patch-the-trigger,
// not re-architect-the-cache" (brief §0.5): an O(figments-in-vault) re-cluster
// per capture, acceptable at alpha scale + benched (SC8); a true incremental
// lane primitive is booked post-alpha.
//
// RESILIENCE CONTRACT ([[lyt-resilience-core-objective]] + brief Phase A):
// the figment markdown is ALWAYS already on disk before this runs (every
// caller writes the file first). This flow therefore NEVER throws to its
// caller and NEVER crashes capture — on any index failure it returns
// `deferred:true` + a soft, agent-visible note ("saved — search-index update
// deferred; run `lyt reindex`") so L3/L4 heal it later. The write is never
// lost; the cache is regenerable (Lock 0.2).

import { existsSync } from "node:fs";

import type { Client } from "@libsql/client";

import { closeRegistry, getRegistryPath, openRegistry } from "../registry/client.js";
import { getVaultByName, getVaultByPath, type VaultRow } from "../registry/repo.js";
import { readFrozenLock } from "../util/freeze-check.js";
import { writeIndexWatermark } from "../util/index-watermark.js";
import { reconcileFigmentWrite } from "./reconcile-figment-write.js";
import { rebuildLanesFlow } from "./rebuild-lanes.js";
import { rebuildArcsFlow } from "./rebuild-arcs.js";
import { deriveWriteGate } from "./writability.js";
import type { GhExecutor } from "../util/gh-discover.js";

export interface CaptureIndexArgs {
  // The figment's VAULT — supply at least one of name/path; the other is
  // resolved from the registry (path → name via getVaultByPath, name → path
  // via getVaultByName). An unregistered vault (path only, no registry row)
  // still indexes: the lane/arc rebuilds accept a path override.
  vaultName?: string | undefined;
  vaultPath?: string | undefined;
  // Vault-relative POSIX path of the figment just written (e.g.
  // "notes/2026-06-10-foo.md"). Same key shape as the FTS figment_rid.
  relPath: string;
  // Open-once seam (v1.A.5 CR-B1). Threaded to the registry resolution +
  // the lane/arc rebuilds when supplied; caller owns lifecycle.
  registryDb?: Client | undefined;
  // FTS-only mode: skip the per-vault lanes/arcs rebuild (search stays fresh,
  // primer keywords may lag). Not used by capture in v1 — reserved for a
  // future perf-sensitive caller. Default false (full SC1+SC3).
  ftsOnly?: boolean | undefined;
  // 0.9.3 — injectable gh executor for the read-only write-gate
  // (deriveWriteGate). Defaults to the real `gh` CLI; tests inject a fake.
  // Only consulted for SUBSCRIPTION targets — own-vault indexing never probes.
  gh?: GhExecutor | undefined;
}

export interface CaptureIndexResult {
  vaultName: string;
  vaultPath: string;
  relPath: string;
  // FTS + edges + figment_meta upsert succeeded (the SC1 search-freshness
  // path — what `lyt search` Tier-2 hits).
  ftsIndexed: boolean;
  // Per-vault lanes + arcs rebuilt (the SC3 keyword/primer path). False when
  // ftsOnly, or when the rebuild failed.
  keywordsIndexed: boolean;
  // True when ANY required index step failed → the markdown write is preserved
  // and healing is deferred to L3 (empty-result self-heal) / L4 (doctor) /
  // `lyt reindex`. NEVER means data loss.
  deferred: boolean;
  // Agent/user-visible soft note, present only when deferred. The CLI/skill
  // surfaces it so capture never fails silently (brief §0.5 #4).
  note?: string;
  durationMs: number;
}

// Index a freshly-written figment into its vault's content caches. See the
// file header for the full contract. Resolves the vault, runs the FTS
// reconcile (SC1) + per-vault lane/arc rebuild (SC3), stamps the index
// watermark (L3 input), and reports `deferred` instead of throwing on any
// failure.
export async function captureIndexFlow(args: CaptureIndexArgs): Promise<CaptureIndexResult> {
  const startedAt = Date.now();

  let resolved: { vaultName: string; vaultPath: string };
  try {
    resolved = await resolveVaultIdentity(args);
  } catch (err) {
    // Vault could not be resolved at all — the figment is still on disk; report
    // deferred so the caller surfaces the soft note (never throw / crash).
    return {
      vaultName: args.vaultName ?? "",
      vaultPath: args.vaultPath ?? "",
      relPath: args.relPath,
      ftsIndexed: false,
      keywordsIndexed: false,
      deferred: true,
      note: deferNote(`could not resolve vault (${errMsg(err)})`),
      durationMs: Date.now() - startedAt,
    };
  }

  const { vaultName, vaultPath } = resolved;
  const wantKeywords = args.ftsOnly !== true;

  // Track C Wave 3 F13 (+ release review) — the freeze gate at
  // patternRunFlow covers the CLI/pattern WRITE paths, but the /lyt-capture
  // skill's primary convention is inline-Write + `lyt capture --index-only`,
  // which reaches here directly: the one signal point Lyt has on that path
  // (the harness Write itself can't be intercepted). Honor this flow's
  // never-throw contract — report not-indexed with the freeze reason
  // instead of throwing. An expired freeze auto-clears via the same
  // readFrozenLock state the enforce path uses.
  const frozenState = readFrozenLock(vaultPath);
  if (frozenState.frozen && !frozenState.expired) {
    return {
      vaultName,
      vaultPath,
      relPath: args.relPath,
      ftsIndexed: false,
      keywordsIndexed: false,
      deferred: false,
      note:
        `not indexed: vault '${vaultName}' is frozen until ${frozenState.frozenUntil ?? "<unknown>"} ` +
        `(${frozenState.remaining ?? "?"}). The figment file is on disk but stays out of the index; ` +
        `run 'lyt vault unfreeze ${vaultName}' then 'lyt capture --index-only ${args.relPath} --vault ${vaultName}'.`,
      durationMs: Date.now() - startedAt,
    };
  }

  // 0.9.3 — the `--index-only` skill seam reaches here DIRECTLY (the
  // /lyt-capture skill writes the figment inline with its own Write tool, then
  // calls `lyt capture --index-only`), bypassing the patternRunFlow gate. Refuse
  // to index a figment into a vault the user CAN'T PUSH to, keyed on the LIVE
  // writability verdict (deriveWriteGate) — the role-only check missed
  // foreign-mesh subscriptions. Hot path stays probe-free: only a
  // subscription consults gh. Honor this flow's never-throw contract — surface a
  // not-indexed REFUSAL note naming the remedy (and that the file should be
  // moved/removed) rather than throwing. Detect-only when no registry exists (a
  // path-only wizard call has no mesh rows — never a subscriber).
  const subscriberNote = await subscriberRefusalNote(args, vaultName, vaultPath);
  if (subscriberNote !== null) {
    return {
      vaultName,
      vaultPath,
      relPath: args.relPath,
      ftsIndexed: false,
      keywordsIndexed: false,
      deferred: false,
      note: subscriberNote,
      durationMs: Date.now() - startedAt,
    };
  }

  // SEAM-LEVEL notes/ GUARD (release review R2 fix-pass). The FTS + lanes + arcs
  // caches scan `notes/**` ONLY (rebuild-fts/lanes/arcs), so indexing a figment
  // OUTSIDE notes/ would create an FTS row the next full rebuild / sync-pull /
  // self-heal silently DELETES — incremental-vs-full drift (a figment that
  // searches today vanishes after the next sync). pattern-run already gates its
  // own call, but the `lyt capture --index-only` skill seam reaches here with a
  // caller-supplied path; enforce the invariant at THE SEAM so BOTH callers are
  // protected. Out-of-scope path → not indexed (by design), not "deferred".
  if (!isUnderNotes(args.relPath)) {
    return {
      vaultName,
      vaultPath,
      relPath: args.relPath,
      ftsIndexed: false,
      keywordsIndexed: false,
      deferred: false,
      note: `not indexed: ${args.relPath} is outside the indexed notes/ tree (search + primer cover notes/ only).`,
      durationMs: Date.now() - startedAt,
    };
  }

  // --- SC1: incremental FTS + edges + figment_meta upsert (synchronous). ---
  let ftsIndexed = false;
  const failures: string[] = [];
  try {
    const r = await reconcileFigmentWrite(
      vaultPath,
      "upsert",
      { relPath: args.relPath },
      { await: true },
    );
    // ftsChanged is false only when the file vanished between write + reconcile
    // (or is the scaffold index.md, never a figment). Treat a real upsert as
    // indexed; a no-op (file gone) is surfaced as deferred so it heals.
    ftsIndexed = r.ftsChanged;
    if (!ftsIndexed) failures.push("FTS upsert was a no-op (file missing or not a figment)");
  } catch (err) {
    failures.push(`FTS upsert failed (${errMsg(err)})`);
  }

  // --- SC3: per-vault lanes + arcs rebuild (keyword/primer freshness). ---
  // Per-vault only (the captured vault); cross-vault rollup is deferred to
  // reindex/sync per brief §1. Passing vaultPathOverride skips a redundant
  // registry lookup inside each rebuild flow.
  let keywordsIndexed = false;
  if (wantKeywords) {
    let lanesOk = false;
    let arcsOk = false;
    try {
      await rebuildLanesFlow({
        vault: vaultName,
        vaultPathOverride: vaultPath,
        ...(args.registryDb !== undefined ? { registryDb: args.registryDb } : {}),
      });
      lanesOk = true;
    } catch (err) {
      failures.push(`lanes rebuild failed (${errMsg(err)})`);
    }
    try {
      await rebuildArcsFlow({
        vault: vaultName,
        vaultPathOverride: vaultPath,
        ...(args.registryDb !== undefined ? { registryDb: args.registryDb } : {}),
      });
      arcsOk = true;
    } catch (err) {
      failures.push(`arcs rebuild failed (${errMsg(err)})`);
    }
    keywordsIndexed = lanesOk && arcsOk;
  }

  const deferred = !ftsIndexed || (wantKeywords && !keywordsIndexed);

  // --- L3 watermark: stamp ONLY on a fully-successful index, and stamp it to
  // `startedAt` (the entry instant), NOT now (release review R2 fix-pass). Stamping
  // the START means any figment write that landed DURING this index window
  // (mtime > startedAt) stays > watermark → L3 still heals it; stamping `now`
  // would mask such an interleaved write. The figment we just indexed was
  // written by the caller BEFORE entry (mtime < startedAt), so it is correctly
  // NOT seen as stale. A deferred index leaves the watermark untouched so L3
  // reindexes this vault on the next empty search. ---
  if (!deferred) {
    writeIndexWatermark(vaultPath, startedAt);
  }

  return {
    vaultName,
    vaultPath,
    relPath: args.relPath,
    ftsIndexed,
    keywordsIndexed,
    deferred,
    ...(deferred ? { note: deferNote(failures.join("; ")) } : {}),
    durationMs: Date.now() - startedAt,
  };
}

// Resolve the vault's (name, path) from whichever was supplied. Opens the
// registry only when a lookup is actually needed.
async function resolveVaultIdentity(
  args: CaptureIndexArgs,
): Promise<{ vaultName: string; vaultPath: string }> {
  if (args.vaultName !== undefined && args.vaultPath !== undefined) {
    return { vaultName: args.vaultName, vaultPath: args.vaultPath };
  }
  if (args.vaultName === undefined && args.vaultPath === undefined) {
    throw new Error("captureIndexFlow: supply at least one of vaultName / vaultPath.");
  }

  // Isolation guard: NEVER create the registry just to resolve a name. The
  // path-only caller (the wizard first-use demo) must not touch — let alone
  // forge — the real `~/lyt/registry.db` (openRegistry mkdir+creates on open).
  // If no registry exists AND the caller gave us a path, derive the cosmetic
  // vaultName from the path (the registry isn't needed: reconcile keys on the
  // path; the lane/arc rebuilds run via vaultPathOverride). Only open the
  // registry when it already exists OR the caller threaded one through.
  const haveRegistry = args.registryDb !== undefined || existsSync(getRegistryPath());
  if (!haveRegistry) {
    if (args.vaultPath !== undefined) {
      return {
        vaultName: deriveVaultNameFromPath(args.vaultPath),
        vaultPath: args.vaultPath,
      };
    }
    throw new Error(`no registry to resolve vault name '${args.vaultName}' to a path.`);
  }

  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());
  try {
    if (args.vaultPath !== undefined) {
      // Path given — resolve the registered name (fall back to a path-derived
      // name for an unregistered vault so the lane/arc YON still records one).
      const row: VaultRow | null = await getVaultByPath(db, args.vaultPath);
      return {
        vaultName: row?.name ?? deriveVaultNameFromPath(args.vaultPath),
        vaultPath: args.vaultPath,
      };
    }
    // Name given — resolve the path (required; an unregistered name has none).
    const row = await getVaultByName(db, args.vaultName!);
    if (row === null) {
      throw new Error(`no vault registered with name '${args.vaultName}'.`);
    }
    return { vaultName: row.name, vaultPath: row.path };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}

// resolve whether the capture target is a vault the user CAN'T PUSH to and, if
// so, return the actionable refusal note (else null). 0.9.3 : keyed on
// the LIVE writability verdict (deriveWriteGate) rather than the static role —
// the role-only check missed foreign-mesh subscriptions (a subscribed vault
// gets a local `home` role, so `isPureSubscriberVault` returned false). The hot
// path stays probe-free: deriveWriteGate only probes gh for a SUBSCRIPTION; an
// own vault (no subscription signal) returns not-blocked with no network. Never
// CREATES the registry: a path-only wizard call on a machine with no registry
// has no mesh rows, so it can never be a subscriber → null (proceed).
// Best-effort: any lookup failure returns null (fail-open to the never-throw
// contract; the patternRunFlow gate is the primary, hard refusal for the CLI
// capture path).
async function subscriberRefusalNote(
  args: CaptureIndexArgs,
  vaultName: string,
  vaultPath: string,
): Promise<string | null> {
  const haveRegistry = args.registryDb !== undefined || existsSync(getRegistryPath());
  if (!haveRegistry) return null;
  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());
  try {
    const row =
      (await getVaultByPath(db, vaultPath)) ??
      (args.vaultName !== undefined ? await getVaultByName(db, args.vaultName) : null);
    if (row === null) return null; // unregistered → no mesh role → proceed
    const gate = await deriveWriteGate(row, db, args.gh !== undefined ? { gh: args.gh } : {});
    if (!gate.blocked) return null;
    if (gate.verdict.writable === "unknown") {
      return (
        `not indexed: vault '${vaultName}' is a subscribed vault and its write access couldn't be ` +
        `verified (gh offline) — treated as read-only so a capture doesn't strand a commit 'lyt sync' ` +
        `can never push. The figment file is on disk but stays out of the index — move it into one of ` +
        `your home vaults, or run 'lyt vault refresh ${vaultName}' once online and re-capture there.`
      );
    }
    return (
      `not indexed: vault '${vaultName}' is a subscribed read-only vault (you can't push to its ` +
      `upstream), so capturing into it would strand a local-only stray commit that 'lyt sync' can ` +
      `never push. The figment file is on disk but stays out of the index — move it into one of your ` +
      `home vaults (or request write access to '${vaultName}'), then re-capture there.`
    );
  } catch {
    return null;
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}

function deriveVaultNameFromPath(p: string): string {
  const parts = p.split(/[\\/]+/).filter((x) => x.length > 0);
  return parts[parts.length - 1] ?? "vault";
}

// True when a vault-relative POSIX path is inside the indexed `notes/` tree (the
// FTS + lanes + arcs caches scan `notes/**` only). The seam-level invariant that
// keeps the incremental index consistent with the full rebuild — see the guard
// in captureIndexFlow (release review R2 fix-pass).
function isUnderNotes(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/");
  return norm === "notes" || norm.startsWith("notes/");
}

function deferNote(reason: string): string {
  return `saved — search-index update deferred (${reason}); run \`lyt reindex\` to refresh, or it self-heals on next search.`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
