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
import { createInterface } from "node:readline/promises";

import {
  BranchVsSoloPromptRequiredError,
  MoveMainVaultForbiddenError,
  MoveSameMeshError,
  MoveTargetMeshNotFoundError,
  MoveVaultNotFoundError,
  moveVaultFlow,
  type MoveVaultMode,
} from "../flows/move.js";
import { vaultLeaf } from "../registry/vault-addressing.js";

// v1.B.3 Commit 2 — `lyt vault move <name> --to-mesh <mesh> [--solo|--branch] [--json]`.
//
// Branch-vs-solo prompt: when neither --solo nor --branch is set AND the
// flow surfaces BranchVsSoloPromptRequiredError, the CLI prompts via
// Node's built-in readline/promises. Under --json the prompt is skipped
// (operator must supply --solo or --branch explicitly) and the structured
// error surfaces with exit code 3 — matches the v1.D.* / v1.B.2 pattern
// of "no-interactivity-under-json".
//
// Brief-text imprecision (D-pre-3): brief said @inquirer/prompts was a
// current dep; verified package.json — NOT installed. readline/promises
// has a precedent at commands/init.ts:2-3 for --ask-description. Using
// it here keeps the dep surface clean.

interface MoveCliOpts {
  toMesh?: string;
  solo?: boolean;
  branch?: boolean;
  json?: boolean;
}

export function buildMoveCommand(): Command {
  return new Command("move")
    .description(
      "Relocate a vault to a different mesh. Rid stable; mesh.yon files atomically updated. Branch-vs-solo prompt fires when the vault has children (use --solo or --branch to bypass; --json refuses to prompt and exits 3 if neither flag set).",
    )
    .argument("<name>", "Vault name (e.g., 'alex/lyt')")
    .requiredOption("--to-mesh <name>", "Target mesh (must be registered locally)")
    .option(
      "--solo",
      "When the vault has children (@MESH_EDGE rows pointing at it), DROP the child edges (cold-warn surfaced).",
    )
    .option(
      "--branch",
      "When the vault has children, RE-ROOT the child edges to the target mesh (default if neither flag set + no children).",
    )
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (name: string, opts: MoveCliOpts) => {
      if (opts.solo === true && opts.branch === true) {
        const body = {
          error: "move-mode-conflict",
          message: "lyt vault move: --solo and --branch are mutually exclusive.",
        };
        emitError(opts.json === true, body);
        process.exitCode = 2;
        return;
      }
      const explicitMode: MoveVaultMode =
        opts.solo === true ? "solo" : opts.branch === true ? "branch" : "prompt";

      try {
        const result = await tryMoveWithPrompt({
          vaultName: name,
          toMeshName: opts.toMesh!,
          mode: explicitMode,
          json: opts.json === true,
        });
        if (result === null) return; // user bailed at the prompt

        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        // 0.9.4 (3d) — only claim a clean success when the read-back verified
        // the committed state; otherwise append the unverified note.
        const moveSuffix =
          result.committed === "verified" ? "" : ` ${result.unverifiedNote ?? "(unverified)"}`;
        // 0.9.4 nit — print the COMPUTED display name (`{newMesh}/{leaf}`),
        // matching `vault list`, NOT the stale stored name (whose prefix still
        // carries the old mesh until the next reconcile).
        const displayName = `${result.toMeshName}/${vaultLeaf(result.vaultName)}`;
        // eslint-disable-next-line no-console
        console.log(`Moved vault '${displayName}' to mesh '${result.toMeshName}'${moveSuffix}`);
        // eslint-disable-next-line no-console
        console.log(`  rid:     vault:${result.vaultRidHex} (stable)`);
        // eslint-disable-next-line no-console
        console.log(`  from:    mesh '${result.fromMeshName}'`);
        // eslint-disable-next-line no-console
        console.log(`  to:      mesh '${result.toMeshName}'`);
        // eslint-disable-next-line no-console
        console.log(`  mode:    ${result.mode}`);
        if (result.childEdgesReRooted.length > 0) {
          // eslint-disable-next-line no-console
          console.log(
            `  edges:   re-rooted ${result.childEdgesReRooted.length} child edge${result.childEdgesReRooted.length === 1 ? "" : "s"}`,
          );
        }
        if (result.childEdgesDropped.length > 0) {
          // eslint-disable-next-line no-console
          console.warn(
            `  warn:    dropped ${result.childEdgesDropped.length} child edge${result.childEdgesDropped.length === 1 ? "" : "s"} (--solo)`,
          );
        }
      } catch (err) {
        const status = mapErrorToExitCode(err);
        if (status !== null) {
          const body = errorToJsonBody(err);
          emitError(opts.json === true, body);
          process.exitCode = status;
          return;
        }
        throw err;
      }
    });
}

interface TryMoveArgs {
  vaultName: string;
  toMeshName: string;
  mode: MoveVaultMode;
  json: boolean;
}

async function tryMoveWithPrompt(
  args: TryMoveArgs,
): Promise<Awaited<ReturnType<typeof moveVaultFlow>> | null> {
  try {
    return await moveVaultFlow({
      vaultName: args.vaultName,
      toMeshName: args.toMeshName,
      mode: args.mode,
    });
  } catch (err) {
    if (err instanceof BranchVsSoloPromptRequiredError) {
      if (args.json === true) {
        // --json: refuse to prompt; surface structured error + exit 3.
        emitError(true, {
          error: err.errorCode,
          child_edge_count: err.childEdgeCount,
          message: err.message,
        });
        process.exitCode = 3;
        return null;
      }
      // Interactive prompt.
      const choice = await promptBranchVsSolo(err.childEdgeCount);
      if (choice === null) {
        // User bailed.
        // eslint-disable-next-line no-console
        console.error("lyt vault move: aborted at prompt.");
        process.exitCode = 130; // 128 + SIGINT convention; non-zero = abort
        return null;
      }
      return await moveVaultFlow({
        vaultName: args.vaultName,
        toMeshName: args.toMeshName,
        mode: choice,
      });
    }
    throw err;
  }
}

async function promptBranchVsSolo(childCount: number): Promise<"branch" | "solo" | null> {
  if (process.stdin.isTTY !== true) {
    // Non-TTY: can't prompt. Treat as solo-with-warning-default? No —
    // safer to abort so the operator runs again with an explicit flag.
    // eslint-disable-next-line no-console
    console.error(
      `lyt vault move: vault has ${childCount} child edge${childCount === 1 ? "" : "s"} but stdin is not a TTY. Re-run with --solo or --branch.`,
    );
    return null;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // eslint-disable-next-line no-console
    console.log(
      `Vault has ${childCount} child @MESH_EDGE row${childCount === 1 ? "" : "s"} pointing at it.`,
    );
    const answer = (
      await rl.question(
        "Move children with it? [B]ranch (re-root edges) / [s]olo (drop edges) / [a]bort: ",
      )
    )
      .trim()
      .toLowerCase();
    if (answer === "" || answer === "b" || answer === "branch") return "branch";
    if (answer === "s" || answer === "solo") return "solo";
    return null;
  } finally {
    rl.close();
  }
}

function mapErrorToExitCode(err: unknown): number | null {
  if (err instanceof MoveVaultNotFoundError) return 2;
  if (err instanceof MoveTargetMeshNotFoundError) return 2;
  if (err instanceof MoveSameMeshError) return 2;
  if (err instanceof MoveMainVaultForbiddenError) return 2;
  return null;
}

function errorToJsonBody(err: unknown): Record<string, unknown> {
  if (err instanceof MoveVaultNotFoundError) {
    return { error: err.errorCode, vault_name: err.vaultName, message: err.message };
  }
  if (err instanceof MoveTargetMeshNotFoundError) {
    return { error: err.errorCode, mesh_name: err.meshName, message: err.message };
  }
  if (err instanceof MoveSameMeshError) {
    return { error: err.errorCode, message: err.message };
  }
  if (err instanceof MoveMainVaultForbiddenError) {
    return { error: err.errorCode, message: err.message };
  }
  return { error: "unknown", message: err instanceof Error ? err.message : String(err) };
}

function emitError(json: boolean, body: Record<string, unknown>): void {
  if (json) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(body, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.error(`lyt vault move: ${String(body["message"] ?? body["error"])}`);
  }
}
