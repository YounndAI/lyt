import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    isolate: false,
    // Hardening note (2026-06-10): `forks: { singleFork: true }` was dead config in
    // vitest 4 (never a valid key shape) — files actually ran in parallel
    // forks. `fileParallelism: false` is the vitest-4 spelling of the
    // single-fork sequential intent.
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
