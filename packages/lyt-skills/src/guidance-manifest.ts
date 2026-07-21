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

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface GuidanceManifestEntryV1 {
  guidanceId: string;
  audience: "agent";
  ownerKind: "skill";
  canonicalSourceRoute: string;
  packedPath: string;
  compatibility: {
    requiresLyt: ">=0.20.0 <0.21.0";
    contractVersion: "1.0.0";
  };
  versionMetadata: {
    skillVersion: "1.0.0";
    legacyLytVersion: string;
    legacySupportedThrough: "0.20.x";
    legacyRemovalContractMajor: 2;
  };
}

export type GuidanceManifestV1 = readonly GuidanceManifestEntryV1[];

export const GUIDANCE_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LEGACY_LYT_VERSIONS = {
  "lyt-adopt": "0.11.0",
  "lyt-alias": "0.9.5",
  "lyt-capture": "0.2.0",
  "lyt-create": "0.20.0",
  "lyt-mesh-explore": "0.8.0",
  "lyt-pattern": "0.2.0",
  "lyt-pod": "0.7.0",
  "lyt-primer-context": "0.6.0",
  "lyt-recall": "0.9.8",
  "lyt-search": "0.5.0",
  "lyt-sync": "0.4.0",
  "lyt-update": "0.11.0",
} as const;

export const GUIDANCE_MANIFEST_V1: GuidanceManifestV1 = Object.entries(LEGACY_LYT_VERSIONS).map(
  ([name, legacyLytVersion]) => ({
    guidanceId: `skill:${name}`,
    audience: "agent",
    ownerKind: "skill",
    canonicalSourceRoute: `skills/${name}/SKILL.md`,
    packedPath: `skills/${name}/SKILL.md`,
    compatibility: {
      requiresLyt: ">=0.20.0 <0.21.0",
      contractVersion: "1.0.0",
    },
    versionMetadata: {
      skillVersion: "1.0.0",
      legacyLytVersion,
      legacySupportedThrough: "0.20.x",
      legacyRemovalContractMajor: 2,
    },
  }),
);
