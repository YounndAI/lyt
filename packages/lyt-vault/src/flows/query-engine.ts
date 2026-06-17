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

// v1.G.1 — QueryEngine library export.
//
// Thin DX wrapper over searchCascadeFlow from ./search-cascade.ts.
// No business logic; pure surface-shaping for Wave 3 skill consumers
// (lyt-search v1.G.6, lyt-primer-context v1.G.7, lyt-mesh-explore
// v1.G.9) and the Wave 4 Pod Manager plugin (v1.G.10).
//
// Naming follows (2026-06-01): the public-facing alias for
// scope=federation is `searchPod` — internal SearchCascadeScope keeps
// scope="federation" since it is the technical-API context.
//
// Two shapes:
// - Free functions (searchVault / searchMesh / searchPod) for
// one-off calls where the caller does not need to share a
// registry handle across queries.
// - createQueryEngine(registryDb) factory returning a QueryEngine
// object whose methods all reuse the supplied registry handle
// (open-once seam — v1.A.5 CR-B1 vindication, see
// search-cascade.ts:160-161 callerSuppliedRegistry).
//
// Return shape: SearchCascadeResult (preserves trace + durationMs
// metadata that downstream primer/explore skills may want). Hits
// alias = SearchResult[] is exported for consumers that destructure
// to just the array.

import type { Client } from "@libsql/client";

import {
  searchCascadeFlow,
  type SearchCascadeArgs,
  type SearchCascadeResult,
  type SearchResult,
} from "./search-cascade.js";

export type Hits = SearchResult[];

type ScopedQueryArgs = Omit<SearchCascadeArgs, "scope">;

export async function searchVault(
  args: ScopedQueryArgs & { scopeTarget: string },
): Promise<SearchCascadeResult> {
  return searchCascadeFlow({ ...args, scope: "vault" });
}

export async function searchMesh(
  args: ScopedQueryArgs & { scopeTarget: string },
): Promise<SearchCascadeResult> {
  return searchCascadeFlow({ ...args, scope: "mesh" });
}

export async function searchPod(args: ScopedQueryArgs): Promise<SearchCascadeResult> {
  return searchCascadeFlow({ ...args, scope: "federation" });
}

export interface QueryEngine {
  searchVault(args: ScopedQueryArgs & { scopeTarget: string }): Promise<SearchCascadeResult>;
  searchMesh(args: ScopedQueryArgs & { scopeTarget: string }): Promise<SearchCascadeResult>;
  searchPod(args: ScopedQueryArgs): Promise<SearchCascadeResult>;
}

export function createQueryEngine(registryDb: Client): QueryEngine {
  return {
    searchVault: (a) => searchCascadeFlow({ ...a, scope: "vault", registryDb }),
    searchMesh: (a) => searchCascadeFlow({ ...a, scope: "mesh", registryDb }),
    searchPod: (a) => searchCascadeFlow({ ...a, scope: "federation", registryDb }),
  };
}
