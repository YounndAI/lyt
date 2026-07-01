import { defineConfig } from "vitest/config";

// Shared base for every project below. Kept identical to the long-standing
// single-config so the main suite's behaviour is unchanged.
const baseTest = {
  environment: "node" as const,
  // Safety-net for the test-fixture temp-dir leak: sweeps residual `lyt-*`
  // dirs created in os.tmpdir() during this run (crashed fixtures + the
  // shared makeRegisteredVault helper). teardown() runs once in the main
  // process after all files. See tests/_helpers/global-temp-sweep.ts.
  globalSetup: ["./tests/_helpers/global-temp-sweep.ts"],
  // libsql's native Node binding is not safe to load across worker threads;
  // use a single forked process so file-based registry tests don't compete
  // for Windows file locks. isolate: false shares the module graph across
  // test files so @libsql/client native binding loads once, not per-file.
  pool: "forks" as const,
  isolate: false,
  // Hardening note (2026-06-10): `forks: { singleFork: true }` was DEAD CONFIG — that
  // key shape never existed in vitest 4 (this repo has been on vitest ^4
  // since the initial skeleton), so the suite silently ran files in PARALLEL
  // forks the whole time, causing the Windows libsql EBUSY/contention flake
  // family the timeouts below were raised to paper over. vitest 4 spells
  // single-process sequential execution as `fileParallelism: false` (files
  // run one-by-one; with isolate:false + pool:forks they reuse one fork —
  // the original singleFork intent).
  fileParallelism: false,
  // Must exceed rmStrict / renameRetry's 720×250ms=180000ms budget. The
  // per-vault lyt.db OS file-lock has been observed to persist past 120s
  // under heavy singleFork load (v1.C.4.2 second-raise: 126s outlier in
  // flows-registry-reset stress). 300s here gives ~1.7x headroom over the
  // 180s rm budget so retries can fully drain without the test framework
  // killing the call site mid-loop.
  testTimeout: 300000,
  hookTimeout: 300000,
  // Default identity override for all tests — keeps initVault/adoptVault/
  // patternRunFlow deterministic without invoking `gh`. Identity-specific
  // tests delete this in beforeEach to exercise the real cache/runner paths.
  env: {
    LYT_IDENTITY_OVERRIDE: "github:test-fixture",
  },
};

// V98 2026-06-27 — access-flow / share-flow pollution fix (test-infra only).
//
// tests/access/access-flow.test.ts and share-flow.test.ts inject a fake `db`
// ({} with no .execute) and rely on a hoisted vi.mock("registry/repo.js") so
// the flow's module-level `getVaultByName(db, …)` (flows/access.ts:102,
// flows/share.ts:106/143 — a static import, NOT injectable) never touches the
// fake db. Under the shared single-fork module graph (isolate:false +
// fileParallelism:false), a sibling file's `vi.resetModules()` can interleave
// such that these files' hoisted mock is dropped before their body imports the
// flow → the REAL getVaultByName runs → `db.execute is not a function`. This
// passes 16/16 in isolation and ONLY surfaces in the full 244-file run, so it
// is shared-state pollution, not a product defect.
//
// Fix: carve the mock-dependent access-flow files into their own project with
// isolate:true so each runs in a fresh module graph no other file can disturb.
// The main project excludes them; everything else is byte-identical to the
// prior single-config behaviour.
//
// V99 2026-06-27 — WIDENED from an enumerated two-file list to the whole
// tests/access/ dir. The hand-maintained list drifted: abandon-flow.test.ts (a
// 3rd hoisted vi.mock("flows/delete.js") file) was a missed sibling and flaked
// the 0.9.7 release gate with the identical pollution — a sibling's
// vi.resetModules() stripped its hoisted mock, the REAL deleteVaultFlow ran →
// "No vault registered with name 'younndai/main'". invites-flow.test.ts was a
// latent 4th (same signature). Both pass in isolation; both fail only in the
// full single-fork run. A directory glob cannot miss a future access sibling.
// The 3 no-mock files here (access-provider/gh-access-provider/gh-parsers) are
// safe under isolate:true (independent; access-provider does a disk init) —
// validated by the full ×7 re-gate. Track-B redesigns isolation post-release.
const ACCESS_ISOLATED = ["tests/access/**/*.test.ts"];

// The embeddings download-progress spy hoists a
// vi.mock("../../src/util/fetch-model.js") so loadEmbedder's owned fetch fires a
// KNOWN monotonic byte sequence (a model-absent path) WITHOUT a real network
// download. Under the shared single-fork module graph (isolate:false +
// fileParallelism:false), a sibling file importing the REAL embeddings.js →
// fetch-model.js first leaves the un-mocked module cached, so this file's hoisted
// mock is dropped and a REAL GCS download runs (thousands of progress events +
// network). Same shared-state-pollution class as ACCESS_ISOLATED — carve it into
// its own project with isolate:true so its mock can never be stripped (and the
// real fetch never fires). Passes in isolation; only flaked in the full run.
const EMBEDDINGS_PROGRESS_ISOLATED = ["tests/util/embeddings-download-progress.test.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...baseTest,
          name: "main",
          include: ["tests/**/*.test.ts"],
          exclude: [...ACCESS_ISOLATED, ...EMBEDDINGS_PROGRESS_ISOLATED],
        },
      },
      {
        test: {
          ...baseTest,
          name: "embeddings-progress-isolated",
          include: EMBEDDINGS_PROGRESS_ISOLATED,
          // Fresh module graph so the hoisted fetch-model mock can never be
          // stripped by a sibling — guarantees the spy sees the mocked monotonic
          // byte sequence and NEVER triggers a real network download.
          isolate: true,
        },
      },
      {
        test: {
          ...baseTest,
          name: "access-isolated",
          include: ACCESS_ISOLATED,
          // The whole point: a fresh module graph per file so a sibling's
          // vi.resetModules() can never strip these files' hoisted repo.js /
          // client.js mocks. Cheap here — these are pure unit flows (fake db,
          // fake provider, zero disk / gh / git).
          isolate: true,
        },
      },
    ],
  },
});
