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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function readGitRemoteOriginUrl(repoPath: string): string | null {
  const configPath = join(repoPath, ".git", "config");
  if (!existsSync(configPath)) return null;
  const content = readFileSync(configPath, "utf8");
  const lines = content.split(/\r?\n/);
  let inOriginSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    const sectionMatch = line.match(/^\[(.+)\]\s*$/);
    if (sectionMatch) {
      inOriginSection = sectionMatch[1]!.trim() === 'remote "origin"';
      continue;
    }
    if (!inOriginSection) continue;
    const urlMatch = line.match(/^url\s*=\s*(.+?)\s*$/);
    if (urlMatch) {
      return urlMatch[1]!;
    }
  }
  return null;
}
