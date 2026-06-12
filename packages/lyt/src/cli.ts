#!/usr/bin/env node
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

import { createRequire } from "node:module";

import { Command } from "commander";

import { buildMcpSubcommand } from "@younndai/lyt-mcp";
import {
  buildCloneAllCommand,
  buildPodStatusCommand,
  buildSourceCommand,
  buildStatusCommand,
  buildSyncCommand,
} from "@younndai/lyt-mesh";
import { buildSkillsCommand } from "@younndai/lyt-skills";
import { registerVaultVerbs } from "@younndai/lyt-vault";

import {
  buildAgentManualCommand,
  buildDiscoverCommand,
  buildRepairCommand,
} from "@younndai/lyt-vault";

import { buildAutomatorRunSubcommand } from "./cli-automator-run.js";
import { buildBenchCommand } from "./commands/bench.js";
import { buildCaptureCommand } from "./commands/capture.js";
import { buildLytInitCommand } from "./commands/init.js";
import { buildPrimerCommand } from "./commands/primer.js";
import { buildReindexCommand } from "./commands/reindex.js";
import { buildSearchCommand } from "./commands/search.js";

const program = new Command();

program
  .name("lyt")
  .description(
    "Lyt — federated markdown-vault mesh CLI (vault + mesh + sync + mcp + help + doctor + pattern + machine + identity + audit + friction + provenance + capture-metric + automator)",
  )
  .version((createRequire(import.meta.url)("../package.json") as { version: string }).version);

// release review + block-A.3 Commit 11 — single source of truth for
// the @younndai/lyt-vault verb surface; sync / mcp are kept here because
// they live in separate workspaces.
//
// v1.B.1 delta: the meta CLI used to compose @younndai/lyt-mesh's
// `buildMeshSubcommand()` directly, but that registers a `mesh` parent
// that now collides with @younndai/lyt-vault's new v1.B.1 mesh command
// (init/join/list). Resolution: registerVaultVerbs registers the v1.B.1
// mesh parent (the canonical surface per master plan §5 v1.B.1); the
// surviving lyt-mesh subcommands (clone-all, source, status) are
// attached AFTER. The legacy lyt-mesh `init` subcommand (manifest-
// driven Phase 7D) is intentionally NOT re-attached — the v1.B.1 multi-
// mesh `mesh init <name>` supersedes it per master plan §5 (manifest-
// driven bulk init moves to v1.B.3).
//
// v1.C.1 delta: the legacy lyt-mesh `validate` subcommand (parent_vault
// FK dangling-check) is ALSO intentionally NOT re-attached — the v1.C.1
// `lyt mesh validate` (cross-mesh @MESH_EDGE walker, registered by
// registerVaultVerbs via commands/mesh.ts) supersedes it per master plan
// §v1.C.1:609 acceptance "lyt mesh validate warns on broken edges". The
// legacy parent_vault FK check is now repaired by v1.C.4 `lyt repair`
// per master plan §G-5:277 (validate = read-only / repair = write
// boundary). Same pattern as the v1.B.1 mesh-init supersession above.
// v1.C.4 ships `lyt repair` at the meta-CLI top level (federation-design
// §6:250 lists it next to `lyt init` + `lyt discover`).
//
// block-B Commit 7 delta: same composition shape applies to `automator`.
// registerVaultVerbs registers the v1 automator parent with list/log/status
// subcommands (lyt-vault has no lyt-runner dep). The meta CLI attaches `run`
// here, because runFiveStep + the metadata-filler body live in packages that
// depend on lyt-vault — registering them inside lyt-vault would create a
// cycle. Mirror of the lyt-mesh subcommand attach pattern above.
registerVaultVerbs(program);
const meshCmd = program.commands.find((c) => c.name() === "mesh");
if (meshCmd === undefined) {
  throw new Error(
    "@younndai/lyt meta CLI: expected registerVaultVerbs to register a 'mesh' command but none was found.",
  );
}
meshCmd.addCommand(buildCloneAllCommand());
meshCmd.addCommand(buildSourceCommand());
meshCmd.addCommand(buildStatusCommand());

const automatorCmd = program.commands.find((c) => c.name() === "automator");
if (automatorCmd === undefined) {
  throw new Error(
    "@younndai/lyt meta CLI: expected registerVaultVerbs to register an 'automator' command but none was found.",
  );
}
automatorCmd.addCommand(buildAutomatorRunSubcommand());

program.addCommand(buildSyncCommand());
// Brief B (B.4) — `lyt status`: top-level publish-drift trust surface (per-vault
// + pod unpushed/no-remote/clean). Distinct from `lyt mesh status` (the
// mesh-graph renderer attached under `mesh` above): different scope, different
// answer ("is my stuff published?" vs "what's the federation topology?").
program.addCommand(buildPodStatusCommand());
program.addCommand(buildMcpSubcommand());

// v1.D.3b — `lyt search` lives at the meta-CLI level per master-plan
// §v1.D.3:785 wording "lyt search" (no `vault` subcommand). The
// default scope is federation; placing it under `vault` would tilt
// user mental model toward single-vault use. The cascade engine
// itself lives in @younndai/lyt-vault (data-layer ownership); the
// command builder here is the CLI-surface adapter.
program.addCommand(buildSearchCommand());

// V-C-1 Phase E / V-C-2 — `lyt capture "<text>"`: the frictionless top-level
// alias for `pattern run knowledge-capture capture` the wizard advertises.
// True alias (same ceremony: mandatory purpose+topic, 8-field contract) +
// index-on-write so a capture is searchable immediately. Top-level like
// search/primer/reindex; the flow lives in @younndai/lyt-vault.
program.addCommand(buildCaptureCommand());

// v1.D.4 — `lyt primer` mirrors the meta-CLI posture of `lyt search`.
// Same rationale: the verb operates at vault | mesh | federation scope
// per master-plan §v1.D.4:832; placing it under `vault` would tilt
// mental model. The generator flow lives in @younndai/lyt-vault; the
// command builder here is the CLI-surface adapter.
program.addCommand(buildPrimerCommand());

// Lane V Phase 0 (0.5 / CLI gaps C1+C2) — `lyt reindex [--all|--mesh|--vault]`
// rebuilds all content-tier caches (lanes+arcs+fts+rollup) across the pod, a
// mesh, or one vault. Top-level (like search/primer) because its mental model
// is pod-wide. The reindexFlow lives in @younndai/lyt-vault (data-layer
// ownership); this is the CLI-surface adapter.
program.addCommand(buildReindexCommand());

// Lane V Workstream 2 — `lyt bench`: privacy-trivial retrieval self-test over a
// synthetic temp pod (never the user's ~/lyt). Top-level like search/primer/
// reindex. The harness lives in ./bench (productized from tools/lane-v, which is
// dev-only and not shipped); this is the CLI-surface adapter.
program.addCommand(buildBenchCommand());

// v1.B.4 — `lyt init` lives at the meta-CLI top level per OD-1 default +
// master-plan §v1.B.4:543 + federation-design §5:248. Composes
// meshInitFlow + federationInitFlow into idempotent bootstrap with
// three branches (fresh / re-init / discovery) + `--auto` default.
program.addCommand(buildLytInitCommand());

// v1.C.3 — `lyt discover` lives at the meta-CLI top level per OD-1 default +
// federation-design §6:249 (lists `lyt discover` next to `lyt init`).
// Read-only walk of GH-accessible repos; clusters discovered Lyt vaults
// by @VAULT_HOME_MESH.mesh_name; per-cluster orphan-recovery prompt
// (adopt / external / skip) ships in Commit 3. Mirror lyt search / lyt
// primer / lyt init top-level attach pattern.
program.addCommand(buildDiscoverCommand());

// v1.C.4 — `lyt repair` lives at the meta-CLI top level per OD-1 default +
// federation-design §6:250 (lists `lyt repair` next to `lyt init` +
// `lyt discover`). Default mode is --dry-run; --apply performs writes
// across the 4 federation-design §11:515-521 failure classes (broken
// @MESH_EDGE, broken @MESH_SUBSCRIPTION, mesh.yon parse error → restore
// from Git, orphan vault re-attach). G-5 contract LOCK: this is the
// write side of validate = read-only / repair = write per master-plan
// §G-5:277.
program.addCommand(buildRepairCommand());

// v1.F.3 — `lyt skills` lives at the meta-CLI top level per OD-2 default +
// master-plan §v1.F.3:1033 verb wording ("lyt skills install"). Composes
// symlinkSkillsTriRuntime + listSkillsTriRuntime into the symlink + runtime-
// state-reporting surface for the 10 bundled skills across ~/.claude/skills,
// ~/.codex/skills, ~/.agents/skills. Per OD-5 + OD-16 ratified 2026-06-01,
// the legacy standalone `lyt-skills` bin + copy-based `installSkills` flow
// were removed in the same phase (pre-release clean slate).
program.addCommand(buildSkillsCommand());

// v1.G.5 — `lyt agent-manual --runtime {claude|codex|agents|generic}
// [--install] [--dry-run]` at the meta-CLI top level. Mirrors the
// discover / repair / skills attach pattern above. Generates the Lyt
// agent manual (~150 lines / ~1.5K tokens) and writes it (or previews
// it) into agent-runtime global instructions files via the
// `<!-- lyt-manual v<lyt-version> BEGIN -->...END -->` marker pattern
// (D9 update-path primitive per the ratified default ratified 2026-06-01).
program.addCommand(buildAgentManualCommand());

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`lyt: ${message}`);
  process.exit(1);
});
