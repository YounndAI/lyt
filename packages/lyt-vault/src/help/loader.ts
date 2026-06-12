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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function getTopicsDir(): string {
  // After build, this file lives at dist/help/loader.js with topics at
  // dist/help/topics/. In dev / vitest the file is src/help/loader.ts with
  // topics at src/help/topics/. Same relative layout in both cases.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "topics");
}

export function listAvailableTopics(): string[] {
  const dir = getTopicsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

export function loadTopicMarkdown(name: string): string | null {
  const dir = getTopicsDir();
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "");
  if (safeName.length === 0) return null;
  const target = join(dir, `${safeName}.md`);
  if (!existsSync(target)) return null;
  return readFileSync(target, "utf8");
}
