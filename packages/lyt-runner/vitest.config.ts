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
