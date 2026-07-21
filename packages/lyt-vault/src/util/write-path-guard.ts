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
import { dirname, parse, resolve } from "node:path";

/** Refuse a write if its leaf or any existing parent is a link/reparse point. */
export function assertSafeWritePath(path: string): void {
  let current = resolve(path);
  const root = parse(current).root;
  while (true) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing write through symlink or reparse point: ${current}`);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
    if (current === root) return;
    current = dirname(current);
  }
}

export const assertNoReparsePointInPath = assertSafeWritePath;

// Existing callers provide an allowed root as well as a target. Keep that
// boundary contract while sharing the leaf-and-parent reparse inspection used
// by fresh scaffold writes.
export function assertNoSymlinkOnWritePath(root: string, target: string): void {
  const rootResolved = resolve(root);
  const targetResolved = resolve(target);
  let current = targetResolved;
  while (current !== rootResolved) {
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Refusing to write to ${target}: it is outside the allowed root ${rootResolved}.`);
    }
    current = parent;
  }
  assertSafeWritePath(targetResolved);
}
