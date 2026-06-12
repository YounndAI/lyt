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

import { Command } from "commander";

import { podStatusFlow, type PodStatusResult } from "../flows/pod-status.js";

// Brief B (D31 §5, B.4) — `lyt status`: the top-level publish-drift TRUST
// surface. Distinct verb from `lyt mesh status` (the mesh-graph renderer): this
// answers "is my stuff published / safe?" per vault + pod. Read-only.
export function buildPodStatusCommand(): Command {
  const cmd = new Command("status");
  cmd
    .description(
      "Show pod + per-vault publish drift (unpushed / no-remote / stale-index / clean). Read-only trust surface; run `lyt sync` to resolve drift.",
    )
    .option("--json", "Emit JSON instead of human-readable output.")
    .option("--no-fetch", "Skip `git fetch` (faster; ahead counts may be stale).")
    .action(async (opts: { json?: boolean; fetch?: boolean }) => {
      const result = await podStatusFlow({ noFetch: opts.fetch === false });
      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.ok ? 0 : 1);
      }
      printStatusHuman(result);
      process.exit(result.ok ? 0 : 1);
    });
  return cmd;
}

function printStatusHuman(r: PodStatusResult): void {
  // Pod line.
  const podGlyph = r.pod.status === "clean" || r.pod.status === "no-pod" ? "✓" : "⚠";
  // eslint-disable-next-line no-console
  console.log(
    `${podGlyph} pod${r.pod.handle ? ` (${r.pod.handle}/lyt-pod)` : ""}: ${r.pod.status} — ${r.pod.detail}`,
  );

  if (r.vaults.length === 0) {
    // eslint-disable-next-line no-console
    console.log("  (no vaults registered — run `lyt init`)");
  }
  for (const v of r.vaults) {
    const glyph = v.status === "clean" ? "✓" : "⚠";
    // eslint-disable-next-line no-console
    console.log(`  ${glyph} ${v.status.padEnd(13)} ${v.name}: ${v.detail}`);
  }

  for (const u of r.unregistered) {
    // eslint-disable-next-line no-console
    console.log(`  ⚠ unregistered  ${u} (on disk, not in the registry — \`lyt vault adopt\`)`);
  }

  // Summary.
  if (r.ok) {
    // eslint-disable-next-line no-console
    console.log(`\nAll published + clean (${r.summary.clean}/${r.summary.total} vault(s)).`);
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `\n${r.summary.needsPublish} vault(s) need publishing — run \`lyt sync\` to publish your pod to GitHub.`,
    );
  }
}
