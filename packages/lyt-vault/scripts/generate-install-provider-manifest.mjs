/* Copyright 2026 MARLINK TRADING SRL (YounndAI). Licensed under Apache-2.0. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { generateAgentManual } from "../dist/flows/agent-manual.js";

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
  objects.push({
    kind: "marker-file",
    runtime,
    content: generated.content,
    expected_digest: createHash("sha256").update(generated.content).digest("hex"),
    marker_begin: `<!-- lyt-manual v${generated.markerVersion} BEGIN -->`,
    marker_end: `<!-- lyt-manual v${generated.markerVersion} END -->`,
  });
}
writeFileSync(
  new URL("dist/install-provider-manifest.json", root),
  `${JSON.stringify({ schema_id: "lyt.target-provider-manifest", schema_version: { major: 1, minor: 0 }, package: packageJson.name, version: packageJson.version, objects }, null, 2)}\n`,
);
