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

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    env: { LYT_IDENTITY_OVERRIDE: "github:test-fixture" },
    // Fork-death hardening (mirrors lyt-vault/lyt-mesh/lyt-mcp). Under vitest's
    // default PARALLEL forks this package's heavy gh-API / git-clone integration
    // tests reproducibly crash a worker ("Worker exited unexpectedly"). pool:forks
    // + isolate:false + fileParallelism:false run every file one-by-one in a SINGLE
    // REUSED fork — @libsql/client's native binding loads ONCE (its .node addon is
    // unsafe to (re)load repeatedly under concurrent load) and there is no per-file
    // fork spawn/teardown. That is the arc-standard posture every sibling package
    // uses; lyt-vault runs 309 files this way with zero fork-death.
    pool: "forks",
    // WHY isolate:false and NOT isolate:true — corrects the 310c2c1 regression.
    // 310c2c1 flipped this to isolate:true to fix a heap-OOM, on the belief that
    // fileParallelism:false still meant "one sequential reused fork". It does NOT
    // under isolate:true: vitest's forks pool RESPAWNS A FRESH FORK PER FILE when
    // isolate:true (verified — two files ran under different process.pids), so the
    // 41-file suite reloaded the libsql native binding 41×. In isolation all 41
    // respawns succeed (why it passed solo); under `npm run test:release` (turbo
    // --force, 7 packages concurrent) one reload dies under the resource pressure →
    // "Worker forks emitted error". isolate:false = one fork, binding loaded once,
    // load-independent. (singleFork is NOT a fix: isolate:true overrides it and
    // still respawns per file.)
    isolate: false,
    fileParallelism: false,
    // The OOM that 310c2c1 fixed with isolate:true is instead handled here: the
    // single reused fork accumulates memory across the heavy integration files, so
    // raise its V8 heap ceiling explicitly (deterministic regardless of the
    // machine's ambient NODE_OPTIONS, which is what the OOM was hitting). This is
    // per-fork heap headroom for ONE fork — it does not multiply under the ×7 gate.
    // NOTE: vitest 4 flattened pool options to top-level — `execArgv` here (NOT the
    // removed `poolOptions.forks.execArgv`, which is silently ignored) is passed to
    // the forked worker's node process.
    execArgv: ["--max-old-space-size=8192"],
    // npm pack --dry-run --json over 5 workspaces is slow on Windows; allow headroom.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
