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
import { defineConfig } from "vitest/config";

// Shared base for every project below. Kept identical to the long-standing
// single-config so the main suite's behaviour is unchanged.
const baseTest = {
  environment: "node" as const,
  env: { LYT_IDENTITY_OVERRIDE: "github:test-fixture" },
  // Run-level leak backstop. Without an exclusive LYT_TEST_RUN_ROOT it only
  // reports newly observed lyt-* entries; it never deletes unproven backlog.
  globalSetup: ["./tests/_helpers/global-temp-sweep.ts"],
  // libsql's native Node binding is not safe to load across worker threads;
  // use a single forked process so file-based registry tests don't compete
  // for Windows file locks. isolate: false shares the module graph across
  // test files so @libsql/client native binding loads once, not per-file.
  pool: "forks" as const,
  isolate: false,
  // Hardening note (2026-06-10): `forks: { singleFork: true }` was dead config in
  // vitest 4 (never a valid key shape) — files actually ran in parallel
  // forks. `fileParallelism: false` is the vitest-4 spelling of the
  // single-fork sequential intent documented above.
  fileParallelism: false,
  // raised from 15s (V98 2026-06-27 spike: Windows git-subprocess latency
  // pushes git-integration tests to 13–25s; 45s = ~3× clean worst-case, still
  // tight enough to catch a 2× regression).
  // Keep in sync with packages/lyt-runner/vitest.config.ts (same git-latency class).
  // SEE ALSO: tests/flows-mesh-init.test.ts MESH_INIT_IDENTITY_POLICY_TIMEOUT_MS —
  // its intentionally tighter 35s per-instance cap must remain below this ceiling.
  testTimeout: 45000,
  hookTimeout: 45000,
};

// 0.12.0 Phase D — sync-conflict-resolver flake isolation (test-infra only).
//
// tests/commands-sync-conflict-resolver.test.ts races the resolver against a
// 2000ms `withStdinGuarded` timer to assert the non-interactive default never
// blocks on a stdin prompt. It passes 4/4 in isolation but fails ONLY under the
// ×7 parallel release gate: 7 concurrent vitest processes contend for CPU, the
// 2000ms race deadline slips, and one file interleaving with a sibling that
// mutates the process-global `process.stdin.isTTY` (test 4) can leave the
// resolver momentarily seeing a TTY → it tries to prompt. Same test-order /
// parallelism-pollution class as the June lyt-vault access-tests that got their
// own isolate:true vitest project — a product-clean flake, not a defect.
//
// Fix: carve this file into its own project with isolate:true so it runs in a
// fresh module graph no sibling can disturb; the main project excludes it and is
// otherwise byte-identical to the prior single-config behaviour.
const SYNC_CONFLICT_ISOLATED = ["tests/commands-sync-conflict-resolver.test.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...baseTest,
          name: "main",
          include: ["tests/**/*.test.ts"],
          // A bare `exclude` REPLACES vitest's built-in defaults, so re-list them
          // here — otherwise node_modules/dist/etc. would be swept into the main
          // suite. Keep in sync with vitest's default `exclude` list.
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "**/.{idea,git,cache,output,temp}/**",
            "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
            ...SYNC_CONFLICT_ISOLATED,
          ],
        },
      },
      {
        test: {
          ...baseTest,
          name: "sync-conflict-isolated",
          include: SYNC_CONFLICT_ISOLATED,
          // Fresh module graph per file so a sibling's global-state mutation
          // (process.stdin.isTTY) or vi.resetModules can never interleave into
          // this file's stdin-guard race under the ×7 gate.
          isolate: true,
        },
      },
    ],
  },
});
