import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // raised from 15s (V98 2026-06-27, audit-coupled-constant sibling of
    // lyt-mesh): tests/ops/vault-ops.test.ts + tests/protocol/five-step.test.ts
    // drive real git subprocesses (runGit init/config/add/commit/log) and hit
    // the same Windows git-subprocess latency that pushes git-integration tests
    // to 13–25s. 45s = ~3× clean worst-case, still tight enough to catch a 2×
    // regression. Keep in sync with packages/lyt-mesh/vitest.config.ts.
    testTimeout: 45000,
    hookTimeout: 45000,
  },
});
