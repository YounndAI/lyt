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
// Copy src/scaffold/defaults/ into dist/scaffold/defaults/ so the published
// tarball ships the bundled @AUTOMATOR (and future @DIRECTIVE / @MEMSCOPE)
// YON reference declarations that `lyt vault init` / `lyt vault adopt` copy
// into a fresh vault's .lyt/automators/ etc.
//
// Block-A.3 Commit 10: metadata-filler.yon (arc §6.13 Example 1).
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "..", "src", "scaffold", "defaults");
const dest = resolve(here, "..", "dist", "scaffold", "defaults");

if (!existsSync(src)) {
  console.error("[copy-yon-defaults] src directory missing, nothing to copy");
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.error(`[copy-yon-defaults] ${src} -> ${dest}`);
