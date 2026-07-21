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

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { isValidGhHandle } from "../util/identity.js";

const execFileAsync = promisify(execFile);

export const ACTIVE_ACTOR_TIMEOUT_MS = 10_000;
export const ACTIVE_ACTOR_MAX_BUFFER_BYTES = 16 * 1024;

export type ActiveActorEvidenceClass =
  | "github-user-login"
  | "malformed-response"
  | "unavailable";

/**
 * Ephemeral per-attempt GitHub identity evidence. This is deliberately not a
 * cache and does not read git configuration or LYT_IDENTITY_OVERRIDE.
 */
export type ActiveActorObservation =
  | {
      attempt_id: string;
      observed_at: string;
      result: "verified";
      actor: string;
      evidence_class: "github-user-login";
    }
  | {
      attempt_id: string;
      observed_at: string;
      result: "unknown";
      actor: null;
      evidence_class: Exclude<ActiveActorEvidenceClass, "github-user-login">;
    };

export interface ActiveActorProbeRunner {
  run(args: readonly string[], options: { timeoutMs: number; maxBufferBytes: number }): Promise<string>;
}

export interface ObserveActiveActorOptions {
  attemptId: string;
  now?: () => Date;
  timeoutMs?: number;
  runner?: ActiveActorProbeRunner;
}

/**
 * Observe the currently authenticated GitHub actor for exactly one creation
 * attempt. The API request is fresh, bounded, and cannot trigger an auth
 * prompt. Failure evidence is intentionally structural; raw subprocess output
 * is never retained in the observation.
 */
export async function observeActiveActor(
  options: ObserveActiveActorOptions,
): Promise<ActiveActorObservation> {
  const attemptId = options.attemptId.trim();
  if (attemptId.length === 0) throw new Error("Active actor observation requires a non-empty attempt id.");

  const now = options.now ?? (() => new Date());
  const observedAt = now().toISOString();
  const timeoutMs = options.timeoutMs ?? ACTIVE_ACTOR_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Active actor observation requires a positive bounded timeout.");
  }

  try {
    const raw = await (options.runner ?? realActiveActorProbeRunner).run(["api", "/user"], {
      timeoutMs,
      maxBufferBytes: ACTIVE_ACTOR_MAX_BUFFER_BYTES,
    });
    const actor = parseActorLogin(raw);
    return actor === null
      ? unknownObservation(attemptId, observedAt, "malformed-response")
      : {
          attempt_id: attemptId,
          observed_at: observedAt,
          result: "verified",
          actor,
          evidence_class: "github-user-login",
        };
  } catch {
    return unknownObservation(attemptId, observedAt, "unavailable");
  }
}

export const realActiveActorProbeRunner: ActiveActorProbeRunner = {
  async run(args, options): Promise<string> {
    const { stdout } = await execFileAsync("gh", [...args], {
      encoding: "utf8",
      timeout: options.timeoutMs,
      maxBuffer: options.maxBufferBytes,
      windowsHide: true,
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    });
    return stdout;
  },
};

function parseActorLogin(raw: string): string | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const login = (value as { login?: unknown }).login;
    if (typeof login !== "string") return null;
    const normalized = login.trim().toLowerCase();
    return isValidGhHandle(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

function unknownObservation(
  attemptId: string,
  observedAt: string,
  evidenceClass: Exclude<ActiveActorEvidenceClass, "github-user-login">,
): ActiveActorObservation {
  return {
    attempt_id: attemptId,
    observed_at: observedAt,
    result: "unknown",
    actor: null,
    evidence_class: evidenceClass,
  };
}
