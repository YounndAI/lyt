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

// v1.B.4 — `lyt init [--auto | --custom | --discover] [--json]`.
//
// Top-level meta-CLI verb per the ratified default + master-plan §v1.B.4:543.
// Composes the v1.B.4 initBootstrapFlow with mutually-exclusive flag
// validation + structured-error contract + readline/promises three-prompt
// walkthrough under --custom.
//
// Source: brief 2026-05-31-v1-b-4-lyt-init-bootstrap.md "What's to ship"
// Commit 1 + federation-design §5:228-234 (custom-init prompts) +
// commands/move.ts (closest CLI shape — readline/promises + mutually-
// exclusive flag validation + structured-error contract).
//
// Error contract (+ brief acceptance):
// --auto + --custom together → exit 2 + flag-conflict
// --custom under non-TTY (incl. --json) → exit 3 + custom-requires-tty
// re-init with ALL-failed integrity → exit 1 (matches v1.B.2 )
// otherwise → exit 0

import { Command } from "commander";
import { createInterface } from "node:readline/promises";

import {
  getHandleFromIdentity,
  materializePodLocal,
  readIdentityCache,
  reconcilePublishFlow,
  ReadlinePromptHandler,
  renderNextSteps,
  renderPodCard,
  runWizard,
  startSpinner,
  validateMeshName,
  type IPromptHandler,
  type PhaseSpinnerHandle,
  type PodCardData,
  type SpinnerOp,
} from "@younndai/lyt-vault";

import {
  initBootstrapFlow,
  probeFreshState,
  resolveLocalFirst,
  type InitBootstrapArgs,
  type InitBootstrapCustomOverrides,
  type InitBootstrapMode,
  type InitBootstrapResult,
} from "../flows/init-bootstrap.js";
import { healPod, summarizeHeal } from "../flows/heal.js";

interface LytInitCliOpts {
  auto?: boolean;
  custom?: boolean;
  discover?: boolean;
  wizard?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export function buildLytInitCommand(): Command {
  return new Command("init")
    .description(
      "First-init (no mesh registered): enters guided setup wizard. Re-init (mesh exists): idempotent bootstrap (use --auto to force non-interactive). Flags: --auto (force bootstrap), --custom (3-prompt walkthrough), --discover (read-only GH delta), --wizard (force wizard), --dry-run (with --wizard only), --json.",
    )
    .option("--auto", "Force non-interactive bootstrap (skips first-init wizard auto-route)")
    .option("--custom", "Three-prompt walkthrough; conflicts with --auto; requires a TTY")
    .option(
      "--discover",
      "Read-only GH delta; surface accessible lyt-* repos not in local registry",
    )
    .option(
      "--wizard",
      "Force the 12-phase setup wizard (detect/install Node + gh + agent runtime, gh auth login, install Lyt skills, install agent manual, cross-machine adopt-detect, create personal mesh + first vault + federation repo, pod-map vault, first-use demo). Conflicts with --auto/--custom/--discover/--json.",
    )
    .option(
      "--dry-run",
      "Only valid with --wizard. Walks all 12 wizard phases without spawn invocations or filesystem writes.",
    )
    .option("--json", "Emit deterministic Lock 0.3 JSON")
    .action(async (opts: LytInitCliOpts) => {
      // v1.G.13 Gap 1 — no-flag fresh-state wizard auto-route. When the
      // handler runs `lyt init` with NO mode flags AND the registry is
      // empty (first-init), enter the wizard. Re-init state falls through
      // to the existing --auto default. Non-TTY first-init errors out per
      // the ratified default.
      const noMode =
        opts.auto !== true &&
        opts.custom !== true &&
        opts.discover !== true &&
        opts.wizard !== true &&
        opts.json !== true &&
        opts.dryRun !== true;
      if (noMode) {
        let isFresh: boolean;
        try {
          isFresh = await probeFreshState();
        } catch (err) {
          // Probe failure (registry unreachable) — surface and exit.
          const msg = err instanceof Error ? err.message : String(err);
          emitError(false, { error: "first-init-probe-failed", message: msg });
          process.exitCode = 1;
          return;
        }
        if (isFresh) {
          if (process.stdin.isTTY !== true) {
            emitError(false, {
              error: "first-init-requires-tty",
              message:
                "lyt init: interactive required for first-init; use --auto for non-interactive bootstrap.",
            });
            process.exitCode = 3;
            return;
          }
          // TTY + fresh → route through the existing --wizard branch by
          // flipping the flag. Single code path for both explicit
          // `--wizard` and the no-flag first-init auto-route.
          opts.wizard = true;
        }
        // Otherwise (re-init state) fall through to existing --auto default.
      }

      // v1.G.4 — --wizard takes a dedicated branch; mutually exclusive
      // with the existing auto/custom/discover/json modes (the wizard
      // composes mesh+vault+federation init itself).
      if (opts.wizard === true) {
        if (
          opts.auto === true ||
          opts.custom === true ||
          opts.discover === true ||
          opts.json === true
        ) {
          emitError(false, {
            error: "flag-conflict",
            message:
              "lyt init --wizard is mutually exclusive with --auto, --custom, --discover, and --json.",
          });
          process.exitCode = 2;
          return;
        }
        if (opts.dryRun !== true && process.stdin.isTTY !== true) {
          emitError(false, {
            error: "wizard-requires-tty",
            message:
              "lyt init --wizard requires an interactive terminal (or pass --dry-run for a non-TTY phase walk).",
          });
          process.exitCode = 3;
          return;
        }
        // Under --dry-run, use a non-interactive default handler so the
        // wizard can be smoke-tested without stdin. Real interactive runs
        // use the readline-backed handler.
        const handler: IPromptHandler & { close?: () => void } =
          opts.dryRun === true ? makeDryRunDefaultsHandler() : new ReadlinePromptHandler();
        try {
          const result = await runWizard({
            promptHandler: handler,
            dryRun: opts.dryRun === true,
          });
          // F3 (console-DX): scannable setup-summary block — a header/footer rule
          // + status glyphs (✓ done · ⊘ skipped · ✗ failed) replacing the flat
          // `[ok] Phase N (name): msg` lines that had no visible start/end.
          const summaryLines = [
            "",
            "── Setup summary ──────────────────────────────────",
            ...result.phases.map((ph) => {
              const glyph = ph.skipped === true ? "⊘" : ph.ok ? "✓" : "✗";
              const num = String(ph.phase).padStart(2, " ");
              return `  ${glyph} Phase ${num}  ${ph.name} — ${ph.message}`;
            }),
            "───────────────────────────────────────────────────",
          ];
          // eslint-disable-next-line no-console
          console.log(summaryLines.join("\n"));
          if (result.status !== "completed") {
            process.exitCode = 1;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          emitError(false, { error: "wizard-error", message: msg });
          process.exitCode = 1;
        } finally {
          handler.close?.();
        }
        return;
      }
      // --dry-run is only valid with --wizard (the wizard branch returned
      // above; reaching here means --dry-run was passed without --wizard).
      if (opts.dryRun === true) {
        emitError(opts.json === true, {
          error: "flag-conflict",
          message: "lyt init: --dry-run is only valid in combination with --wizard.",
        });
        process.exitCode = 2;
        return;
      }
      // Flag conflict: --auto + --custom.
      if (opts.auto === true && opts.custom === true) {
        emitError(opts.json === true, {
          error: "flag-conflict",
          message:
            "lyt init: --auto and --custom are mutually exclusive. Omit both (defaults to --auto), or pick one.",
        });
        process.exitCode = 2;
        return;
      }
      // Flag conflict: --discover with prompts is nonsensical (read-only).
      if (opts.discover === true && opts.custom === true) {
        emitError(opts.json === true, {
          error: "flag-conflict",
          message:
            "lyt init: --discover and --custom are mutually exclusive (--discover is read-only).",
        });
        process.exitCode = 2;
        return;
      }
      // --custom requires a TTY (incl. JSON mode where prompts make no sense).
      if (opts.custom === true && (process.stdin.isTTY !== true || opts.json === true)) {
        emitError(opts.json === true, {
          error: "custom-requires-tty",
          message:
            "lyt init --custom requires an interactive terminal and cannot be combined with --json.",
        });
        process.exitCode = 3;
        return;
      }

      const mode: InitBootstrapMode =
        opts.discover === true ? "discover" : opts.custom === true ? "custom" : "auto";

      // --custom three-prompt walkthrough (per the ratified default + federation-
      // design §5:228-234; main vault name SKIPPED per naming-convention).
      let customOverrides: InitBootstrapCustomOverrides | undefined;
      if (mode === "custom") {
        try {
          customOverrides = await runCustomPrompts();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          emitError(opts.json === true, {
            error: "custom-prompt-error",
            message: msg,
          });
          process.exitCode = 1;
          return;
        }
      }

      // v1.GP F7-followup — phase-spanning init spinner. Drive a persistent
      // spinner across the WHOLE bootstrap so the surrounding sync work (mesh
      // forge, vault scaffold, libSQL writes, git init, pod.yon write)
      // no longer runs with a dead/frozen indicator. Active only for the
      // human-output FRESH/auto path: --json stays escape-code-free + the
      // discovery/re-init branches are fast read-only paths with no silent
      // gap to cover. The spinner's onPhase re-labels + yields to the event
      // loop at each boundary; per-op gh/git spinners deep in the flow defer
      // to it (single-spinner invariant in util/spinner.ts). Cursor restored
      // on stop() AND on throw via the finally below.
      const useSpinner = opts.json !== true && mode !== "discover";
      const spinner: PhaseSpinnerHandle | undefined = useSpinner ? startSpinner() : undefined;
      const flowArgs: InitBootstrapArgs = {
        mode,
        // W1.2 heal on every `lyt init` bootstrap. The flow gates
        // this to the fresh + re-init branches (discovery stays read-only),
        // so a single `lyt init` re-aligns skills + agent manual + patterns.
        // Wired ONLY at the command layer so flow/integration unit tests
        // (which call initBootstrapFlow directly without `heal`) never write
        // to the real ~/.claude / ~/.codex / ~/.agents.
        heal: () => healPod(),
        // Brief B (B.1) — materialize each vault into a publishable LOCAL state
        // (git + initial commit + remote URL) and commit pod.yon, with push +
        // gh-create HELD (push: false). Outward publish is the consented sync
        // engine's job (B.2), triggered by the staged-HIL prompt (B.3). Wired
        // ONLY here so flow/integration tests stay hermetic (no git subprocesses
        // on temp vault dirs).
        // in a local-first context (no gh provisional
        // identity), hold the remote too (setRemote:false): the provisional
        // handle must never land in a vault `origin` URL. Connect re-materializes
        // with the real handle + setRemote:true.
        materializePublish: (db) =>
          materializePodLocal(db, { push: false, setRemote: !isLocalFirstContext() }),
        ...(customOverrides !== undefined ? { customOverrides } : {}),
        ...(spinner !== undefined
          ? {
              onPhase: async (op: string, label: string): Promise<void> => {
                spinner.phase(op as SpinnerOp, label);
                // Yield so the render interval fires AT the boundary — the
                // label + elapsed visibly advance even though frames can't
                // animate inside a single blocking sync call.
                await new Promise<void>((r) => setImmediate(r));
              },
            }
          : {}),
      };

      try {
        const result = await initBootstrapFlow(flowArgs);
        // Stop the spanning spinner BEFORE printing the result/card so its
        // teardown (clear-line + show-cursor) doesn't clobber the output.
        spinner?.stop();
        if (opts.json === true) {
          emitJsonResult(result);
        } else {
          emitHumanResult(result);
          // W1.2 — surface the heal summary (skills/manual/patterns realign).
          if (result.heal !== undefined) {
            // eslint-disable-next-line no-console
            console.log(summarizeHeal(result.heal));
          }
          // WS2 — render the pod card at the end of `lyt init --auto` too
          // (previously wizard-only). Fresh branch only; the lyt-pod-map line
          // is omitted because --auto does not generate a pod-map vault.
          if (result.branch === "fresh") {
            emitAutoPodCard(result);
          } else if (result.branch === "adopt" && result.adopt !== undefined) {
            emitAdoptPodCard(result);
          }
          // Brief B (B.3) — staged-HIL publish prompt. After the honest
          // (staged) card, ASK whether to publish now (default-Yes per the ratified default).
          // On yes → the consented sync engine pushes pod + vaults. Outward
          // effect ONLY behind this explicit consent.
          await maybePromptAndPublish(result);
        }
        // Re-init with ALL-failed integrity → exit 1 (matches v1.B.2
        // skip-and-warn precedent + brief default).
        if (
          result.branch === "re-init" &&
          result.integrityIssues !== undefined &&
          result.integrityIssues.length > 0 &&
          result.integrityIssues.every((i) => i.status !== "ok")
        ) {
          process.exitCode = 1;
        }
        // a review finding — adopt attempted but the clone failed: clean non-zero exit (the
        // actionable error was already rendered by emitHumanResult/emitJsonResult).
        if (result.branch === "adopt" && result.adoptError !== undefined) {
          process.exitCode = 1;
        }
      } catch (err) {
        // Restore the cursor + clear the spinner line before the error path.
        spinner?.stop();
        const message = err instanceof Error ? err.message : String(err);
        emitError(opts.json === true, {
          error: "init-bootstrap-error",
          message,
        });
        process.exitCode = 2;
      }
    });
}

interface CustomPrompts {
  meshName: string;
  pushTarget: string;
  starterFigment: boolean;
}

async function runCustomPrompts(): Promise<CustomPrompts> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // 1. Mesh name (default 'personal'; validateMeshName-gated).
    let meshName = "personal";
    while (true) {
      const ans = (await rl.question("Mesh name [personal]: ")).trim();
      const candidate = ans.length === 0 ? "personal" : ans;
      try {
        validateMeshName(candidate);
        meshName = candidate;
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.log(`  ! ${msg}`);
        // loop until valid OR user submits empty (defaults to 'personal').
      }
    }

    // 2. Push target (default authenticated GH handle; accept handle or
    // org:name; not structurally validated here — passed through to mesh
    // init which validates).
    let pushDefault: string;
    try {
      pushDefault = getHandleFromIdentity();
    } catch {
      pushDefault = "";
    }
    const pushPrompt =
      pushDefault.length > 0
        ? `Push target (handle or org:name) [${pushDefault}]: `
        : "Push target (handle or org:name) []: ";
    const pushAns = (await rl.question(pushPrompt)).trim();
    const pushTarget = pushAns.length === 0 ? pushDefault : pushAns;

    // Main vault name SKIPPED per the ratified default + naming-convention §The main vault
    // is locked. Surface the lock as an informational line.
    // eslint-disable-next-line no-console
    console.log("Main vault name: 'main' (locked; cannot be changed)");

    // 3. Starter content (default y).
    const starterAns = (await rl.question("Include starter content? [Y/n]: ")).trim().toLowerCase();
    const starterFigment = starterAns === "" || starterAns === "y" || starterAns === "yes";

    return { meshName, pushTarget, starterFigment };
  } finally {
    rl.close();
  }
}

// a review finding (release review) — the honest adopt "expected" set: clone FAILURES only.
// Benign skips (tombstoned / already-registered) are excluded so a clean adopt of
// a pod that lists tombstoned vaults never reads as a partial restore. Shared by
// the human + --json emit (one classification, no drift) and unit-tested directly.
export function adoptCloneFailures(
  manifestSkipped: readonly { vaultName: string; reason: string }[],
): { vaultName: string; reason: string }[] {
  return manifestSkipped.filter(
    (s) => s.reason !== "tombstoned" && s.reason !== "already-registered",
  );
}

// Exported for the SC5 emit-shape test (Phase-D a review finding — the rendered adopt
// `--json` contract is pinned directly, not just the pure classifier).
export function emitJsonResult(res: InitBootstrapResult): void {
  // Lock 0.3 stable-key-ordered output (discriminated-union per `branch`).
  const stable: Record<string, unknown> = {
    branch: res.branch,
    durationMs: res.durationMs,
  };
  if (res.meshAssignment !== undefined) {
    stable["meshAssignment"] = {
      meshRidHex: res.meshAssignment.meshRidHex,
      meshName: res.meshAssignment.meshName,
      meshAutoCreated: res.meshAssignment.meshAutoCreated,
    };
  }
  if (res.federation !== undefined) {
    stable["federation"] = {
      handle: res.federation.handle,
      fedRidHex: res.federation.fedRidHex,
      branch: res.federation.branch,
      localPath: res.federation.localPath,
      federationYonPath: res.federation.federationYonPath,
      remoteCreated: res.federation.remoteCreated,
      pushed: res.federation.pushed,
    };
  }
  if (res.integrityIssues !== undefined) {
    stable["integrityIssues"] = res.integrityIssues.map((i) => ({
      vaultName: i.vaultName,
      status: i.status,
      ...(i.error !== undefined ? { error: i.error } : {}),
    }));
  }
  if (res.discoveredRepos !== undefined) {
    stable["discoveredRepos"] = res.discoveredRepos.map((r) => ({
      fullName: r.fullName,
      kind: r.kind,
      alreadyInRegistry: r.alreadyInRegistry,
    }));
  }
  // ADOPT branch (V-A-11). Stable-keyed; `vaultsExpectedFromManifest` is the a review finding
  // honest denominator (excludes tombstoned/already-registered), `skipped` lists
  // only real clone failures, `partialRestore` is the SC8 honesty flag.
  if (res.adopt !== undefined) {
    const a = res.adopt;
    const failures = adoptCloneFailures(a.manifestSkipped);
    stable["adopt"] = {
      podBranch: a.podBranch,
      podHandle: a.podHandle,
      podLocalPath: a.podLocalPath,
      vaultsRecoveredFromManifest: a.vaultsRecoveredFromManifest,
      vaultsExpectedFromManifest: a.vaultsRecoveredFromManifest + failures.length,
      vaultsAcquired: a.vaultsAcquired,
      firstVaultCreated: a.firstVaultCreated,
      partialRestore: failures.length > 0,
      skipped: failures.map((f) => ({ vaultName: f.vaultName, reason: f.reason })),
      // (reconciledVaultPaths is carried once, at the top level — the cross-branch
      // contract fresh/re-init also use; Phase-D a review finding dropped the nested copy.)
    };
  }
  if (res.adoptError !== undefined) {
    stable["adoptError"] = { reason: res.adoptError.reason };
  }
  // W1.2 release review fix-pass (R1-Minor) — the heal runs its filesystem
  // side-effects under `--json` too; surface its outcome so an automation
  // consumer (e.g. the deferred self-updater) can observe collision/divergent
  // notes the handler is meant to see.
  if (res.heal !== undefined) {
    stable["heal"] = {
      runtimes: res.heal.runtimes,
      skills: res.heal.skills.results.map((r) => ({
        skill: r.skill,
        runtime: r.runtime,
        status: r.status,
      })),
      manual: res.heal.manual.map((m) => ({ runtime: m.runtime, action: m.action })),
      patterns: res.heal.patterns.entries.map((e) => ({ id: e.id, action: e.action })),
    };
  }
  if (res.reconciledVaultPaths !== undefined) {
    stable["reconciledVaultPaths"] = res.reconciledVaultPaths;
  }
  // Brief B (B.3) — surface the staged-vs-published posture. Under --json the
  // run is non-interactive (no publish prompt), so state is always "staged":
  // init materializes locally; publishing is the consented `lyt sync` step.
  if (res.publish !== undefined && !res.publish.skipped) {
    stable["publish"] = {
      state: "staged",
      vaultsMaterialized: res.publish.vaults.filter((v) => !v.skipped).length,
      podCommitted: res.publish.podCommitted,
    };
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(stable, null, 2));
}

function emitHumanResult(res: InitBootstrapResult): void {
  if (res.branch === "fresh") {
    // eslint-disable-next-line no-console
    console.log(`Forged mesh '${res.meshAssignment?.meshName}' + scaffolded main vault.`);
    if (res.federation !== undefined) {
      // WS3 / bridge pod ↔ federation on first surface in --auto output.
      // Brief C (F3) — honest staged-HIL text: the pod CONTAINER repo was
      // CREATED on GitHub (remoteCreated) per two-tier consent; CONTENT
      // is staged (unpushed) until `lyt sync`. "local-only" was misleading and
      // pointed at the retired `lyt federation rebuild --push` verb.
      const fed = res.federation;
      const podPosture = fed.remoteCreated
        ? "created on GitHub · content staged (unpushed) — run `lyt sync` to publish"
        : fed.branch === "adopted"
          ? "on GitHub (adopted) · content staged — run `lyt sync` to publish"
          : `${fed.branch} — run \`lyt sync\` to publish`;
      // eslint-disable-next-line no-console
      console.log(
        `  pod (federation): ${fed.remoteFullName} — the identity layer behind your pod (${podPosture})`,
      );
      // eslint-disable-next-line no-console
      console.log(`  path:             ${res.federation.localPath}`);
    } else {
      // eslint-disable-next-line no-console
      console.warn("  pod (federation): skipped (no authenticated handle resolvable)");
    }
    return;
  }
  if (res.branch === "re-init") {
    const issues = res.integrityIssues ?? [];
    const ok = issues.filter((i) => i.status === "ok").length;
    const failed = issues.filter((i) => i.status !== "ok");
    // eslint-disable-next-line no-console
    console.log(
      `Re-init: ${issues.length} vault${issues.length === 1 ? "" : "s"} checked; ${ok} ok, ${failed.length} with issues.`,
    );
    for (const f of failed) {
      // eslint-disable-next-line no-console
      console.warn(`  ! ${f.vaultName}  [${f.status}]  ${f.error ?? ""}`);
    }
    if (failed.length === 0) {
      // eslint-disable-next-line no-console
      console.log("  integrity OK.");
    }
    return;
  }
  if (res.branch === "adopt") {
    // a review finding — adopt failed (pod/vault clone threw). Render an AI-actionable error;
    // the main flow sets a clean non-zero exit. Local state is left re-runnable.
    if (res.adoptError !== undefined) {
      // Phase-D a review finding — do NOT over-promise "registry empty / nothing scaffolded":
      // that holds for the common pod-clone throw but not a rare post-recovery
      // fault that leaves a partial registry. Point at `lyt doctor` for the
      // half-set-up case instead of asserting an unconditional clean state.
      // eslint-disable-next-line no-console
      console.error(
        `Couldn't finish adopting your pod — ${res.adoptError.reason}\n` +
          `  This is usually a network drop or a GitHub-credentials issue on a private repo.\n` +
          `  • Check your login:               gh auth status\n` +
          `  • Then retry (re-running resumes): lyt init --auto\n` +
          `  • If anything looks half-set-up:   lyt doctor`,
      );
      return;
    }
    const a = res.adopt;
    if (a === undefined) return;
    // a review finding — honest "expected" denominator EXCLUDES benign skips; only real clone
    // failures count, so a clean adopt of a pod with tombstoned vaults never reads
    // as a partial restore (shared classifier with the --json emit).
    const failures = adoptCloneFailures(a.manifestSkipped);
    const expected = a.vaultsRecoveredFromManifest + failures.length;
    // eslint-disable-next-line no-console
    console.log(
      `Adopted pod ${a.podHandle}/lyt-pod — restored ${a.vaultsRecoveredFromManifest}/${expected} vault(s); re-indexed ${a.reconciledVaultPaths.length}.`,
    );
    if (a.firstVaultCreated) {
      // eslint-disable-next-line no-console
      console.log(
        `  pod had no vaults to restore — scaffolded ${a.primaryMeshName ?? "personal"}/main.`,
      );
    }
    if (failures.length > 0) {
      // MF4/SC8 — partial restore is LOUD (a 3-of-5 adopt is never reported as success).
      // eslint-disable-next-line no-console
      console.warn(`  ! partial restore: ${failures.length} vault(s) did not clone:`);
      for (const f of failures) {
        // eslint-disable-next-line no-console
        console.warn(`    - ${f.vaultName}: ${f.reason}`);
      }
      // eslint-disable-next-line no-console
      console.warn("  Re-run `lyt init --auto` to retry the missing vault(s).");
    }
    return;
  }
  // discovery
  const repos = res.discoveredRepos ?? [];
  // eslint-disable-next-line no-console
  console.log(`Discovery: ${repos.length} lyt-* repo${repos.length === 1 ? "" : "s"} found.`);
  for (const r of repos) {
    const marker = r.alreadyInRegistry ? "[in registry]" : "[NEW]";
    // eslint-disable-next-line no-console
    console.log(`  ${marker}  ${r.fullName}  (${r.kind})`);
  }
}

// WS2 — render the end-of-init pod card on `lyt init --auto` (FRESH branch).
// Mirrors the wizard's emitPodCard sourcing but for the bootstrap result:
// pod repo full name + local path come from the federation chokepoint
// (res.federation), the mesh + main-vault row from res.meshAssignment. The
// lyt-pod-map line is OMITTED because `--auto` does not generate a pod-map
// vault (only the wizard's P11 does) — PodCardData simply leaves
// podMapVaultPath unset so renderPodCard skips that block. Best-effort: a
// missing federation (no handle) skips the card (the warn line already
// printed by emitHumanResult covers that case).
function emitAutoPodCard(res: InitBootstrapResult): void {
  const fed = res.federation;
  const mesh = res.meshAssignment;
  if (fed === undefined || mesh?.mainVaultPath === undefined) {
    return;
  }
  const data: PodCardData = {
    handle: fed.handle,
    mesh: {
      meshName: mesh.meshName,
      vaultName: mesh.mainVaultName ?? `${mesh.meshName}/main`,
      vaultPath: mesh.mainVaultPath,
    },
    podRepoFullName: fed.remoteFullName,
    podLocalPath: fed.localPath,
    hyperlinksEnabled: process.stdout.isTTY === true,
    // Brief B (B.3) — init materializes LOCALLY (push held); the card is honest
    // that the pod is staged, not published, and points at `lyt sync`. The HIL
    // publish prompt (maybePromptAndPublish) runs after the card.
    // a no-gh provisional pod is "local-only" (NOT
    // connected), a stronger honesty than "staged" (which implies gh is wired).
    publishState: isLocalFirstContext() ? "local-only" : "staged",
  };
  // eslint-disable-next-line no-console
  console.log(renderPodCard(data));
  // Brief C (F4) — `--auto` materializes locally (publishState "staged"), so the
  // Next-steps lead with `lyt sync` whenever the pod isn't yet published.
  // eslint-disable-next-line no-console
  console.log(renderNextSteps({ unpublished: data.publishState !== "published" }));
  // eslint-disable-next-line no-console
  console.log("");
}

// V-A-11 — pod card for the ADOPT branch (a fresh machine that cloned an existing
// pod). Built from res.adopt (the federation/meshAssignment fields stay unset on
// adopt). publishState "staged": the pod + vaults came FROM GitHub, but the local
// registration/recovery commits are unpushed (noPush) → Next-steps nudge `lyt sync`
// to push them. A null primaryVaultPath (no vault recovered AND scaffold failed)
// skips the card — the human/json line already carried the outcome.
function emitAdoptPodCard(res: InitBootstrapResult): void {
  const a = res.adopt;
  if (a === undefined || a.primaryVaultPath === null) {
    return;
  }
  const meshName = a.primaryMeshName ?? "personal";
  const data: PodCardData = {
    handle: a.podHandle,
    mesh: {
      meshName,
      vaultName: `${meshName}/main`,
      vaultPath: a.primaryVaultPath,
    },
    podRepoFullName: `${a.podHandle}/lyt-pod`,
    podLocalPath: a.podLocalPath,
    hyperlinksEnabled: process.stdout.isTTY === true,
    publishState: "staged",
  };
  // eslint-disable-next-line no-console
  console.log(renderPodCard(data));
  // eslint-disable-next-line no-console
  console.log(renderNextSteps({ unpublished: true }));
  // eslint-disable-next-line no-console
  console.log("");
}

// Brief B (B.3) — the staged-HIL publish prompt. Runs after the honest card on
// the fresh + re-init human paths. Default-Yes ([Y/n]) per the ratified default: publishing is
// the expected end-state and the prompt itself is the explicit consent (no
// surprise push). On yes → the B.2 reconcile engine (push=true) does the outward
// gh-create + push, resumable via the outbox. Non-interactive (no TTY) leaves
// the pod staged + prints the honest `lyt sync` nudge (never blocks on stdin).
async function maybePromptAndPublish(res: InitBootstrapResult): Promise<void> {
  const pub = res.publish;
  if (pub === undefined || pub.skipped) return; // no pod / nothing materialized

  // a local-first (no-gh provisional) pod has no gh to
  // publish to; the publish prompt would fail. Connect is `lyt sync`'s job (the
  // self-heal). Nudge there instead of prompting to publish.
  if (isLocalFirstContext()) {
    // eslint-disable-next-line no-console
    console.log(
      "\nYour pod is local-only (not connected to GitHub). Run `lyt sync` to connect + back it up.",
    );
    return;
  }

  const vaultCount = pub.vaults.filter((v) => !v.skipped).length;

  if (process.stdin.isTTY !== true) {
    // eslint-disable-next-line no-console
    console.log(
      "\nYour pod is staged locally (not published). Run `lyt sync` to publish it to GitHub.",
    );
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let yes: boolean;
  try {
    const ans = (
      await rl.question(
        `\nPublish your pod to GitHub now? (pushes your pod + ${vaultCount} vault repo(s)) [Y/n]: `,
      )
    )
      .trim()
      .toLowerCase();
    // default-Yes: empty (Enter) or y/yes → publish.
    yes = ans === "" || ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }

  if (!yes) {
    // eslint-disable-next-line no-console
    console.log("Staged. Run `lyt sync` when you're ready to publish to GitHub.");
    return;
  }

  // eslint-disable-next-line no-console
  console.log("Publishing your pod to GitHub…");
  const result = await reconcilePublishFlow({ push: true });
  if (result.skipped) {
    // eslint-disable-next-line no-console
    console.log(`Publish skipped — ${result.reason ?? "no pod"}.`);
    return;
  }
  const pushed = result.vaultOutcomes.filter((o) => o.pushed).length;
  if (result.ok) {
    // eslint-disable-next-line no-console
    console.log(`✓ Published to GitHub — ${pushed} vault repo(s) + your pod.`);
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `⚠ Partial publish — ${pushed} vault(s) pushed; ${result.outboxRemaining} op(s) pending. Re-run \`lyt sync\` to finish (resumable, no data lost).`,
    );
    for (const o of result.vaultOutcomes) {
      if (o.status === "conflict" || o.status === "failed") {
        // eslint-disable-next-line no-console
        console.log(`  ${o.status}: ${o.vaultName} — ${o.message}`);
      }
    }
  }
}

// Non-interactive defaults handler used by `lyt init --wizard --dry-run`
// so the smoke test (and CI sanity invocations) never block on stdin.
// Returns: ask → defaultValue (or "" if absent); confirm → defaultValue
// (or true); select → first option. Matches the runWizard contract.
function makeDryRunDefaultsHandler(): IPromptHandler {
  return {
    async ask(_question: string, defaultValue?: string): Promise<string> {
      return defaultValue ?? "";
    },
    async confirm(_question: string, defaultValue?: boolean): Promise<boolean> {
      return defaultValue ?? true;
    },
    async select<T>(_question: string, options: { label: string; value: T }[]): Promise<T> {
      return options[0]!.value;
    },
  };
}

// true when init should stay LOCAL: no gh handle resolves
// (gh absent/unauthed) OR the cached identity is provisional (a local pod). In
// both cases the materialize pass holds vault remotes (setRemote:false) so the
// provisional handle never reaches a remote URL — connect wires the real one.
//
// release review fix-pass: read the cache DIRECTLY (no getIdentity / TTL /
// gh-refresh). A provisional cache → local-first regardless of its age (connect,
// not a silent init refresh, is where it reconciles); a gh-cli cache →
// connected. Only when there is NO cache do we probe gh (the genuine
// connected-fresh-vs-no-gh decision). Mirrors init-bootstrap's local-first
// trigger so the command + flow agree.
function isLocalFirstContext(): boolean {
  // MF1 — the provisional-cache determination is the shared resolveLocalFirst
  // predicate (kills the triplication: router + doFreshBranch + here). When a
  // cache exists its verdict is authoritative; only a NO-cache machine probes gh.
  const cached = readIdentityCache();
  if (cached !== null) return resolveLocalFirst(cached);
  // No cache → local-first iff no gh handle resolves (gh absent/unauthed).
  try {
    getHandleFromIdentity();
    return false;
  } catch {
    return true;
  }
}

function emitError(json: boolean, body: Record<string, unknown>): void {
  if (json) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(body, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.error(`lyt init: ${String(body["message"] ?? body["error"])}`);
  }
}
