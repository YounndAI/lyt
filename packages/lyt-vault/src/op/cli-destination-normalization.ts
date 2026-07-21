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

import { isValidGhHandle } from "../util/identity.js";
import { parseGithubPublicationTarget, type CanonicalGithubPublicationTarget } from "../util/permission-observation.js";
import type { DestinationRequest } from "../flows/creation-plan.js";

export type CommanderValueSource = "default" | "config" | "env" | "cli" | "implied" | undefined;

export interface CommanderSourceReader {
  getOptionValueSource(optionName: string): CommanderValueSource;
}

export interface CreationDestinationCommandOptions {
  target?: string;
  local?: boolean;
  pushTo?: string;
  pushKind?: string;
  /** Commander stores the inverse `--no-push` value under `push`. */
  push?: boolean;
}

export interface LegacyDestinationCompatibility {
  noPush: boolean;
  pushTo: boolean;
  pushKind: boolean;
}

export type NormalizedCreationDestination =
  | {
      kind: "normalized";
      request: DestinationRequest;
      online_action: "none";
      legacy: LegacyDestinationCompatibility;
    }
  | { kind: "refusal"; code: string; message: string; next_action: string };

/**
 * Normalize only command-line supplied creation flags. Commander defaults are
 * not evidence of Handler intent, notably the legacy `pushKind: handle`
 * default. Creation remains local/not-published; legacy no-push only records
 * compatibility and never discards an explicit destination target.
 */
export function normalizeCommanderCreationDestination(
  options: CreationDestinationCommandOptions,
  sources: CommanderSourceReader,
): NormalizedCreationDestination {
  const targetExplicit = wasSupplied(sources, "target");
  const localExplicit = wasSupplied(sources, "local");
  const pushToExplicit = wasSupplied(sources, "pushTo");
  const pushKindExplicit = wasSupplied(sources, "pushKind");
  const noPushExplicit = wasSupplied(sources, "push") && options.push === false;
  const legacy = { noPush: noPushExplicit, pushTo: pushToExplicit, pushKind: pushKindExplicit };

  if (localExplicit && options.local !== true) {
    return refusal("invalid-local-flag", "--local must be supplied as a positive local destination.");
  }
  if (targetExplicit && localExplicit) {
    return refusal("conflicting-destination-flags", "--target and --local cannot be combined.");
  }
  if (pushKindExplicit && !pushToExplicit) {
    return refusal("push-kind-without-push-to", "--push-kind requires legacy --push-to <owner>.");
  }
  if (localExplicit && pushKindExplicit) {
    return refusal("local-with-push-kind", "--local cannot be combined with an explicit --push-kind.");
  }
  if (localExplicit && pushToExplicit) {
    return refusal("conflicting-destination-flags", "--local cannot be combined with --push-to.");
  }

  const canonical = targetExplicit ? canonicalTarget(options.target, "--target") : null;
  if (targetExplicit && canonical === null) {
    return refusal("invalid-target", "--target must be github:user/<owner> or github:org/<owner>.");
  }
  const legacyTarget = pushToExplicit ? legacyCanonicalTarget(options.pushTo, options.pushKind) : null;
  if (pushToExplicit && legacyTarget === null) {
    return refusal("invalid-push-to", "--push-to requires a valid GitHub owner.");
  }
  if (canonical !== null && legacyTarget !== null && canonical.value !== legacyTarget.value) {
    return refusal("conflicting-destination-flags", "--target and --push-to resolve to different destinations.");
  }
  if (canonical !== null) return normalized({ kind: "target", target: canonical.value }, legacy);
  if (legacyTarget !== null) return normalized({ kind: "target", target: legacyTarget.value }, legacy);
  if (localExplicit || noPushExplicit) return normalized({ kind: "local" }, legacy);
  return normalized({ kind: "auto" }, legacy);
}

function normalized(
  request: DestinationRequest,
  legacy: LegacyDestinationCompatibility,
): NormalizedCreationDestination {
  return { kind: "normalized", request, online_action: "none", legacy };
}

function refusal(code: string, message: string): NormalizedCreationDestination {
  return { kind: "refusal", code, message, next_action: "Correct creation destination flags and retry." };
}

function wasSupplied(sources: CommanderSourceReader, optionName: string): boolean {
  return sources.getOptionValueSource(optionName) === "cli";
}

function canonicalTarget(
  value: string | undefined,
  _flag: "--target",
): CanonicalGithubPublicationTarget | null {
  return typeof value === "string" ? parseGithubPublicationTarget(value) : null;
}

function legacyCanonicalTarget(
  ownerRaw: string | undefined,
  kindRaw: string | undefined,
): CanonicalGithubPublicationTarget | null {
  if (typeof ownerRaw !== "string") return null;
  const owner = ownerRaw.trim().toLowerCase();
  if (!isValidGhHandle(owner)) return null;
  const kind = kindRaw === "org" ? "org" : kindRaw === undefined || kindRaw === "handle" ? "user" : null;
  return kind === null ? null : parseGithubPublicationTarget(`github:${kind}/${owner}`);
}
