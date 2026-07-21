/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 * Licensed under the Apache License, Version 2.0.
 */

import { homedir } from "node:os";
import { buildVaultInstallProviderObjectsV1, detectInstalledRuntimes } from "@younndai/lyt-vault";
import {
  ALL_RUNTIMES,
  buildSkillsInstallProviderObjectsV1,
  getBundledSkillsDir,
  type Runtime,
} from "@younndai/lyt-skills";

import { digestPathTree, readPackageVersion } from "./reconcile-engine.js";
import { UPDATE_PLAN_PACKAGES, type UpdatePackageName } from "./update-plan.js";

export interface InstallProviderV1 {
  readonly schema_id: "lyt.install-provider";
  readonly schema_version: Readonly<{ major: 1; minor: 0 }>;
  readonly package: UpdatePackageName;
  readonly version: string;
  readonly objects: readonly InstallableProviderObjectV1[];
}

export type InstallableProviderObjectV1 =
  | Readonly<{
      object_id: string;
      kind: "directory-link";
      provider_package: "@younndai/lyt-skills";
      provider_version: string;
      source_path: string;
      target_path: string;
      expected_digest: string;
      trusted_legacy_digests: readonly string[];
    }>
  | Readonly<{
      object_id: string;
      kind: "marker-file";
      provider_package: "@younndai/lyt-vault";
      provider_version: string;
      target_path: string;
      content: string;
      expected_digest: string;
      marker_begin: string;
      marker_end: string;
      trusted_legacy_digests: readonly string[];
    }>;

export interface BuildProviderInventoryOptions {
  readonly homeDir?: string;
  readonly runtimes?: readonly Runtime[];
  readonly skillsSourceDir?: string;
}

export async function buildInstallProviderInventoryV1(
  options: BuildProviderInventoryOptions = {},
): Promise<readonly InstallProviderV1[]> {
  const home = options.homeDir ?? homedir();
  const skillsSource = options.skillsSourceDir ?? getBundledSkillsDir();
  const skillsVersion = readPackageVersion("@younndai/lyt-skills");
  const vaultVersion = readPackageVersion("@younndai/lyt-vault");
  const requestedRuntimes = options.runtimes ?? ALL_RUNTIMES;
  const detectedRuntimes = detectInstalledRuntimes(home) as readonly Runtime[];
  const skillObjects = buildSkillsInstallProviderObjectsV1({
    version: skillsVersion,
    homeDir: home,
    runtimes: requestedRuntimes,
    sourceDir: skillsSource,
    detectedRuntimes,
    digestTree: digestPathTree,
  });
  const manualObjects = await buildVaultInstallProviderObjectsV1({
    version: vaultVersion,
    homeDir: home,
    runtimes: requestedRuntimes,
    skillsDir: skillsSource,
  });

  const owned = new Map<UpdatePackageName, InstallProviderV1>([
    [
      "@younndai/lyt-skills",
      Object.freeze({
        schema_id: "lyt.install-provider" as const,
        schema_version: Object.freeze({ major: 1 as const, minor: 0 as const }),
        package: "@younndai/lyt-skills" as const,
        version: skillsVersion,
        objects: Object.freeze(skillObjects),
      }),
    ],
    [
      "@younndai/lyt-vault",
      Object.freeze({
        schema_id: "lyt.install-provider" as const,
        schema_version: Object.freeze({ major: 1 as const, minor: 0 as const }),
        package: "@younndai/lyt-vault" as const,
        version: vaultVersion,
        objects: Object.freeze(manualObjects),
      }),
    ],
  ]);
  return Object.freeze(
    UPDATE_PLAN_PACKAGES.map(
      (packageName) =>
        owned.get(packageName) ??
        Object.freeze({
          schema_id: "lyt.install-provider" as const,
          schema_version: Object.freeze({ major: 1 as const, minor: 0 as const }),
          package: packageName,
          version: readPackageVersion(packageName),
          objects: Object.freeze([]),
        }),
    ),
  );
}
