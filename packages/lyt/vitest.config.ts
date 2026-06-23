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
    // + isolate:false + fileParallelism:false run files one-by-one in a single
    // reused fork → deterministic (validated 19/19 files, 96/96 green).
    pool: "forks",
    isolate: false,
    fileParallelism: false,
    // npm pack --dry-run --json over 5 workspaces is slow on Windows; allow headroom.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
