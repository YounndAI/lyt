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

import { walkGithub, type DiscoveredRepo, type GhExecutor } from "./github.js";
import type { VaultSource, VaultSourceRow } from "../source/types.js";

export interface SourceAdapter {
  readonly host: string;
  discover(source: VaultSource): Promise<DiscoveredRepo[]>;
}

export interface MeshDiscoveryResult {
  source: VaultSourceRow;
  repo: DiscoveredRepo;
}

export interface WalkOptions {
  sources: readonly VaultSourceRow[];
  sourceFilter?: string;
  adapters?: readonly SourceAdapter[];
  gh?: GhExecutor;
}

export interface WalkResult {
  discovered: MeshDiscoveryResult[];
  duplicates: number;
  perSource: Record<string, number>;
  skippedSources: { name: string; reason: string }[];
}

export function buildDefaultAdapters(gh?: GhExecutor): SourceAdapter[] {
  return [
    {
      host: "github.com",
      discover: (source) => walkGithub({ source, gh }),
    },
  ];
}

export async function walk(opts: WalkOptions): Promise<WalkResult> {
  const adapters = opts.adapters ?? buildDefaultAdapters(opts.gh);
  const adapterByHost = new Map(adapters.map((a) => [a.host, a]));
  const sources = opts.sourceFilter
    ? opts.sources.filter((s) => s.name === opts.sourceFilter)
    : opts.sources;
  const seen = new Set<string>();
  const discovered: MeshDiscoveryResult[] = [];
  const perSource: Record<string, number> = {};
  const skippedSources: { name: string; reason: string }[] = [];
  let duplicates = 0;
  for (const source of sources) {
    perSource[source.name] = 0;
    const adapter = adapterByHost.get(source.host);
    if (!adapter) {
      skippedSources.push({
        name: source.name,
        reason: `host '${source.host}' not yet supported (Phase 4 ships GitHub only)`,
      });
      continue;
    }
    let repos: DiscoveredRepo[];
    try {
      repos = await adapter.discover({
        name: source.name,
        host: source.host,
        owner: source.owner,
        scope: source.scope,
      });
    } catch (err) {
      skippedSources.push({
        name: source.name,
        reason: (err as Error).message,
      });
      continue;
    }
    for (const repo of repos) {
      const canonical = canonicalCloneUrl(repo.cloneUrl);
      if (seen.has(canonical)) {
        duplicates += 1;
        continue;
      }
      seen.add(canonical);
      discovered.push({ source, repo });
      perSource[source.name] = (perSource[source.name] ?? 0) + 1;
    }
  }
  return { discovered, duplicates, perSource, skippedSources };
}

function canonicalCloneUrl(url: string): string {
  return url.replace(/\.git$/i, "").toLowerCase();
}
