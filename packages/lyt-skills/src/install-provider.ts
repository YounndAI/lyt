/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 * Licensed under the Apache License, Version 2.0.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { ALL_RUNTIMES, getBundledSkillsDir, listBundledSkills, type Runtime } from "./symlink.js";
import { listSkillsTriRuntime } from "./list.js";

export interface SkillsInstallProviderObjectV1 {
  readonly object_id: string;
  readonly kind: "directory-link";
  readonly provider_package: "@younndai/lyt-skills";
  readonly provider_version: string;
  readonly source_path: string;
  readonly target_path: string;
  readonly expected_digest: string;
  readonly trusted_legacy_digests: readonly string[];
}

export function buildSkillsInstallProviderObjectsV1(options: {
  version: string;
  homeDir?: string;
  runtimes?: readonly Runtime[];
  sourceDir?: string;
  detectedRuntimes: readonly Runtime[];
  digestTree(path: string): string;
}): readonly SkillsInstallProviderObjectV1[] {
  const home = options.homeDir ?? homedir();
  const sourceDir = options.sourceDir ?? getBundledSkillsDir();
  const requested = options.runtimes ?? ALL_RUNTIMES;
  const detected = new Set(options.detectedRuntimes);
  const compatibility = new Map(
    (
      listSkillsTriRuntime({ sourceDir, runtimes: [] }) as {
        skills: readonly { name: string; compatibility?: string }[];
      }
    ).skills.map((row) => [row.name, row.compatibility]),
  );
  return Object.freeze(
    requested
      .filter((runtime) => detected.has(runtime))
      .flatMap((runtime) =>
        [...listBundledSkills(sourceDir)].sort().map((skill) => {
          if (compatibility.get(skill) !== "compatible") {
            throw new Error("install-provider-incompatible-guidance");
          }
          const sourcePath = join(sourceDir, skill);
          return Object.freeze({
            object_id: `skill:${runtime}:${skill}`,
            kind: "directory-link" as const,
            provider_package: "@younndai/lyt-skills" as const,
            provider_version: options.version,
            source_path: sourcePath,
            target_path: join(home, `.${runtime}`, "skills", skill),
            expected_digest: options.digestTree(sourcePath),
            trusted_legacy_digests: Object.freeze([]),
          });
        }),
      ),
  );
}
