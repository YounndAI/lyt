/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 * Licensed under the Apache License, Version 2.0.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";

import {
  detectInstalledRuntimes,
  generateAgentManual,
  resolveRuntimeDestination,
  type AgentManualRuntime,
} from "./flows/agent-manual.js";

export interface VaultInstallProviderObjectV1 {
  readonly object_id: string;
  readonly kind: "marker-file";
  readonly provider_package: "@younndai/lyt-vault";
  readonly provider_version: string;
  readonly target_path: string;
  readonly content: string;
  readonly expected_digest: string;
  readonly marker_begin: string;
  readonly marker_end: string;
  readonly trusted_legacy_digests: readonly string[];
}

export async function buildVaultInstallProviderObjectsV1(options: {
  version: string;
  homeDir?: string;
  runtimes: readonly Exclude<AgentManualRuntime, "generic">[];
  skillsDir: string;
}): Promise<readonly VaultInstallProviderObjectV1[]> {
  const home = options.homeDir ?? homedir();
  const detected = new Set(detectInstalledRuntimes(home));
  const objects: VaultInstallProviderObjectV1[] = [];
  for (const runtime of options.runtimes.filter((candidate) => detected.has(candidate))) {
    const generated = await generateAgentManual({
      runtime,
      install: true,
      dryRun: true,
      homedirOverride: home,
      skillsDirOverride: options.skillsDir,
    });
    const target = resolveRuntimeDestination(runtime, home);
    if (target === null) continue;
    objects.push(
      Object.freeze({
        object_id: `manual:${runtime}`,
        kind: "marker-file",
        provider_package: "@younndai/lyt-vault",
        provider_version: options.version,
        target_path: target,
        content: generated.content,
        expected_digest: createHash("sha256").update(generated.content, "utf8").digest("hex"),
        marker_begin: `<!-- lyt-manual v${generated.markerVersion} BEGIN -->`,
        marker_end: `<!-- lyt-manual v${generated.markerVersion} END -->`,
        trusted_legacy_digests: Object.freeze([]),
      }),
    );
  }
  return Object.freeze(objects);
}
