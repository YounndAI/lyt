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
import { dirname, join } from "node:path";

import { v7 as uuidv7 } from "uuid";

import { getLytHome } from "./paths.js";

// Fed-v2 Layer-1 (Phase C) — the per-machine WRITER ID.
//
// The federation subscription store is a set of per-writer append-only YON
// shard logs that converge across machines/writers by git construction. A
// writer is identified by a stable UUIDv7 (RFC 9562, the project-mandated
// time-ordered id) that is minted once per machine and persisted machine-
// locally in `~/lyt/machine.yon` — NEVER committed to the pod repo.
//
// The writerId is the shard DIRECTORY name (`ledger/subscriptions/<writerId>/`),
// never part of a record body. A writer only ever appends to its own shard;
// other writers' shards are read-only inputs to the convergence fold. Because
// each machine owns a disjoint shard dir, two machines (or two writers on one
// machine recovering from a wipe) never collide on a write path — they merge
// by git, and the OR-Set fold reconciles their records deterministically.
//
// Storage shape mirrors the machine identity cache (identity-cache.ts): a
// single `@WRITER` line under a `@DOC` header. We do NOT route through
// yon-parser (trivial shape; the precedent in identity-cache.ts is a
// dependency-free permissive read). The file is co-located with registry.db
// + the machine identity cache under getLytHome() so a test can isolate via
// the LYT_HOME override and so it is never inside a pod repo working tree.

const WRITER_DOC_ID = "lyt-writer";

// Machine-local writer-id file. Distinct from `machine.yon` (the identity
// cache) by NAME — the writer-id is a separate concern (the federation shard
// owner) and keeping it in its own file avoids interleaving two unrelated
// records in one cache the identity-cache module owns.
export function getWriterIdPath(): string {
  return join(getLytHome(), "writer.yon");
}

// Read the persisted machine-local writer id; if absent (or unparseable),
// mint a fresh UUIDv7 and persist it. Returns the dashed-string UUIDv7 used
// as the shard directory name. Idempotent: a second call on the same machine
// returns the same id (read path), never re-mints.
export function getWriterId(path?: string): string {
  const p = path ?? getWriterIdPath();
  if (existsSync(p)) {
    const existing = parseWriterYon(readFileSync(p, "utf8"));
    if (existing !== null) return existing;
  }
  const minted = uuidv7();
  writeWriterId(minted, p);
  return minted;
}

function writeWriterId(writerId: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderWriterYon(writerId), "utf8");
}

function renderWriterYon(writerId: string): string {
  return (
    `@DOC ver=2.0 | id=${WRITER_DOC_ID} | domain=yai.lyt\n` +
    `\n` +
    `@WRITER rid=writer:${writerId}\n`
  );
}

// Permissive parse — pulls the rid from the first `@WRITER` line. The stored
// form is `rid=writer:<uuidv7>`; we strip the `writer:` typed-id prefix when
// present and return the bare UUIDv7. Returns null when no @WRITER line is
// present or the value is empty (caller re-mints).
export function parseWriterYon(raw: string): string | null {
  const line = raw.split(/\r?\n/).find((l) => l.startsWith("@WRITER "));
  if (line === undefined) return null;
  const m = line.match(/\brid=(?:writer:)?([^\s|]+)/);
  if (m === null || m[1] === undefined || m[1].length === 0) return null;
  return m[1];
}
