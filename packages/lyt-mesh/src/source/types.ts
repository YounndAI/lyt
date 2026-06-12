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

export type VaultSourceScope = "all" | { topic: string } | { repos: readonly string[] };

export interface VaultSource {
  name: string;
  host: string;
  owner: string;
  scope: VaultSourceScope;
}

export interface VaultSourceRow {
  id: number;
  name: string;
  host: string;
  owner: string;
  scope: VaultSourceScope;
  addedAt: string;
}

export function serializeScope(scope: VaultSourceScope): string {
  if (scope === "all") return "all";
  if ("topic" in scope) return `topic=${scope.topic}`;
  return `repos=${scope.repos.join(",")}`;
}

export function parseScope(raw: string): VaultSourceScope {
  if (raw === "all" || raw === "") return "all";
  const eq = raw.indexOf("=");
  if (eq === -1) {
    throw new Error(`Invalid scope '${raw}'. Use 'all', 'topic=<tag>', or 'repos=<a,b,c>'.`);
  }
  const key = raw.slice(0, eq).trim();
  const val = raw.slice(eq + 1).trim();
  if (key === "topic") {
    if (!val) throw new Error("scope 'topic=' requires a tag value.");
    return { topic: val };
  }
  if (key === "repos") {
    const repos = val
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (repos.length === 0) {
      throw new Error("scope 'repos=' requires at least one repo name.");
    }
    return { repos };
  }
  throw new Error(`Unknown scope key '${key}'. Use 'all', 'topic=<tag>', or 'repos=<a,b,c>'.`);
}
