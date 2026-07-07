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

// The `lyt` meta-CLI command-tree assembly, extracted from cli.ts (Inc1 Phase 0
// gate 2) so the FULLY-COMPOSED program can be introspected by the surface-parity
// conformance test WITHOUT triggering `parseAsync` on import. cli.ts is now a thin
// bin that only does `buildProgram().parseAsync(process.argv)`. All command
// registration lives HERE — a new op reaches the CLI by being added in buildProgram,
// which the parity test then checks against the capability manifest.

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
import {
  registerVaultVerbs,
  buildAgentManualCommand,
  buildDiscoverCommand,
  buildRepairCommand,
} from "@younndai/lyt-vault";

import { buildAutomatorRunSubcommand } from "./cli-automator-run.js";
import { buildBackfillCommand } from "./commands/backfill.js";
import { buildBenchCommand } from "./commands/bench.js";
import { buildCaptureCommand } from "./commands/capture.js";
import { buildContractCommand } from "./commands/contract.js";
import { buildLytInitCommand } from "./commands/init.js";
import { buildModelCommand } from "./commands/model.js";
import { buildOutdatedCommand } from "./commands/outdated.js";
import { buildPrimerCommand } from "./commands/primer.js";
import { buildReconcileCommand } from "./commands/reconcile.js";
import { buildReindexCommand } from "./commands/reindex.js";
import { buildSearchCommand } from "./commands/search.js";
import { buildUndoCommand } from "./commands/undo.js";
import { buildUpdateCommand } from "./commands/update.js";

/**
 * Assemble the full `lyt` meta-CLI command tree WITHOUT parsing argv. Pure +
 * side-effect-free (safe to import from a test); the caller (cli.ts) drives argv
 * into `.parseAsync()`. The composition rationale for each attach point is inline.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("lyt")
    .description(
      "Lyt — federated markdown-vault mesh CLI (vault + mesh + sync + mcp + help + doctor + pattern + machine + identity + audit + provenance + capture-metric + automator)",
    )
    .version((createRequire(import.meta.url)("../package.json") as { version: string }).version);

  // release review + block-A.3 Commit 11 — single source of truth for
  // the @younndai/lyt-vault verb surface; sync / mcp are kept here because
  // they live in separate workspaces.
  //
  // v1.B.1 delta: registerVaultVerbs registers the v1.B.1 mesh parent (the
  // canonical surface per master plan §5); the surviving lyt-mesh subcommands
  // (clone-all, source, status) are attached AFTER. The legacy lyt-mesh `init`
  // + `validate` subcommands are intentionally NOT re-attached — superseded by
  // the v1.B.1 `mesh init` + v1.C.1 `mesh validate` (repair = write side per G-5).
  //
  // block-B Commit 7 delta: same composition shape applies to `automator` — the
  // meta CLI attaches `run` here (runFiveStep + metadata-filler depend on
  // lyt-vault, so registering inside lyt-vault would cycle).
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

  // Phase D (0.10.0 frontmatter-contract lane) — attach the frontmatter heal verbs
  // to the lyt-vault-registered `vault` parent HERE (not in lyt-vault's
  // buildVaultSubcommand) because both run the metadata-filler automator body /
  // reindex, which pull in lyt-runner — registering them inside lyt-vault would
  // cycle. Same attach-to-a-registered-parent pattern as `automator run` above.
  const vaultCmd = program.commands.find((c) => c.name() === "vault");
  if (vaultCmd === undefined) {
    throw new Error(
      "@younndai/lyt meta CLI: expected registerVaultVerbs to register a 'vault' command but none was found.",
    );
  }
  vaultCmd.addCommand(buildBackfillCommand());
  vaultCmd.addCommand(buildReconcileCommand());

  program.addCommand(buildSyncCommand());
  // Brief B (B.4) — `lyt status`: top-level publish-drift trust surface (per-vault
  // + pod unpushed/no-remote/clean). Distinct from `lyt mesh status`.
  program.addCommand(buildPodStatusCommand());
  program.addCommand(buildMcpSubcommand());

  // v1.D.3b — `lyt search` at the meta-CLI level (default scope federation; under
  // `vault` would tilt the mental model to single-vault). Cascade engine lives in
  // lyt-vault; this is the CLI-surface adapter. Same top-level rationale applies to
  // capture / contract / primer / reindex / model / bench below.
  program.addCommand(buildSearchCommand());
  program.addCommand(buildCaptureCommand());
  // Increment 1 · A.3 — `lyt undo` (the mechanical-first reverse of capture).
  // CLI-only for now; joins the parity manifest with the Phase-B MCP undo tool.
  program.addCommand(buildUndoCommand());
  program.addCommand(buildContractCommand());
  program.addCommand(buildPrimerCommand());
  program.addCommand(buildReindexCommand());
  program.addCommand(buildModelCommand());
  program.addCommand(buildBenchCommand());
  // 0.11.0 stay-current (from integrate/0.11.0) — `lyt outdated` (read-only check
  // vs the published alpha) + `lyt update` (confirmation-gated global install).
  // Registered HERE (build-program.ts), not the old cli.ts, per the A.3 refactor
  // that moved registration off the thin cli entrypoint (integration reconcile).
  program.addCommand(buildOutdatedCommand());
  program.addCommand(buildUpdateCommand());

  // v1.B.4 / v1.C.3 / v1.C.4 — `lyt init` | `discover` | `repair` at the meta-CLI
  // top level per federation-design §5-6 (init composes mesh+federation bootstrap;
  // discover is a read-only GH walk; repair is the write side of validate/repair).
  program.addCommand(buildLytInitCommand());
  program.addCommand(buildDiscoverCommand());
  program.addCommand(buildRepairCommand());

  // v1.F.3 / v1.G.5 — `lyt skills` | `agent-manual` at the meta-CLI top level
  // (skills = tri-runtime symlink surface; agent-manual = the ~150-line manual
  // written via the versioned marker pattern).
  program.addCommand(buildSkillsCommand());
  program.addCommand(buildAgentManualCommand());

  return program;
}
