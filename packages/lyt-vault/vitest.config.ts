import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Safety-net for the test-fixture temp-dir leak: sweeps residual `lyt-*`
    // dirs created in os.tmpdir() during this run (crashed fixtures + the
    // shared makeRegisteredVault helper). teardown() runs once in the main
    // process after all files. See tests/_helpers/global-temp-sweep.ts.
    globalSetup: ["./tests/_helpers/global-temp-sweep.ts"],
    // libsql's native Node binding is not safe to load across worker threads;
    // use a single forked process so file-based registry tests don't compete
    // for Windows file locks. isolate: false shares the module graph across
    // test files so @libsql/client native binding loads once, not per-file.
    pool: "forks",
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
  },
});
