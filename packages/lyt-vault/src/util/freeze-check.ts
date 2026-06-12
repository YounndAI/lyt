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

import { formatRemaining } from "./duration.js";

export const FROZEN_LOCK_BASENAME = "frozen.lock";

export interface FrozenLockContent {
  frozen_at: string;
  frozen_until: string;
}

export interface FrozenState {
  frozen: boolean;
  expired: boolean;
  frozenAt: string | null;
  frozenUntil: string | null;
  remaining: string | null;
  lockPath: string;
}

export function frozenLockPath(vaultPath: string): string {
  return join(vaultPath, ".lyt", FROZEN_LOCK_BASENAME);
}

export function readFrozenLock(vaultPath: string, now: Date = new Date()): FrozenState {
  const lockPath = frozenLockPath(vaultPath);
  if (!existsSync(lockPath)) {
    return {
      frozen: false,
      expired: false,
      frozenAt: null,
      frozenUntil: null,
      remaining: null,
      lockPath,
    };
  }
  let parsed: FrozenLockContent;
  try {
    parsed = JSON.parse(readFileSync(lockPath, "utf8")) as FrozenLockContent;
  } catch {
    return {
      frozen: true,
      expired: false,
      frozenAt: null,
      frozenUntil: null,
      remaining: null,
      lockPath,
    };
  }
  const untilMs = Date.parse(parsed.frozen_until);
  const expired = Number.isFinite(untilMs) && untilMs <= now.getTime();
  return {
    frozen: true,
    expired,
    frozenAt: parsed.frozen_at ?? null,
    frozenUntil: parsed.frozen_until ?? null,
    remaining: parsed.frozen_until ? formatRemaining(parsed.frozen_until, now) : null,
    lockPath,
  };
}

export function nearExpiryWindowHours(): number {
  return 24;
}

export function isNearExpiry(state: FrozenState, now: Date = new Date()): boolean {
  if (!state.frozen || state.expired || !state.frozenUntil) return false;
  const untilMs = Date.parse(state.frozenUntil);
  if (!Number.isFinite(untilMs)) return false;
  return untilMs - now.getTime() <= nearExpiryWindowHours() * 60 * 60 * 1_000;
}

// Throws if the vault is frozen and not yet expired. If expired, auto-unfreezes
// by removing both the sentinel lock and the frozen_at/frozen_until fields in
// vault.yon, then resolves (caller proceeds).
export async function enforceNotFrozen(
  vaultPath: string,
  vaultName: string,
  now: Date = new Date(),
): Promise<{ autoUnfrozen: boolean }> {
  const state = readFrozenLock(vaultPath, now);
  if (!state.frozen) return { autoUnfrozen: false };
  if (state.expired) {
    const { unfreezeVaultFlow } = await import("../flows/unfreeze.js");
    await unfreezeVaultFlow({ name: vaultName });
    return { autoUnfrozen: true };
  }
  throw new Error(
    `Vault '${vaultName}' is frozen until ${state.frozenUntil ?? "<unknown>"} (${state.remaining ?? "?"}). ` +
      `Run 'lyt vault unfreeze ${vaultName}' to release early.`,
  );
}
