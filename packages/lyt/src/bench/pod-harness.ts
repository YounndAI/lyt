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

// Lane V Workstream 2 — `lyt bench` temp-pod harness.
//
// Stands up a THROWAWAY pod under os.tmpdir (never the user's ~/lyt), seeds
// vaults + figments offline (federation self-heal disabled AND a synthetic
// identity pinned → no gh, no network, no interactive prompts), reindexes all
// content tiers, and runs the cascade. Productized from
// tools/lane-v/quality-probe.mjs (which only PROBED an already-built pod); this
// also BUILDS the pod, so the bench ships self-contained.
//
// Pod safety: LYT_HOME is repointed to a fresh mkdtemp dir for the harness'
// lifetime and restored on teardown. The dir is created by mkdtemp under
// os.tmpdir — it can never be ~/lyt — but we assert it (and reject anything
// under ~/lyt) anyway (defence-in-depth, mirroring quality-probe.mjs's guard).

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import {
  initVaultFlow,
  rebuildVaultFlow,
  searchCascadeFlow,
  type SearchCascadeArgs,
  type SearchCascadeResult,
} from "@younndai/lyt-vault";

export interface BenchNote {
  // Path relative to the vault root, e.g. "notes/foo.md".
  rel: string;
  // YAML frontmatter body WITHOUT the surrounding `---` fences.
  frontmatter: string;
  // Markdown body.
  body: string;
}

// Fixed clock threaded into reindex so temporal caches (keyword decay,
// recent-activity) are deterministic — the bench's metrics must not drift with
// wall-clock time.
export const BENCH_NOW_ISO = "2026-06-01T00:00:00.000Z";

export interface BenchPod {
  // The temp LYT_HOME root (under os.tmpdir).
  readonly home: string;
  // Scaffold + register a vault offline, then write its figments to disk.
  seedVault(name: string, notes: readonly BenchNote[]): Promise<void>;
  // Rebuild all content-tier caches (lanes + arcs + fts + rollup) for a vault.
  reindex(name: string): Promise<void>;
  // Run the tiered-cascade search against the pod.
  search(args: SearchCascadeArgs): Promise<SearchCascadeResult>;
  // Restore LYT_HOME + LYT_IDENTITY_OVERRIDE and remove the temp pod. Never throws.
  teardown(): void;
}

const REAL_POD = resolve(homedir(), "lyt");
const BENCH_PREFIX = "lyt-bench-";
// Sweep leaked bench pods older than this (Windows libSQL handle lag can defeat
// the teardown rmSync). Age-gated so a concurrent run's live pod is never hit.
const STALE_POD_MS = 10 * 60_000;

// Best-effort reaper for bench pods a prior run failed to delete. Everything it
// touches is a mkdtemp dir named `lyt-bench-*` under os.tmpdir — junction-free,
// L0-safe. Age-gated + fully swallowed; never fails the bench.
function sweepStaleBenchPods(nowMs: number): void {
  let entries: string[];
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(BENCH_PREFIX)) continue;
    const full = join(tmpdir(), name);
    try {
      if (nowMs - statSync(full).mtimeMs < STALE_POD_MS) continue;
      rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      // leave it; never fail on cleanup
    }
  }
}

export function setupBenchPod(): BenchPod {
  sweepStaleBenchPods(Date.now());

  const home = mkdtempSync(join(tmpdir(), BENCH_PREFIX));
  const resolvedHome = resolve(home);
  if (resolvedHome === REAL_POD || resolvedHome.startsWith(REAL_POD + sep)) {
    throw new Error(`bench: refusing to run against the real pod (${REAL_POD}).`);
  }

  const prevLytHome = process.env["LYT_HOME"];
  const prevIdentity = process.env["LYT_IDENTITY_OVERRIDE"];
  process.env["LYT_HOME"] = home;
  // Pin a synthetic identity so vault scaffolding (initVault -> getIdentity)
  // never spawns `gh auth status` / `gh api /user`. WITHOUT this the bench
  // throws on any machine where gh is missing/unauthed (release review C1) — this
  // is what makes it truly offline + safe to run anywhere. Mirrors how every
  // init-touching test pins LYT_IDENTITY_OVERRIDE.
  process.env["LYT_IDENTITY_OVERRIDE"] = "github:lyt-bench";

  return {
    home,

    async seedVault(name, notes): Promise<void> {
      const init = await initVaultFlow({
        name,
        gitInit: false,
        commitInitial: false,
        selfHeal: { federation: { enabled: false } },
      });
      for (const note of notes) {
        const full = join(init.vaultPath, note.rel);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, `---\n${note.frontmatter}\n---\n${note.body}\n`, "utf8");
      }
    },

    async reindex(name): Promise<void> {
      await rebuildVaultFlow({ vault: name, nowIso: BENCH_NOW_ISO });
    },

    async search(args): Promise<SearchCascadeResult> {
      return searchCascadeFlow(args);
    },

    teardown(): void {
      // Restore env FIRST, unconditionally — a cleanup failure must never leave
      // LYT_HOME / LYT_IDENTITY_OVERRIDE dangling.
      if (prevLytHome === undefined) delete process.env["LYT_HOME"];
      else process.env["LYT_HOME"] = prevLytHome;
      if (prevIdentity === undefined) delete process.env["LYT_IDENTITY_OVERRIDE"];
      else process.env["LYT_IDENTITY_OVERRIDE"] = prevIdentity;
      // `home` is a fresh mkdtemp dir under os.tmpdir — no junctions, L0-safe.
      // Best-effort: Windows libSQL handle lag can still defeat this; whatever is
      // left is reaped by the next run's sweepStaleBenchPods.
      try {
        rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch {
        // leave for the next run's sweep
      }
    },
  };
}
