import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // libsql's native Node binding is not safe to load across worker threads;
    // use a single forked process so file-based registry tests don't compete
    // for Windows file locks. isolate: false shares the module graph across
    // test files so @libsql/client native binding loads once, not per-file.
    pool: "forks",
    isolate: false,
    // Hardening note (2026-06-10): `forks: { singleFork: true }` was dead config in
    // vitest 4 (never a valid key shape) — files actually ran in parallel
    // forks. `fileParallelism: false` is the vitest-4 spelling of the
    // single-fork sequential intent documented above.
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
