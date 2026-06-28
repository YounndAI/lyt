import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Fork-death hardening (mirrors lyt-vault/vitest.config.ts). Under vitest's
    // default PARALLEL forks this package's heavy gh-API / git-clone integration
    // tests reproducibly crash a worker ("Worker exited unexpectedly") — and
    // non-deterministically (passed-count varied run-to-run), so the suite was
    // green only sometimes, which is itself a gate-integrity defect. pool:forks
    // + fileParallelism:false run files one-by-one in a single sequential fork
    // → deterministic (the parallelism-free property that avoids that death).
    pool: "forks",
    // isolate:true (the vitest default) RESETS the module registry between files
    // so per-file memory is freed instead of accumulating in one reused fork.
    // With the prior isolate:false the suite OOM-crashed the worker mid-run once
    // it outgrew its validated 19-file size (24 files now) under the machine's
    // NODE_OPTIONS --max-old-space-size cap; resetting keeps memory bounded
    // without per-fork heap tuning. fileParallelism:false (above) is what keeps
    // determinism — isolation is orthogonal to it.
    isolate: true,
    fileParallelism: false,
    // npm pack --dry-run --json over 5 workspaces is slow on Windows; allow headroom.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
