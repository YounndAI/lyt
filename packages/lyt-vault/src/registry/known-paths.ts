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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { getLytHome } from "../util/paths.js";

export function getKnownPathsFile(): string {
  return join(getLytHome(), "known-paths.txt");
}

export function readKnownPaths(): string[] {
  const file = getKnownPathsFile();
  if (!existsSync(file)) return [];
  const content = readFileSync(file, "utf8");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const abs = resolve(trimmed);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

export function addKnownPath(path: string): void {
  const abs = resolve(path);
  const existing = readKnownPaths();
  if (existing.includes(abs)) return;
  const file = getKnownPathsFile();
  mkdirSync(dirname(file), { recursive: true });
  const header = existsSync(file)
    ? ""
    : "# Lyt — out-of-tree vault paths to scan during `lyt registry rebuild`.\n";
  writeFileSync(
    file,
    `${header}${existing.length === 0 ? "" : existing.join("\n") + "\n"}${abs}\n`,
    "utf8",
  );
}

export function removeKnownPath(path: string): void {
  const abs = resolve(path);
  const file = getKnownPathsFile();
  if (!existsSync(file)) return;
  const existing = readKnownPaths().filter((p) => p !== abs);
  const header = "# Lyt — out-of-tree vault paths to scan during `lyt registry rebuild`.\n";
  writeFileSync(file, `${header}${existing.join("\n")}${existing.length > 0 ? "\n" : ""}`, "utf8");
}
