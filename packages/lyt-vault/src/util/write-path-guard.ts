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

import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Shared write-path guard for handler-influenced materialization targets.
// Existing components from the target leaf through root are lstat-checked;
// missing components are safe because the caller creates them fresh.
export function assertNoSymlinkOnWritePath(root: string, target: string): void {
  const rootR = resolve(root);
  const targetR = resolve(target);
  const chain: string[] = [];
  let cur = targetR;
  for (;;) {
    chain.push(cur);
    if (cur === rootR) break;
    const up = dirname(cur);
    if (up === cur) {
      throw new Error(`Refusing to write to ${target}: it is outside the allowed root ${rootR}.`);
    }
    cur = up;
  }
  for (const path of chain) {
    try {
      if (lstatSync(path).isSymbolicLink()) {
        throw new Error(
          `Refusing to write to ${target}: the write-path component ${JSON.stringify(path)} ` +
            `is a symlink/junction. A reparse point could redirect the write outside ${rootR}. ` +
            `Remove or replace the link with a real directory and retry.`,
        );
      }
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") continue;
      throw err;
    }
  }
}
