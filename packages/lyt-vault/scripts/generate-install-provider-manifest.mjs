/* Copyright 2026 MARLINK TRADING SRL (YounndAI). Licensed under Apache-2.0. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { generateAgentManual } from "../dist/flows/agent-manual.js";
import { inspectManagedManualMarker } from "../dist/flows/agent-guidance.js";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const skillsDir = fileURLToPath(new URL("../../lyt-skills/skills/", import.meta.url));
const objects = [];
for (const runtime of ["agents", "claude", "codex"]) {
  const generated = await generateAgentManual({
    runtime,
    install: true,
    dryRun: true,
    versionOverride: packageJson.version,
    homedirOverride: fileURLToPath(new URL("../.provider-manifest-home/", root)),
    skillsDirOverride: skillsDir,
  });
  const marker = inspectManagedManualMarker(generated.content);
  if (marker.status !== "exact") {
    throw new Error("install-provider-generated-manual-marker-invalid");
  }
  objects.push({
    kind: "marker-file",
    runtime,
    content: generated.content,
    expected_digest: marker.digest,
    marker_begin: marker.markerBegin,
    marker_end: marker.markerEnd,
  });
}
writeFileSync(
  new URL("dist/install-provider-manifest.json", root),
  `${JSON.stringify({ schema_id: "lyt.target-provider-manifest", schema_version: { major: 1, minor: 0 }, package: packageJson.name, version: packageJson.version, objects }, null, 2)}\n`,
);
