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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { major, minVersion, satisfies, valid, validRange } from "semver";

export const SUPPORTED_GUIDANCE_CONTRACT_MAJOR = 1;

export type SkillCompatibilityStatus = "compatible" | "compatibility-unknown" | "refused";

export type SkillCompatibilityRefusalCode =
  "invalid-guidance-metadata" | "unsupported-contract-major" | "unsatisfied-lyt-range";

export type SkillCompatibilityNextActionCode = "update-lyt" | "reconcile-skills";

export interface SkillCompatibilityNextAction {
  code: SkillCompatibilityNextActionCode;
  command: "lyt update" | "lyt skills install";
}

export interface SkillCompatibilityRefusal {
  code: SkillCompatibilityRefusalCode;
  message: string;
  nextAction: SkillCompatibilityNextAction;
}

export interface SkillMetadata {
  skillVersion: string | null;
  requiresLyt: string | null;
  contractVersion: string | null;
  lytVersion: string | null;
  compatibility: SkillCompatibilityStatus;
  refusal: SkillCompatibilityRefusal | null;
}

export type SkillMetadataReader = (skillMdPath: string) => SkillMetadata;

const PACKAGE_JSON_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");

export function getInstalledLytVersion(): string {
  return readPackageVersion(PACKAGE_JSON_PATH);
}

export function readSkillMetadata(skillMdPath: string): SkillMetadata {
  return readSkillMetadataForVersion(skillMdPath, getInstalledLytVersion());
}

export function createSkillMetadataReaderForPackageRoot(packageRoot: string): SkillMetadataReader {
  const installedLytVersion = readPackageVersion(resolve(packageRoot, "package.json"));
  return (skillMdPath) => readSkillMetadataForVersion(skillMdPath, installedLytVersion);
}

function readPackageVersion(packageJsonPath: string): string {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== "string" || valid(packageJson.version) === null) {
    throw new Error("@younndai/lyt-skills package.json has no valid semver version");
  }
  return packageJson.version;
}

function readSkillMetadataForVersion(
  skillMdPath: string,
  installedLytVersion: string,
): SkillMetadata {
  const fields = readFrontmatterFields(skillMdPath);
  const skillVersion = fields.get("skill-version") ?? null;
  const requiresLyt = fields.get("requires-lyt") ?? null;
  const contractVersion = fields.get("contract-version") ?? null;
  const lytVersion = fields.get("lyt-version") ?? null;
  const declared = [skillVersion, requiresLyt, contractVersion].filter(
    (value) => value !== null,
  ).length;

  if (declared === 0) {
    if (lytVersion === null || lytVersion.trim() === "" || valid(lytVersion) === null) {
      return refused(
        { skillVersion, requiresLyt, contractVersion, lytVersion },
        "invalid-guidance-metadata",
        "Skill compatibility metadata is missing.",
        reconcileSkills(),
      );
    }
    return {
      skillVersion,
      requiresLyt,
      contractVersion,
      lytVersion,
      compatibility: "compatibility-unknown",
      refusal: null,
    };
  }

  if (
    skillVersion === null ||
    skillVersion.trim() === "" ||
    requiresLyt === null ||
    requiresLyt.trim() === "" ||
    contractVersion === null ||
    contractVersion.trim() === "" ||
    valid(skillVersion) === null ||
    validRange(requiresLyt) === null ||
    valid(contractVersion) === null ||
    (lytVersion !== null && (lytVersion.trim() === "" || valid(lytVersion) === null)) ||
    valid(installedLytVersion) === null
  ) {
    return refused(
      { skillVersion, requiresLyt, contractVersion, lytVersion },
      "invalid-guidance-metadata",
      "Skill compatibility metadata is incomplete or invalid.",
      reconcileSkills(),
    );
  }

  if (major(contractVersion) !== SUPPORTED_GUIDANCE_CONTRACT_MAJOR) {
    return refused(
      { skillVersion, requiresLyt, contractVersion, lytVersion },
      "unsupported-contract-major",
      `Skill contract ${contractVersion} is not supported by this Lyt installation.`,
      updateLyt(),
    );
  }

  if (!satisfies(installedLytVersion, requiresLyt)) {
    const minimum = minVersion(requiresLyt);
    const nextAction =
      minimum !== null && minimum.compare(installedLytVersion) > 0
        ? updateLyt()
        : reconcileSkills();
    return refused(
      { skillVersion, requiresLyt, contractVersion, lytVersion },
      "unsatisfied-lyt-range",
      `Installed Lyt ${installedLytVersion} does not satisfy ${requiresLyt}.`,
      nextAction,
    );
  }

  return {
    skillVersion,
    requiresLyt,
    contractVersion,
    lytVersion,
    compatibility: "compatible",
    refusal: null,
  };
}

function readFrontmatterFields(skillMdPath: string): ReadonlyMap<string, string> {
  if (!existsSync(skillMdPath)) return new Map();
  const md = readFileSync(skillMdPath, "utf8");
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return new Map();

  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = line.match(/^([a-z][a-z0-9-]*):\s*(.*?)\s*$/);
    if (!field) continue;
    fields.set(field[1]!, unquote(field[2]!));
  }
  return fields;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function refused(
  metadata: Pick<SkillMetadata, "skillVersion" | "requiresLyt" | "contractVersion" | "lytVersion">,
  code: SkillCompatibilityRefusalCode,
  message: string,
  nextAction: SkillCompatibilityNextAction,
): SkillMetadata {
  return {
    ...metadata,
    compatibility: "refused",
    refusal: { code, message, nextAction },
  };
}

function updateLyt(): SkillCompatibilityNextAction {
  return { code: "update-lyt", command: "lyt update" };
}

function reconcileSkills(): SkillCompatibilityNextAction {
  return { code: "reconcile-skills", command: "lyt skills install" };
}
