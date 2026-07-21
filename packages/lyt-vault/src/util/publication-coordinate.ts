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

import { canonicalizeCoordinate, gitUrlToCoordinate } from "../registry/vault-addressing.js";

/** The only outcomes a legacy publication-origin comparison may produce. */
export type PublicationCoordinateComparison = "match" | "mismatch" | "unparseable";

export interface GithubPublicationCoordinate {
  coordinate: string;
  owner: string;
  repositoryName: string;
}

export function isValidGithubRepositoryName(value: string): boolean {
  return value.length > 0 && value.length <= 100 && /^[A-Za-z0-9_.-]+$/.test(value);
}

/** Normalize one exact GitHub owner/repository coordinate through the shared parser. */
export function normalizeGithubPublicationCoordinate(
  value: string | null | undefined,
): GithubPublicationCoordinate | null {
  const coordinate = toCanonicalPublicationCoordinate(value);
  if (coordinate === null) return null;
  const payload = coordinate.slice("lyt:vault:".length);
  const parts = payload.split("/");
  if (
    parts.length !== 3 ||
    parts[0] !== "github.com" ||
    parts[1]!.length === 0 ||
    !isValidGithubRepositoryName(parts[2]!)
  ) {
    return null;
  }
  return { coordinate, owner: parts[1]!, repositoryName: parts[2]! };
}

/**
 * Compare two publication origins without introducing another Git URL parser.
 *
 * Inputs may be Git remotes (SSH, HTTPS, or another supported scheme) or an
 * existing `lyt:vault:`/bare coordinate. An input that cannot become a
 * canonical coordinate is deliberately `unparseable`; callers must quarantine
 * that legacy state rather than infer an override from it.
 */
export function comparePublicationCoordinates(
  left: string | null | undefined,
  right: string | null | undefined,
): PublicationCoordinateComparison {
  const leftCoordinate = toCanonicalPublicationCoordinate(left);
  const rightCoordinate = toCanonicalPublicationCoordinate(right);
  if (leftCoordinate === null || rightCoordinate === null) return "unparseable";
  return leftCoordinate === rightCoordinate ? "match" : "mismatch";
}

function toCanonicalPublicationCoordinate(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;

  // `gitUrlToCoordinate` is the existing URL parser and canonicalizer. Keep
  // every URL spelling on that one path so comparison cannot drift from the
  // coordinates stored for vault origins.
  const fromGitUrl = gitUrlToCoordinate(value);
  if (fromGitUrl !== null) return canonicalizeCoordinate(fromGitUrl);

  // Legacy ledgers may already hold either bare or typed coordinates. Their
  // canonical form is owned by vault-addressing as well.
  const canonical = canonicalizeCoordinate(value);
  if (!canonical.startsWith("lyt:vault:")) return null;

  // canonicalizeCoordinate intentionally passes malformed values through. A
  // successful typed prefix alone is therefore not proof of a usable
  // coordinate; validate its canonical payload through the shared Git parser.
  const payload = canonical.slice("lyt:vault:".length);
  return gitUrlToCoordinate(`https://${payload}`) === null ? null : canonical;
}
