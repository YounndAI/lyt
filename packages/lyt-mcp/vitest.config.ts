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
