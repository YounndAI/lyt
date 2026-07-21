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

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { meshInitFlow } from "./mesh-init.js";
import { inspectMeshInitPreflight } from "./mesh-init-preflight.js";
import { captureIndexFlow } from "./capture-index.js";
import { federationInitFlow } from "./federation/init.js";
import { adoptAndPrimeFlow } from "./adopt-and-prime.js";
import { reconstructionExitCode } from "./federation/recover-pod.js";
import { embeddingsOfferGate } from "./embeddings-offer.js";
import { resolveAskedState } from "./embeddings-offer-state.js";
import { markAsked } from "../registry/nudge-state-repo.js";
import { closeRegistry, openRegistry } from "../registry/client.js";
import { detectInstalledRuntimes } from "./agent-manual.js";
import {
  deriveProvisionalHandle,
  getHandleFromIdentity,
  isValidGhHandle,
  validateMeshName,
} from "../util/identity.js";
import {
  federationRepoName,
  federationRepoFullName,
  getFederationRepoDir,
  vaultRepoName,
} from "../util/federation-paths.js";
import { getDefaultVaultsRoot } from "../util/paths.js";
import { recordInitFailure } from "../util/failure-log.js";
import { newUuidv7Bytes, uuid7BytesToDashedString } from "../util/uuid7.js";
import {
  deriveCreationOperationIdV1,
  plannedSingleVaultEffectsV1,
  resolveCreationPlanV1,
  withCreationRepositoryEffectsV1,
  type CreationPlanV1,
} from "./creation-plan.js";
import type { CreationMutationEvidence } from "../op/creation-mutation-journal.js";
import { renderPodCard, renderNextSteps, type PodCardData } from "../util/pod-card.js";
import { startSpinner, type SpinnerOp } from "../util/spinner.js";
import {
  currentPlatform,
  detectTool,
  installTool,
  getManualInstallUrl,
  type Platform,
} from "../util/installer.js";

// v1.G.4 — `lyt init --wizard [--dry-run]` setup-wizard flow.
// v1.G.13 — Gap 2 composition: P5 skills-install inserted; downstream
// returned phase numbers shifted; user-facing flow was 11 phases.
// v1.G.14 — Gap 2 composition: P5c cross-machine adopt-detect inserted
// between agent-manual (P6) and personal-mesh (P8); downstream returned
// phase numbers shifted one more step; user-facing flow is 12 phases.
// P7 (first vault) gains a placement-override prompt (Gap 1).
//
// P11 remains as a skipped compatibility window after retirement of the
// Obsidian-specific pod-map generator. The wizard still reports 12 ordered
// phases without generating viewer artifacts.
//
// Per the ratified default (handler-ratified 2026-06-01): the wizard is invoked via
// `lyt init --wizard`; NO new top-level verb.
//
// Phases (v1.G.14 — magic-zone composition; P5c inserted, downstream
// returned phase numbers shifted one step; function names retain their
// historical phase5/6/7/8/9/10-prefix identifiers for verify-script
// grep-compat):
// P1 Detect + install Node (winget/brew/apt-or-dnf)
// P2 Detect + install gh CLI (winget/brew/apt-or-dnf)
// P3 Install Claude Code OR Codex CLI (npm install -g; handler picks)
// P4 gh auth status detect-skip/halt (spawnSync argv-array; F4+F8-defuse)
// P5 Install Lyt skills tri-runtime (spawnSync `lyt skills install`; v1.G.13 NEW)
// P6 lyt agent-manual --install … (spawnSync to G.5 verb; reads populated catalog)
// P7 Cross-machine adopt-detect (v1.G.14 NEW; gh api federation-repo probe — informational; full adopt body deferred to Brief B)
// P8 Create `personal` mesh (meshInitFlow direct call)
// P9 First vault = `personal/main` (resolves the mesh main from P8; no name prompt, no duplicate scaffold)
// P10 Initialize federation repo (federationInitFlow direct call)
// P11 Retired pod-map window (observable skipped result; no generation)
// P12 First-use demo (direct fs write + grep read-back)
//
// PG-8 shell-injection defenses (brief PG-8 4-prong):
// 1. spawn/spawnSync ONLY with argv-array shape — NO exec/execSync.
// 2. Handler vault/mesh names go through validateVaultName/validateMeshName
// (existing helpers, richer than the brief's proposed regex).
// 3. Installer commands are hardcoded constants in util/installer.ts —
// handler input is NEVER concatenated into installer argv.
// 4. P5 argv values: `--runtime <pick>` where <pick> is constrained to
// the AGENT_MANUAL_RUNTIMES literal enum BEFORE reaching spawnSync.

export type AgentRuntimeChoice = "claude" | "codex";

export interface IPromptHandler {
  ask(question: string, defaultValue?: string): Promise<string>;
  confirm(question: string, defaultValue?: boolean): Promise<boolean>;
  select<T>(question: string, options: { label: string; value: T }[]): Promise<T>;
}

export interface WizardPhaseResult {
  phase: number;
  name: string;
  ok: boolean;
  message: string;
  skipped?: boolean;
  // Release review Cor-mi1 + Sec-M1 fix-pass: typed data field replaces the
  // prior P7→P10 message-regex extraction (fragile string parsing). Phase
  // 7 populates `data.vaultPath` so phase 10 can consume it directly.
  //
  // v1.G.14 — `branch` populated by phase5c_crossMachineAdoptDetect.
  // "fresh" means no federation-repo found (or probe skipped) → continue
  // fresh-init path. "adopted" means federation-repo exists → currently
  // informational only (full skip/clone body deferred to Brief B — the
  // publish/sync + clone-adopt engine; pod.yon now lists meshes + vaults
  // so a cloned pod is enumerable once pods are pushed).
  data?: {
    vaultPath?: string;
    branch?: "fresh" | "adopted";
    // G1 (a review finding) — the reconstruction exit code (0 clean · 11 state-drift drop ·
    // 12 owner-misresolved/bug drop) surfaced by phase_adoptPod so the `lyt init`
    // command can wire it to process.exitCode with the bug/state granularity.
    reconstructExitCode?: number;
    creation?: { plan: CreationPlanV1; mutations: CreationMutationEvidence };
  };
}

export interface WizardRunOptions {
  promptHandler: IPromptHandler;
  dryRun: boolean;
  // Test seam — override spawnSync for unit tests. Defaults to node's
  // built-in spawnSync. Same argv-array shape.
  spawnFn?: typeof spawnSync;
  // W2.1 test seam — override the adopt-and-prime flow so the adopt branch
  // (P7 → P8-adopt) can be exercised without live gh. Defaults to the real
  // adoptAndPrimeFlow.
  adoptFlowOverride?: typeof adoptAndPrimeFlow;
  // Retained for option compatibility. Creation never publishes; scoped sync
  // is the sole remote mutation owner.
  publishFlowOverride?: unknown;
  // Phase C test seam — override the interactive embeddings offer so the
  // no-flag wizard route's neutral+recommend gate can be exercised without a
  // real model download. Defaults to the real embeddingsOfferGate.
  embeddingsOfferOverride?: typeof embeddingsOfferGate;
}

export interface WizardRunResult {
  status: "completed" | "halted";
  phases: WizardPhaseResult[];
  creation?: { plan: CreationPlanV1; mutations: CreationMutationEvidence };
}

// v1.GP WS3 / lead with "pod" (user-facing); gloss "federation" on
// first surface so the two terms are bridged, never presented as separate
// unexplained concepts. "pod" is the friendly name; "federation" is the
// plumbing — same thing.
const POD_VOCAB_BANNER =
  "Welcome to Lyt — let's set up your pod.\n" +
  "Your *pod* is your whole bundle of vaults on this machine — a *federation* of\n" +
  "vaults. 'Pod' is the friendly name you'll see in docs + chat; 'federation' is\n" +
  "the technical name for the same thing. Lyt manages the federation; you own the\n" +
  "markdown.\n";

export async function runWizard(opts: WizardRunOptions): Promise<WizardRunResult> {
  const phases: WizardPhaseResult[] = [];
  const ph = opts.promptHandler;
  const spawn = opts.spawnFn ?? spawnSync;

  emit(POD_VOCAB_BANNER);

  const platform = currentPlatform();
  if (platform === "unsupported") {
    phases.push({
      phase: 0,
      name: "platform-check",
      ok: false,
      message: `Unsupported platform: ${process.platform}. Lyt's wizard supports win32, darwin, and linux.`,
    });
    return { status: "halted", phases };
  }

  // P1 — Node
  emit("\nPhase 1 — Node runtime\nLyt's CLI runs on Node, so we need Node on your PATH.");
  const p1 = await phase1_detectInstallNode(ph, platform, opts.dryRun);
  phases.push(p1);
  if (!p1.ok && !p1.skipped) return { status: "halted", phases };

  // P2 — gh CLI. : gh is OPTIONAL. If it's missing and the
  // handler declines to install it (or the install fails), DON'T halt — degrade
  // to a LOCAL pod (connect later with `lyt sync`).
  emit(
    "\nPhase 2 — GitHub CLI (gh)\nLyt uses `gh` to back up + share your pod. It's optional — you can start locally and connect later.",
  );
  const p2 = await phase2_detectInstallGhCli(ph, platform, opts.dryRun);
  const ghCliAvailable = p2.ok; // detected OR installed OR dry-run-skip
  if (!p2.ok && !p2.skipped) {
    phases.push({
      phase: 2,
      name: "gh-cli",
      ok: true,
      skipped: true,
      message: `gh not available (${p2.message}). Proceeding local — connect later with \`lyt sync\`.`,
    });
  } else {
    phases.push(p2);
  }

  // P3 — Agent runtime. v1.GP F5: detect installed runtimes first. If ANY
  // runtime is already present (~/.claude / ~/.codex / ~/.agents), we do NOT
  // force the handler to pick one to install — the agent manual injects into
  // ALL detected runtimes at P6. We only fall back to the pick-one installer
  // when NO runtime is detected (a truly fresh machine needs at least one).
  // (Deeper detect-and-skip for an already-installed binary is F4 — out of
  // scope here; this is the minimal "don't force a single pick" change.)
  const detectedRuntimes = detectInstalledRuntimes();
  if (detectedRuntimes.length > 0) {
    emit(
      "\nPhase 3 — Agent runtime\nDetected installed runtime(s): " +
        `${detectedRuntimes.join(", ")}. Lyt will inject its agent manual into ` +
        "each at Phase 6 — no need to pick one.",
    );
    phases.push({
      phase: 3,
      name: `agent-runtime:detected`,
      ok: true,
      skipped: true,
      message: `Detected runtime(s): ${detectedRuntimes.join(", ")}; skipping install (manual injects into all at P6).`,
    });
  } else {
    emit(
      "\nPhase 3 — Agent runtime\nNo agent runtime detected. Lyt installs an agent " +
        "manual into your editor's CLI (Claude Code or Codex). Pick one to install.",
    );
    const runtimeChoice = await ph.select<AgentRuntimeChoice>("Which agent runtime?", [
      { label: "Claude Code (Anthropic)", value: "claude" },
      { label: "Codex CLI (OpenAI)", value: "codex" },
    ]);
    const p3 = await phase3_installAgentRuntime(runtimeChoice, opts.dryRun, spawn);
    phases.push(p3);
    if (!p3.ok && !p3.skipped) return { status: "halted", phases };
  }

  // P4 — gh auth. : a missing/unauthed gh no longer HALTS —
  // it degrades to LOCAL (provisional identity, no remote; connect later via
  // `lyt sync`). gh present + authed → `ghReady` drives the connected/adopt tree.
  emit(
    "\nPhase 4 — GitHub authentication\nChecking `gh auth status`. Signed in → Lyt can connect your pod now; not signed in → Lyt sets up a local pod you can connect anytime with `lyt sync`.",
  );
  let ghAuthed = false;
  if (!ghCliAvailable && !opts.dryRun) {
    // gh unavailable → skip the auth phase (it would only fail). LOCAL.
    phases.push({
      phase: 4,
      name: "gh-auth-login",
      ok: true,
      skipped: true,
      message: "Skipped — gh not available; proceeding local (connect later with `lyt sync`).",
    });
  } else {
    const p4 = await phase4_ghAuthLogin(opts.dryRun, spawn);
    if (!p4.ok && !p4.skipped) {
      phases.push({
        phase: 4,
        name: "gh-auth-login",
        ok: true,
        skipped: true,
        message: `Not signed in to GitHub (${p4.message}). Proceeding local — connect later with \`lyt sync\`.`,
      });
    } else {
      phases.push(p4);
      ghAuthed = p4.ok; // authed-skip OR dry-run-skip → ok:true
    }
  }
  // gh is "ready" (connected/adopt tree) only when it's BOTH present AND authed.
  const ghReady = ghCliAvailable && ghAuthed;

  // P5 — Lyt skills install (v1.G.13 Gap 2). Runs BEFORE P6 agent-manual
  // so the agent-manual writer reads a populated skill catalog instead
  // of emitting the agent-manual.ts:340 placeholder string.
  emit(
    "\nPhase 5 — Install Lyt skills\nSymlinks the bundled Lyt skills tri-runtime " +
      "(Claude Code / Codex / .agents) so the agent-manual writer can enumerate them.",
  );
  // skills are an agent CONVENIENCE; they must NEVER gate pod creation.
  // A failed `lyt skills install` (e.g. divergent `~/.claude|.codex|.agents/
  // skills/lyt-*` symlinks → exit 2) previously short-circuited Phases 6–12 and
  // left the user with NO pod. phase4b_installSkills now degrades any non-zero
  // exit / spawn-error to a non-fatal warn (ok:true, skipped:true) carrying the
  // actionable `lyt skills install --force` remedy, so the early `halted` return
  // is gone. Belt-and-braces: even a residual ok:false is converted to a
  // non-fatal warn here and the wizard CONTINUES — there is intentionally NO
  // `return { status: "halted" }` for the skills phase.
  const p4b = await phase4b_installSkills(opts.dryRun, spawn);
  // Track a degraded skills install so the end-of-wizard tail can re-surface it
  // (the inline ⚠ scrolls off-screen under Phases 6–12 — a non-technical user
  // must still learn, at the end, that they're in a degraded state).
  let skillsDegraded = false;
  if (!p4b.ok && !p4b.skipped) {
    emit(`  ⚠ ${p4b.message}`);
    phases.push({ ...p4b, ok: true, skipped: true, message: `(non-fatal) ${p4b.message}` });
    skillsDegraded = true;
  } else {
    phases.push(p4b);
    // A non-dry-run `skipped` skills phase is a degrade warn (dry-run is gated
    // out of the end-of-wizard recap below); a clean success is skipped:undefined.
    if (!opts.dryRun && p4b.skipped === true) skillsDegraded = true;
  }

  // P6 — agent-manual injection (G.5 verb-signature contract LOCKED).
  // Now reads the populated catalog written by P5 above. v1.GP F5: inject
  // into ALL detected runtimes (no single pick) via `lyt agent-manual
  // --install` with no --runtime (the detect-all default).
  emit(
    "\nPhase 6 — Inject agent manual\nLyt writes a ~1.5K-token instruction block into the " +
      "global config of every detected agent runtime so each knows how to talk to your pod.",
  );
  const p5 = await phase5_runAgentManualInject(opts.dryRun, spawn);
  phases.push(p5);
  if (!p5.ok && !p5.skipped) return { status: "halted", phases };

  // ---- decision tree ----
  // The branch is INVISIBLE to the user (complexity lives in the tree, never in
  // their face — lean-DX). Three outcomes, at most ONE ⏎-acceptable prompt:
  // • gh NOT ready (absent/unauthed) → LOCAL (forced, no question).
  // • gh ready + existing `<handle>/lyt-pod` → ADOPT (no question — it's theirs).
  // • gh ready + fresh → ASK local-vs-connect (default Connected, RATIFIED).
  const isTty = process.stdin.isTTY === true;
  let mode: "local" | "connected" | "adopt" = "local";
  let handleForProbe = "";
  let freshHandle = "";

  if (ghReady) {
    try {
      handleForProbe = getHandleFromIdentity();
    } catch {
      // No identity cached yet (e.g. dry-run); P7 will skip cleanly.
    }
    // P7 — cross-machine adopt-detect (probe-only; meaningful only with gh).
    emit(
      `\nPhase 7 — Cross-machine adopt-detect\nProbing for an existing pod repo at \`<handle>/${federationRepoName()}\` via gh api.`,
    );
    const p5c = await phase5c_crossMachineAdoptDetect(handleForProbe, opts.dryRun, spawn);
    phases.push(p5c);
    if (p5c.data?.branch === "adopted") {
      mode = "adopt";
    } else if (!p5c.ok && !p5c.skipped) {
      // A genuinely-not-ok, non-adopt probe result still halts (defensive).
      return { status: "halted", phases };
    } else {
      // Fresh + gh ready → ASK local-vs-connect (default Connected). Non-TTY →
      // Connected silently (gh is present + authed). Validate any taken handle
      // via isValidGhHandle (here the probe handle is gh-resolved → already valid).
      mode = await askLocalVsConnect(ph, handleForProbe, isTty, opts.dryRun);
    }
  } else {
    // LOCAL forced — gh unavailable. Skip P7 (nothing to probe). No question.
    mode = "local";
  }

  // Provisional identity (D.2) — minted only in LOCAL mode (gh-absent or the
  // handler chose local). Prompts for a handle (default OS username, ⏎ accepts).
  if (mode === "local") {
    freshHandle = await chooseProvisionalIdentity(ph, opts.dryRun, isTty);
  } else if (mode === "connected") {
    freshHandle = handleForProbe;
  }

  // firstVaultPath feeds the shared completion tail, sourced from the adopt
  // branch OR the fresh-scaffold branch (local or connected).
  let firstVaultPath = "";
  let creation: WizardRunResult["creation"];

  if (mode === "adopt") {
    // ADOPT — an existing pod. Clone it + acquire the user's vaults from gh +
    // scaffold personal/main ONLY if the pod had none + Lane M reconcile.
    // Subsumes P8/P9/P10. No halt, no partial `~/lyt`.
    emit(
      "\nPhase 8 — Adopt your existing pod\n" +
        "Found an existing pod on GitHub. Cloning it, acquiring your vaults, and " +
        "re-indexing — instead of scaffolding a duplicate.",
    );
    const adopt = await phase_adoptPod(opts);
    phases.push(adopt);
    if (!adopt.ok && !adopt.skipped) return { status: "halted", phases };
    firstVaultPath = adopt.data?.vaultPath ?? "";
    phases.push({
      phase: 9,
      name: "first-vault",
      ok: true,
      skipped: true,
      message: "Skipped — existing pod adoption already acquired its registered vaults.",
    });
    phases.push({
      phase: 10,
      name: "federation-init",
      ok: true,
      skipped: true,
      message: "Skipped — existing pod adoption already restored the pod repository.",
    });
  } else {
    // FRESH — scaffold personal mesh + first vault + pod repo. `localMode` (no
    // gh / chose local) forges the pod LOCAL-ONLY (no gh repo, no remote);
    // connected mode creates the pod container repo per two-tier consent.
    const localMode = mode === "local";
    emit(
      "\nPhase 8 — Create your `personal` mesh\nA mesh is a named group of vaults; `personal` is the default starter mesh.",
    );
    const p6 = await phase6_createPersonalMesh(opts.dryRun, {
      handle: freshHandle || deriveProvisionalHandle(),
      connected: mode === "connected",
    });
    phases.push(p6);
    if (!p6.ok && !p6.skipped) return { status: "halted", phases };
    creation = p6.data?.creation;

    // P9 — first vault. the first vault is `personal/main`, already
    // scaffolded by P8's mesh-init. P9 resolves that path (no name prompt, no
    // duplicate scaffold) so P12's first-use demo can run against it.
    emit(
      "\nPhase 9 — Your first vault\nYour pod's first vault is `personal/main` — the main vault of the `personal` mesh created above.",
    );
    const mainVaultPath = p6.data?.vaultPath ?? "";
    const p7 = await phase7_createFirstVault(mainVaultPath, opts.dryRun);
    phases.push(p7);
    if (!p7.ok && !p7.skipped) return { status: "halted", phases };

    // P10 — pod repo. WS3 / explicitly bridge pod ↔ federation. In local
    // mode the pod is a LOCAL git repo (connect later); connected mode creates
    // the gh container repo (content push still held until the publish prompt).
    emit(
      "\nPhase 10 — Your pod repo\n" +
        (localMode
          ? "Your **pod** is your whole bundle of vaults. We're setting it up as a local git " +
            "repo (versioned on this machine). Connect it to GitHub anytime with `lyt sync`."
          : "Your **pod** is your whole bundle of vaults; the pod repo " +
            `(\`<handle>/${federationRepoName()}\`) is the identity layer that ties your meshes ` +
            "together. Under the hood it's a *federation* — 'pod' is what you'll see in " +
            "docs + chat, 'federation' is the plumbing underneath."),
    );
    const p8: WizardPhaseResult = {
      phase: 10,
      name: "federation-init",
      ok: true,
      skipped: true,
      message:
        "The immutable personal-mesh creation plan already initialized the local pod; no second pod mutation ran.",
    };
    phases.push(p8);

    firstVaultPath = p7.data?.vaultPath ?? "";
  }

  // P11/P12 are retained as observable compatibility windows in every mode.
  // Neither creates viewer artifacts or unrequested content.
  phases.push(await phase9_podMapInit("", opts.dryRun));
  phases.push({
    phase: 12,
    name: "first-use-demo",
    ok: true,
    skipped: true,
    message: "Skipped — creation does not add unrequested content after its exact checkpoint.",
  });

  // v1.GP WS4 — end-of-init pod card + clickable links + Next-steps trio.
  // Skipped under --dry-run (the phase-walk output stays deterministic; a
  // dry-run has no real paths to surface). On a real run, the card LEADS with
  // "pod" and bridges "federation" once, with OSC 8 hyperlinks when
  // the terminal supports them (graceful plain-text fallback otherwise).
  if (!opts.dryRun) {
    const localMode = mode === "local";
    emitPodCard(firstVaultPath, localMode, mode === "adopt");

    // Phase C (C4) — interactive-only embeddings offer. The no-flag init
    // routes here (the wizard is the primary non-tech entry), so this is where
    // the neutral+recommend "enable semantic search?" offer lives. The gate
    // self-suppresses when the model is already cached OR the invocation isn't
    // interactive (isEmbeddingsInteractive), so a non-TTY/--json wizard call
    // never prompts. Accept → owned fetch (loadEmbedder/fetch-model); decline →
    // enable-later hint, no persistence (Phase D owns decline-state). Wrapped
    // best-effort so an offer failure never derails a finished pod setup.
    const offerGate = opts.embeddingsOfferOverride ?? embeddingsOfferGate;
    try {
      // Phase D Slice 2b — thread the LIVE pod-global nudge-state into the
      // init offer so it consults the SAME coherent state as the rebuild gate +
      // first-search nudge (option (c), idempotent offer surface): the user is
      // offered AT MOST ONCE per decision-epoch across init/rebuild/search. We
      // open the registry best-effort and snapshot askedState via the pinned
      // synchronous `() => OfferState` resolver. A registry open failure (or a
      // test override that replaces the gate) leaves askedState undefined → the
      // gate falls back to its inert () => "not-yet-asked" default, preserving
      // Phase-C behavior. The embeddingsOfferOverride seam is untouched: when an
      // override is supplied we still pass the resolved state, but a test that
      // overrides the gate controls its own assertions.
      let askedState: (() => "not-yet-asked" | "asked" | "declined" | "enabled") | undefined;
      let registryDb: Awaited<ReturnType<typeof openRegistry>> | undefined;
      try {
        registryDb = await openRegistry();
        askedState = await resolveAskedState(registryDb);
      } catch {
        // Registry unreachable → leave askedState undefined (inert default).
      }
      try {
        await offerGate({
          json: false,
          stdinTTY: process.stdin.isTTY === true,
          stdoutTTY: process.stdout.isTTY === true,
          promptConfirm: (q) => ph.confirm(q),
          emit,
          ...(askedState !== undefined ? { askedState } : {}),
          // release review FIX 4(b) — stamp the pod-global ask when this real
          // offer surfaces, so the wizard offer shares the agent's cadence +
          // auto-quiet. Only with a live registry (inert-seam default otherwise).
          ...(registryDb !== undefined
            ? {
                onSurfaced: async () =>
                  void (await markAsked(registryDb!, new Date().toISOString())),
              }
            : {}),
        });
      } finally {
        if (registryDb !== undefined) await closeRegistry(registryDb);
      }
    } catch {
      // Non-fatal — the pod is set up; semantic can be enabled later.
    }

    if (skillsDegraded) {
      // hardening pass recap — the pod is ready WITHOUT the agent skills; re-surface the
      // remedy at the end so it isn't lost in scrollback. Plain language; the
      // `--force` hint is conditional (it only helps the conflict case).
      emit(
        "⚠ Heads up: the Lyt agent skills didn't finish installing (see the Phase 5 note above). " +
          "Your pod is ready without them — run `lyt skills install` anytime to add them " +
          "(add `--force` if it reports a conflict).\n",
      );
    }
    if (localMode) {
      // a local pod has no gh to publish to. NO publish
      // prompt; nudge to CONNECT instead (the self-heal lives in `lyt sync`).
      emit(
        "\nYour pod is local-only (not connected to GitHub). Run `lyt sync` to connect + back it up.\n",
      );
    } else if (mode !== "adopt") {
      // Creation ends locally. A scoped sync is the sole remote mutation owner.
      await maybePromptAndPublishWizard(ph, {
        isTty: process.stdin.isTTY === true,
      });
    } else {
      emit("\nExisting pod adopted. No publication is needed.\n");
    }
  } else {
    emit("\nDone. Your pod is ready.\n");
  }

  const completed = phases.every((p) => p.ok || p.skipped === true);
  return {
    status: completed ? "completed" : "halted",
    phases,
    ...(creation === undefined ? {} : { creation }),
  };
}

export interface WizardPublishPromptDeps {
  // Whether stdin is an interactive TTY. A non-TTY MUST NOT prompt (the prompt
  // would hang a script waiting on stdin) — it surfaces the staged nudge instead.
  isTty: boolean;
  /**
   * Retained for test/caller compatibility. Creation never invokes a publish
   * flow; scoped sync is the sole remote mutation owner.
   */
  publishFlow?: unknown;
}

// Creation is local-only. Keep this exported compatibility seam so callers get
// one clear next action, but it must never invoke a publish engine.
export async function maybePromptAndPublishWizard(
  _ph: IPromptHandler,
  deps: WizardPublishPromptDeps,
): Promise<void> {
  const suffix = deps.isTty ? " You can run it when ready." : "";
  emit(`\nYour pod is local and not published. Run \`lyt sync\` to publish it to GitHub.${suffix}`);
}

// Build + print the WS4 pod card. Best-effort handle resolution never throws
// into the wizard return path. `localOnly` drives the honest "not
// connected to GitHub" status line (vs the connected "staged" wording).
function emitPodCard(firstVaultPath: string, localOnly: boolean, adopted = false): void {
  let handle = "";
  try {
    handle = getHandleFromIdentity();
  } catch {
    // No identity → emit the plain done line; the card needs a handle to
    // name the pod repo honestly.
  }
  if (handle.length === 0) {
    emit("\nDone. Your pod is ready.\n");
    return;
  }

  // Fresh pods start at personal/main. Adopted pods may resolve any existing
  // vault first, so derive the mesh from its actual path instead of mislabelling
  // it as personal.
  const vaultLeaf = firstVaultPath.length > 0 ? basenameOf(firstVaultPath) : "main";
  const meshName =
    adopted && firstVaultPath.length > 0 ? basenameOf(dirname(firstVaultPath)) : "personal";
  const vaultName = `${meshName}/${vaultLeaf}`;

  // no `obsidian://open` deep-link — the card emits the honest
  // file:// vault-FOLDER path + "Open folder as vault" instruction for every
  // vault, so no per-vault verified-file (README) resolution is needed here.
  const data: PodCardData = {
    handle,
    mesh: {
      meshName,
      vaultName,
      vaultPath: firstVaultPath,
    },
    podRepoFullName: federationRepoFullName(handle),
    podLocalPath: getFederationRepoDir(handle),
    hyperlinksEnabled: process.stdout.isTTY === true,
    // local pod → "not connected to GitHub"; connected (staged) pod →
    // "not yet published". Both lead the Next-steps with `lyt sync`.
    publishState: adopted ? "published" : localOnly ? "local-only" : "staged",
  };

  emit(renderPodCard(data));
  // Brief C (F4) + the wizard's pod is always unpublished at this point
  // (staged or local-only), so the Next-steps lead with `lyt sync`.
  emit(renderNextSteps({ unpublished: !adopted }));
  emit("");
}

// the fresh-with-gh local-vs-connect ASK. Default
// Connected (RATIFIED 2026-06-04). Non-TTY → Connected silently (gh is present
// + authed). The complexity lives here, not in the user's face: a single
// ⏎-acceptable prompt, surfaced ONLY when gh is ready AND the pod is fresh.
async function askLocalVsConnect(
  ph: IPromptHandler,
  handle: string,
  isTty: boolean,
  dryRun: boolean,
): Promise<"connected" | "local"> {
  if (!isTty && !dryRun) return "connected";
  // F3 (console-DX): emit ONE context line only. The numbered options are
  // rendered by ph.select() below — previously the emit() above ALSO printed the
  // option list, so the choice appeared twice back-to-back. The descriptions now
  // live in the select labels so a single rendering carries everything.
  emit(`\nYou're signed in to GitHub${handle.length > 0 ? ` (${handle})` : ""}.`);
  return ph.select<"connected" | "local">("How do you want to start your pod?", [
    {
      label: "Connected (recommended) — backed up to GitHub, works across machines, recoverable",
      value: "connected",
    },
    {
      label:
        "Local-only — instant + private; still git-versioned locally; connect anytime with `lyt sync`",
      value: "local",
    },
  ]);
}

// (D.2) — mint the PROVISIONAL identity for a LOCAL pod. The
// prompt offers the OS username as a pre-filled default (⏎ accepts); a typed
// handle is validated with isValidGhHandle (re-prompt on miss). Non-TTY / dry-run
// → the OS-username default, silently. Connect (`lyt sync`) reconciles it to the
// real gh handle later.
async function chooseProvisionalIdentity(
  ph: IPromptHandler,
  dryRun: boolean,
  isTty: boolean,
): Promise<string> {
  const defaultHandle = deriveProvisionalHandle();
  if (dryRun) return defaultHandle; // dry-run writes nothing
  let handle = defaultHandle;
  if (isTty) {
    emit(
      "\nProvisional handle — names your pod locally; change it freely when you connect to GitHub.",
    );
    // Bounded re-prompt: the default is always valid, so an empty-Enter always
    // exits the loop. Only a non-empty INVALID typed handle re-prompts.
    for (;;) {
      const ans = (await ph.ask("Your handle?", defaultHandle)).trim();
      const candidate = ans.length === 0 ? defaultHandle : ans;
      if (isValidGhHandle(candidate)) {
        handle = candidate;
        break;
      }
      emit(
        `  ! '${candidate}' isn't a valid GitHub handle (letters, digits, single hyphens, ≤39 chars). ` +
          `Try again, or press Enter for ${defaultHandle}.`,
      );
    }
  }
  return handle;
}

function basenameOf(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return idx === -1 ? norm : norm.slice(idx + 1);
}

// ---- Phase implementations ----

export async function phase1_detectInstallNode(
  ph: IPromptHandler,
  platform: Platform,
  dryRun: boolean,
): Promise<WizardPhaseResult> {
  const detected = detectTool("node");
  if (detected.present) {
    return {
      phase: 1,
      name: "node",
      ok: true,
      message: `Node detected${detected.version ? ` (${detected.version})` : ""}.`,
    };
  }
  if (dryRun) {
    return {
      phase: 1,
      name: "node",
      ok: true,
      skipped: true,
      message: "[dry-run] would install Node via platform package manager.",
    };
  }
  const proceed = await ph.confirm(
    `Node not found. Install via ${platformInstallerName(platform)}?`,
    true,
  );
  if (!proceed) {
    return {
      phase: 1,
      name: "node",
      ok: false,
      message: `Node not installed (handler declined). Install manually: ${getManualInstallUrl("node")}`,
    };
  }
  const result = installTool("node", platform);
  return {
    phase: 1,
    name: "node",
    ok: result.ok,
    message: result.ok
      ? result.message
      : `${result.message}${result.manualUrl ? ` Manual install: ${result.manualUrl}` : ""}`,
  };
}

export async function phase2_detectInstallGhCli(
  ph: IPromptHandler,
  platform: Platform,
  dryRun: boolean,
): Promise<WizardPhaseResult> {
  const detected = detectTool("gh");
  if (detected.present) {
    return {
      phase: 2,
      name: "gh-cli",
      ok: true,
      message: `gh detected${detected.version ? ` (${detected.version})` : ""}.`,
    };
  }
  if (dryRun) {
    return {
      phase: 2,
      name: "gh-cli",
      ok: true,
      skipped: true,
      message: "[dry-run] would install gh via platform package manager.",
    };
  }
  const proceed = await ph.confirm(
    `gh CLI not found. Install via ${platformInstallerName(platform)}?`,
    true,
  );
  if (!proceed) {
    return {
      phase: 2,
      name: "gh-cli",
      ok: false,
      message: `gh not installed (handler declined). Install manually: ${getManualInstallUrl("gh")}`,
    };
  }
  const result = installTool("gh", platform);
  return {
    phase: 2,
    name: "gh-cli",
    ok: result.ok,
    message: result.ok
      ? result.message
      : `${result.message}${result.manualUrl ? ` Manual install: ${result.manualUrl}` : ""}`,
  };
}

// Agent-runtime install commands. Hardcoded — handler input is NEVER
// concatenated into the argv (PG-8 item 3). npm install -g works
// cross-platform after Phase 1 puts Node on PATH.
const AGENT_RUNTIME_INSTALL: Record<AgentRuntimeChoice, readonly string[]> = {
  claude: ["npm", "install", "-g", "@anthropic-ai/claude-code"],
  codex: ["npm", "install", "-g", "@openai/codex"],
};

export async function phase3_installAgentRuntime(
  runtime: AgentRuntimeChoice,
  dryRun: boolean,
  spawn: typeof spawnSync,
): Promise<WizardPhaseResult> {
  const cmd = AGENT_RUNTIME_INSTALL[runtime];
  if (dryRun) {
    return {
      phase: 3,
      name: `agent-runtime:${runtime}`,
      ok: true,
      skipped: true,
      message: `[dry-run] would run: ${cmd.join(" ")}`,
    };
  }
  const [exe, ...args] = cmd;
  if (exe === undefined) {
    return {
      phase: 3,
      name: `agent-runtime:${runtime}`,
      ok: false,
      message: "Empty install command (defensive).",
    };
  }
  const result = spawn(exe, args, {
    stdio: ["ignore", "inherit", "inherit"],
    shell: process.platform === "win32",
  });
  if (result.error !== undefined) {
    return {
      phase: 3,
      name: `agent-runtime:${runtime}`,
      ok: false,
      message: `Failed: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    return {
      phase: 3,
      name: `agent-runtime:${runtime}`,
      ok: false,
      message: `${exe} exited ${result.status}`,
    };
  }
  return {
    phase: 3,
    name: `agent-runtime:${runtime}`,
    ok: true,
    message: `${runtime} runtime installed.`,
  };
}

// v1.GP F4 + F8-defuse (2026-06-02) — wizard Phase 4 auth.
//
// PRIOR BEHAVIOUR (the bug): this phase ran `gh auth login --web` via blocking
// `spawnSync` UNCONDITIONALLY. On an already-authed machine that forced an
// unnecessary re-auth; worse, the interactive device flow under blocking
// spawnSync HUNG UNKILLABLY — spawnSync blocks the event loop, so neither the
// parent's signal handling nor Ctrl-C could kill the wizard.
//
// FIX (this pass):
// 1. Run `gh auth status` first. It's NON-INTERACTIVE and returns
// immediately, so spawnSync is safe here (no device flow, no hang).
// 2. Exit 0 (authed) → SKIP the login entirely. Emit "✓ Already
// authenticated…" (with the handle resolved from gh's output when
// cheap; else omitted).
// 3. Non-zero (not authed) → do NOT drive an interactive `gh auth login`
// inside the wizard (that is the unkillable-hang fragility). HALT the
// wizard gracefully with an actionable instruction so the handler runs
// `gh auth login` directly in their own terminal (where it works fine)
// and re-runs `lyt init`.
//
// OUT OF SCOPE (F8-enhancement; future): a smooth async in-wizard
// `gh auth login` (cancellable spawn + timeout + spinner). This pass DEFUSES
// the hang via detect-skip + graceful-halt, which is sufficient for alpha.
//
// PG-8: argv-array shape; literal args; NO handler input concatenated.

// Parse the authenticated GitHub handle from `gh auth status` output. gh
// prints (to stderr in current versions, stdout in older) a line like:
// "✓ Logged in to github.com account your-github-handle (keyring)" (gh >= 2.40)
// "✓ Logged in to github.com as your-github-handle (…)" (older gh)
// Returns "" when no handle is parseable — the caller omits the name then.
export function parseGhHandleFromStatus(output: string): string {
  const m =
    /Logged in to \S+ account (\S+)/i.exec(output) ?? /Logged in to \S+ as (\S+)/i.exec(output);
  return m?.[1] ?? "";
}

export async function phase4_ghAuthLogin(
  dryRun: boolean,
  spawn: typeof spawnSync,
): Promise<WizardPhaseResult> {
  if (dryRun) {
    return {
      phase: 4,
      name: "gh-auth-login",
      ok: true,
      skipped: true,
      message:
        "[dry-run] would run: gh auth status (skip if authed; halt with instructions if not).",
    };
  }
  // Detect first — `gh auth status` is non-interactive + returns immediately.
  // Capture stdout+stderr so we can resolve the handle from gh's banner.
  const status = spawn("gh", ["auth", "status"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (status.error !== undefined) {
    // gh missing / spawn failure — halt with an actionable message (the same
    // not-authed remediation applies: get gh working, then re-run).
    recordInitFailure(
      {
        site: "gh-auth",
        step: "wizard:phase4_ghAuthLogin",
        summary: `gh auth status spawn failed: ${status.error.message}`,
        context: { reason: "spawn-error" },
      },
      { mode: "none" },
    );
    return {
      phase: 4,
      name: "gh-auth-login",
      ok: false,
      message:
        `Couldn't run \`gh auth status\` (${status.error.message}). ` +
        "Ensure GitHub CLI is installed and on PATH, then re-run `lyt init`.",
    };
  }
  if (status.status === 0) {
    // Authed — SKIP the login. Resolve the handle from gh's output if cheap.
    const combined = `${String(status.stdout ?? "")}\n${String(status.stderr ?? "")}`;
    const handle = parseGhHandleFromStatus(combined);
    const who = handle.length > 0 ? ` as ${handle}` : "";
    emit(`  ✓ Already authenticated${who} — skipping sign-in.`);
    return {
      phase: 4,
      name: "gh-auth-login",
      ok: true,
      skipped: true,
      message: `Already authenticated${who}; skipped gh auth login.`,
    };
  }
  // Not authed — HALT gracefully. Do NOT spawn an interactive `gh auth login`
  // (that is the unkillable-hang under blocking spawnSync). The handler runs
  // it directly in another terminal, then re-runs the wizard.
  recordInitFailure(
    {
      site: "gh-auth",
      step: "wizard:phase4_ghAuthLogin",
      summary: "gh auth status reported not signed in to GitHub",
      context: { reason: "not-authed", exitStatus: String(status.status) },
    },
    { mode: "none" },
  );
  return {
    phase: 4,
    name: "gh-auth-login",
    ok: false,
    message:
      "You're not signed in to GitHub. Run `gh auth login` in another terminal, then re-run `lyt init`.",
  };
}

// v1.G.13 Gap 2 — install Lyt skills BEFORE agent-manual injection so the
// next phase reads a populated skill catalog (instead of emitting the
// agent-manual.ts:340 "(skill catalog not detected at install time; re-run
// 'lyt agent-manual --install' after 'lyt skills install')" placeholder).
//
// Idempotency contract: symlinkSkillsTriRuntime returns "already-linked"
// on re-run (lyt-skills/symlink.ts:178). Wizard re-invocations don't drift
// the install — a 2nd run of `lyt init` reports the same shape.
//
// PG-8 shell-injection defenses: argv-array shape; literal string args;
// NO handler input concatenated into argv. Function name retains the
// "phase4b_" prefix per brief verify-script bullet 5 (greps for
// `phase4b_installSkills|phase4b_install`).
//
// hardening pass (cohort-test finding) — skills are an agent CONVENIENCE and must NEVER
// block pod creation. This function therefore NEVER returns a fatal (ok:false)
// result: a non-zero exit or a spawn-error degrades to a non-fatal warn
// (ok:true, skipped:true) so the wizard proceeds to Phases 6–12 and finishes
// with a healthy pod. The warn captures BOTH stdout and stderr (the actionable
// `divergent-symlink … re-run with --force` hint prints to stdout) and surfaces
// the `lyt skills install --force` remedy on the divergent-symlink path.
export async function phase4b_installSkills(
  dryRun: boolean,
  spawn: typeof spawnSync,
): Promise<WizardPhaseResult> {
  if (dryRun) {
    return {
      phase: 5,
      name: "skills-install",
      ok: true,
      skipped: true,
      message: "[dry-run] would invoke: lyt skills install",
    };
  }
  // F3 (console-DX): CAPTURE both streams instead of inheriting them. `lyt
  // skills install` prints one line per skill × runtime (~45 lines) which
  // previously dominated the wizard. The one-line phase message below is the
  // summary the user sees.
  const result = spawn("lyt", ["skills", "install"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.error !== undefined) {
    // skills are an agent CONVENIENCE — `lyt` not resolving here must NOT
    // block pod creation (the downstream phases call flows directly, not via the
    // `lyt` binary). Degrade to a non-fatal warn; the user can add skills later.
    const msg =
      `lyt skills install not found on PATH (npm install -g @younndai/lyt). ${result.error.message} ` +
      "— skipping (agent skills are optional; run `lyt skills install` later to add them).";
    emit(`  ⚠ ${msg}`);
    return { phase: 5, name: "skills-install", ok: true, skipped: true, message: msg };
  }
  if (result.status === 0) {
    return {
      phase: 5,
      name: "skills-install",
      ok: true,
      message: "Lyt skills installed tri-runtime (symlink/copy).",
    };
  }
  // Non-zero exit. NON-BLOCKING — degrade to a warn, never halt.
  // Combine BOTH streams for the tail + remedy detection: the actionable
  // `divergent-symlink … re-run with --force` hint prints to STDOUT (the
  // per-skill line in skills-install.ts:printHuman), so the prior stderr-only
  // tail dropped it and the user saw a bare "exited 2".
  const combined = `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`;
  // exit 2 (skills-install.ts:pickExitCode) — or the stdout marker — means a
  // divergent skill symlink: a `~/.claude|.codex|.agents/skills/lyt-*` link
  // points somewhere other than the bundled package. Lyt owns those names, so
  // `--force` safely adopts them. We surface the remedy rather than auto-forcing
  // (handler-leads: a divergent link may be a deliberate fork — let the user run
  // `--force` themselves instead of silently clobbering it). exit 4
  // (target-not-a-directory) and any other non-zero exit carry no `--force`
  // remedy (it wouldn't help) — they degrade to the same non-fatal warn with
  // the captured tail, so pod creation still proceeds.
  const divergent = result.status === 2 || /divergent-symlink|re-run with --force/i.test(combined);
  const tail = combined
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .slice(-3)
    .join("; ");
  // Plain-language remedy for a non-technical user (the resilience persona):
  // name the situation without jargon ("divergent symlinks"), reassure that
  // `--force` is safe (Lyt owns these skill names), and give the exact command.
  const remedy = divergent
    ? " — some Lyt skills already point elsewhere on your system; Lyt owns these skill names, so run `lyt skills install --force` to safely replace them"
    : "";
  const msg = `lyt skills install exited ${result.status}${remedy}${tail.length > 0 ? ` — ${tail}` : ""}`;
  emit(`  ⚠ ${msg}`);
  return { phase: 5, name: "skills-install", ok: true, skipped: true, message: msg };
}

export async function phase5_runAgentManualInject(
  dryRun: boolean,
  spawn: typeof spawnSync,
): Promise<WizardPhaseResult> {
  // PG-8: argv-array shape; NO --runtime value (the detect-all default);
  // NO string concat into shell. v1.GP F5: `lyt agent-manual --install`
  // with no --runtime injects into every DETECTED runtime (claude / codex
  // / agents). Replaces the prior single-pick `--runtime <runtime>` shape.
  const detected = detectInstalledRuntimes();
  if (dryRun) {
    const set = detected.length > 0 ? detected.join(", ") : "(none detected)";
    return {
      phase: 6,
      name: "agent-manual",
      ok: true,
      skipped: true,
      message: `[dry-run] would invoke: lyt agent-manual --install — would inject into: ${set}`,
    };
  }
  // Verb-signature: `lyt agent-manual --install` (no --runtime → detect-all).
  const result = spawn("lyt", ["agent-manual", "--install"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error !== undefined) {
    return {
      phase: 6,
      name: "agent-manual",
      ok: false,
      message: `lyt agent-manual not found on PATH (npm install -g @younndai/lyt). ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    return {
      phase: 6,
      name: "agent-manual",
      ok: false,
      message: `lyt agent-manual exited ${result.status}`,
    };
  }
  const set = detected.length > 0 ? detected.join(", ") : "all detected runtimes";
  return {
    phase: 6,
    name: "agent-manual",
    ok: true,
    message: `Agent manual installed into: ${set}.`,
  };
}

// v1.G.14 Gap 2 — Cross-machine adopt-detect (P5c).
//
// Probes for an existing pod repo at `{handle}/lyt-pod` (repo name) via
// `gh api /repos/{handle}/<federationRepoName()>`. The probe is informational
// only: it surfaces the existence to the handler but does not currently
// clone the federation or enumerate vaults. Full skip-and-clone adopt body
// is deferred to Brief B (the publish/sync + clone-adopt engine). pod.yon now
// lists meshes + vaults (@FED_MESH + @FED_VAULT derived from the
// registry), so enumerating a cloned pod's vaults is feasible once pods are
// pushed; the deferred Brief-B work will (a) clone the remote pod, read its
// pod.yon, AND (b) branch the wizard to skip P8/P9/P10 in adopt-mode.
//
// PG-8 shell-injection defenses (4-prong):
// 1. spawnSync ONLY with argv-array shape — NO exec/execSync.
// 2. `handle` is constrained by gh's own auth-resolution → URL-safe
// already; we additionally guard against empty + non-letter-prefix.
// 3. Endpoint constants are hardcoded — handler input only appears in
// the path segment after `/repos/{handle}/<repoName>` constant.
// 4. No shell interpolation; argv items are individual strings.
//
// Open seam: `probeFn` injectable for unit tests (matches existing
// wizard test-seam pattern, e.g. `spawnFn` on runWizard).

export interface FederationProbeResult {
  exists: boolean;
}

export type GhFederationProbe = (handle: string, spawn: typeof spawnSync) => FederationProbeResult;

// Production probe — single `gh api /repos/{handle}/<repoName>`
// call. Exit 0 → repo exists (HTTP 200). Non-zero → 404, auth failure,
// or network error; treated as "does not exist" so the wizard proceeds
// to fresh-init instead of halting on a transient probe failure.
// Federation init at P10 will surface real network issues authoritatively.

// PG-8 release review fix-pass: handle is validated against GitHub's
// published username constraint (alphanumeric + hyphen, 1-39 chars, no
// leading/trailing hyphen) BEFORE interpolation into the gh argv path
// segment. The prior implementation delegated character-safety to gh's
// server-side validation, which only fires AFTER spawn (and on Windows
// with shell:true a malformed cached handle could shell-inject). Defense-
// in-depth here: validate locally so a poisoned identity cache can't
// reach the spawn at all.
const GH_HANDLE_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export function defaultGhFederationProbe(
  handle: string,
  spawn: typeof spawnSync,
): FederationProbeResult {
  // PG-8 a review finding: refuse malformed handles BEFORE spawn so a poisoned
  // identity cache can't inject shell metachars (Windows `shell: true`).
  if (!GH_HANDLE_REGEX.test(handle)) {
    return { exists: false };
  }
  // PG-8: argv-array shape; literal endpoint; handle is now validated
  // against GitHub's username regex above. spawnSync argv items remain
  // individual strings — no shell concatenation even under shell:true.
  // repo-name segment routes through federationRepoName() ("lyt-pod")
  // — same chokepoint as `gh repo create`, so the probe and the create can
  // never drift on the repo name.
  const result = spawn("gh", ["api", `/repos/${handle}/${federationRepoName()}`, "--silent"], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  return { exists: result.status === 0 };
}

export async function phase5c_crossMachineAdoptDetect(
  handle: string,
  dryRun: boolean,
  spawn: typeof spawnSync,
  probeFn?: GhFederationProbe,
): Promise<WizardPhaseResult> {
  if (dryRun) {
    return {
      phase: 7,
      name: "cross-machine-adopt-detect",
      ok: true,
      skipped: true,
      message: `[dry-run] would probe ${handle || "<handle-unknown>"}/${federationRepoName()} existence via gh api`,
      data: { branch: "fresh" },
    };
  }
  if (handle.length === 0) {
    return {
      phase: 7,
      name: "cross-machine-adopt-detect",
      ok: true,
      skipped: true,
      message:
        "No gh handle resolvable from identity cache; skipping cross-machine adopt-detection.",
      data: { branch: "fresh" },
    };
  }
  const probe = probeFn ?? defaultGhFederationProbe;
  let probed: FederationProbeResult;
  try {
    probed = probe(handle, spawn);
  } catch (err) {
    recordInitFailure(
      {
        site: "network-probe",
        step: "wizard:phase5c_crossMachineAdoptDetect",
        summary: `gh federation probe failed: ${(err as Error).message}`,
        context: { handle, probe: `gh api /repos/${handle}/${federationRepoName()}` },
      },
      { mode: "none" },
    );
    return {
      phase: 7,
      name: "cross-machine-adopt-detect",
      ok: true,
      skipped: true,
      message: `gh federation probe failed (${(err as Error).message}); proceeding to fresh-init.`,
      data: { branch: "fresh" },
    };
  }
  if (!probed.exists) {
    return {
      phase: 7,
      name: "cross-machine-adopt-detect",
      ok: true,
      skipped: true,
      message: `No existing federation-repo found for ${handle}; proceeding to fresh-init.`,
      data: { branch: "fresh" },
    };
  }
  // W2.1 (DF-2 fix) — adopt-mode detected. Do NOT halt. Signal the wizard to
  // ADOPT the existing pod (clone + acquire vaults + reconcile) instead of
  // scaffolding a duplicate. The adopt is performed by the P8-adopt step
  // (phase_adoptPod → adoptAndPrimeFlow), which clones the pod, acquires the
  // user's vaults from gh, scaffolds personal/main ONLY if the pod had none,
  // and re-indexes. ok:true so the wizard proceeds (no halt, no partial
  // `~/lyt`).
  return {
    phase: 7,
    name: "cross-machine-adopt-detect",
    ok: true,
    skipped: false,
    message:
      `Existing pod repo found at ${handle}/${federationRepoName()}. ` +
      `Adopting it (clone + acquire vaults + re-index) instead of scaffolding a fresh pod.`,
    data: { branch: "adopted" },
  };
}

// W2.1 — P8-adopt. Runs the adopt-and-prime flow (clone the existing pod +
// acquire the user's vaults from gh + scaffold personal/main only if the pod
// had no acquirable vaults + Lane M reconcile). Subsumes the fresh-branch
// P8/P9/P10. Injectable via opts.adoptFlowOverride so the path is testable
// without live gh. Adopt failure is surfaced as ok:false (the wizard then
// halts gracefully — but it has NOT left a partial state: the adopt flow's own
// steps are each idempotent + non-fatal, and a re-run self-heals).
export async function phase_adoptPod(opts: WizardRunOptions): Promise<WizardPhaseResult> {
  if (opts.dryRun) {
    return {
      phase: 8,
      name: "adopt-pod",
      ok: true,
      skipped: true,
      message: "[dry-run] would adopt the existing pod (clone + acquire vaults + reconcile).",
      data: { branch: "adopted" },
    };
  }
  const adoptFlow = opts.adoptFlowOverride ?? adoptAndPrimeFlow;
  try {
    const result = await withPhaseWork("create", "your existing pod (adopt)", () =>
      adoptFlow({ noPush: true }),
    );
    const createdNote = result.firstVaultCreated
      ? " + scaffolded personal/main (pod had no acquirable vaults)"
      : "";
    // A recovery refusal is a failure, not a clean adopt. Its source-generated
    // reason carries the correct remedy for semantic invalidity versus failed
    // GitHub ownership authentication.
    if (result.manifestRefused === true) {
      return {
        phase: 8,
        name: "adopt-pod",
        ok: false,
        message:
          `Refusing the adopt of pod ${result.podHandle}/${federationRepoName()} — ` +
          `no vault was cloned. ${result.manifestRefusedReason ?? ""}`.trimEnd(),
        // a review finding — carry the refusal exit code (13) so the command maps it to
        // process.exitCode, distinct from the drop codes (12/11) and clean (0).
        data: {
          vaultPath: "",
          branch: "adopted",
          reconstructExitCode: reconstructionExitCode({ drops: [], refused: true }),
        },
      };
    }
    // G1 (0.12.1) — a reconstruction that DROPPED any vault is INCOMPLETE. Do
    // NOT report a clean adopt: surface the drops loudly and fail this phase
    // (ok:false → the wizard exits nonzero). The recover-pod flow already
    // console.error'd the classified per-vault summary; here we name the drops
    // in the phase message so the command surface is honest. Each dropped vault
    // is idempotently re-acquirable on a re-run once its cause (owner
    // mis-resolution vs a moved repo) is addressed.
    const drops = result.manifestDrops ?? [];
    if (drops.length > 0) {
      const names = drops.map((d) => d.vaultName).join(", ");
      return {
        phase: 8,
        name: "adopt-pod",
        ok: false,
        message:
          `Adopted pod ${result.podHandle}/${federationRepoName()} but reconstruction is ` +
          `INCOMPLETE — dropped ${drops.length} vault(s): ${names}. See the per-vault ` +
          `classification above (owner-misresolved = bug; repo-moved-or-deleted = state). ` +
          `Re-run after resolving the cause.`,
        // a review finding — carry the bug(12)/state(11) exit code so the command maps it
        // to process.exitCode.
        data: {
          vaultPath: result.primaryVaultPath ?? "",
          branch: "adopted",
          reconstructExitCode: reconstructionExitCode({ drops }),
        },
      };
    }
    return {
      phase: 8,
      name: "adopt-pod",
      ok: true,
      message:
        `Adopted pod ${result.podHandle}/${federationRepoName()} (${result.podBranch}); ` +
        `acquired ${result.vaultsAcquired} vault(s)${createdNote}; ` +
        `re-indexed ${result.reconciledVaultPaths.length}.`,
      data: { vaultPath: result.primaryVaultPath ?? "", branch: "adopted" },
    };
  } catch (err) {
    return {
      phase: 8,
      name: "adopt-pod",
      ok: false,
      message: `adopt-and-prime failed: ${(err as Error).message}`,
    };
  }
}

export async function phase6_createPersonalMesh(
  dryRun: boolean,
  options: { handle: string; connected: boolean } = {
    handle: deriveProvisionalHandle(),
    connected: false,
  },
): Promise<WizardPhaseResult> {
  // Existing helper for slug-safety; rejects '/' + Windows reserved names.
  try {
    validateMeshName("personal");
  } catch (err) {
    return {
      phase: 8,
      name: "mesh-init",
      ok: false,
      message: `validateMeshName failed: ${(err as Error).message}`,
    };
  }
  if (dryRun) {
    return {
      phase: 8,
      name: "mesh-init",
      ok: true,
      skipped: true,
      message: "[dry-run] would create `personal` mesh + `personal/main` vault.",
    };
  }
  try {
    const attemptId = uuid7BytesToDashedString(newUuidv7Bytes());
    const destinationRequest = options.connected
      ? ({ kind: "auto" } as const)
      : ({ kind: "local" } as const);
    const subject = { kind: "mesh" as const, repositoryName: vaultRepoName("personal/main") };
    const preflight = await inspectMeshInitPreflight({ name: "personal" });
    const operationId = deriveCreationOperationIdV1({
      request: destinationRequest,
      subject,
      scope: `personal/main\0${join(getDefaultVaultsRoot(), "personal", "main")}`,
    });
    const planned = resolveCreationPlanV1({
      request: destinationRequest,
      subject,
      actor: {
        attempt_id: attemptId,
        observed_at: new Date().toISOString(),
        result: "unknown",
        actor: null,
        evidence_class: "unavailable",
      },
      intendedEffects: withCreationRepositoryEffectsV1(
        plannedSingleVaultEffectsV1({
          operationId,
          pod:
            preflight.podIdentity.state === "present"
              ? { kind: "existing", rid: preflight.podIdentity.rid }
              : { kind: "create", handle: options.handle },
          mesh: { kind: "create", name: "personal" },
          vaultName: "personal/main",
          vaultRoot: join(getDefaultVaultsRoot(), "personal", "main"),
        }),
        preflight.podIdentity.state === "present"
          ? [
              {
                repositoryRoot: preflight.podIdentity.repositoryRoot,
                exactPaths: ["pod.yon"],
              },
            ]
          : [],
      ),
    });
    if (planned.kind === "refusal") throw new Error(planned.message);
    const result = await withPhaseWork("git-init", "your `personal` mesh + main vault", () =>
      meshInitFlow({
        name: "personal",
        noPush: true,
        creation: {
          destinationRequest,
          creationPlan: planned.plan,
          attemptId,
        },
      }),
    );
    return {
      phase: 8,
      name: "mesh-init",
      ok: true,
      message: `Created mesh '${result.meshName}' with main vault at ${result.mainVault.path}`,
      // the `personal/main` vault scaffolded by mesh-init IS the
      // pod's first (and only) vault on init. Surface its path so P9 can
      // resolve it (instead of scaffolding a duplicate) and P12 can run the
      // first-use demo against it.
      data: {
        vaultPath: result.mainVault.path,
        creation: { plan: result.creationPlan, mutations: result.mutations },
      },
    };
  } catch (err) {
    recordInitFailure({
      site: "first-vault-create",
      step: "wizard:phase6_createPersonalMesh",
      summary: `meshInitFlow failed (personal mesh + personal/main vault): ${(err as Error).message}`,
      context: { mesh: "personal" },
    });
    return {
      phase: 8,
      name: "mesh-init",
      ok: false,
      message: `meshInitFlow failed: ${(err as Error).message}`,
    };
  }
}

// first vault on init is `personal/main` ONLY.
//
// The naming convention locks the pod's main vault to the literal `main`
// under the `personal` mesh. That vault is scaffolded by P8's mesh-init
// (meshInitFlow → `personal/main`), so P9 no longer prompts for a vault
// NAME (the prior `notes` default created a second, redundant vault) and
// no longer scaffolds anything. It resolves the `personal/main` path
// produced by P8 so P12's first-use demo can run against it.
//
// Divergence from the oversight-handler lean ("keep the placement-override
// prompt"): the placement override is dropped. It existed to relocate a
// handler-NAMED first vault; once the first vault is locked to
// `personal/main` created by mesh-init at the canonical
// `~/lyt/vaults/personal/main`, there is no separate placement to
// override here — keeping the prompt would either no-op or collide with
// the already-scaffolded mesh main. Threading placement into mesh-init is
// a larger surface change out of this cluster's scope; a separate-drive
// placement override for the pod main vault is a clean follow-up.
export async function phase7_createFirstVault(
  mainVaultPath: string,
  dryRun: boolean,
): Promise<WizardPhaseResult> {
  if (dryRun) {
    return {
      phase: 9,
      name: "vault-init",
      ok: true,
      skipped: true,
      message: "[dry-run] first vault is `personal/main` (created by the personal mesh in P8).",
      data: { vaultPath: mainVaultPath },
    };
  }
  if (mainVaultPath.length === 0 || !existsSync(mainVaultPath)) {
    recordInitFailure({
      site: "first-vault-create",
      step: "wizard:phase7_createFirstVault",
      summary: `first vault path not resolvable from the personal mesh: ${mainVaultPath || "<empty>"}`,
      context: { mainVaultPath: mainVaultPath || "<empty>" },
    });
    return {
      phase: 9,
      name: "vault-init",
      ok: false,
      message: `First vault path not resolvable from the personal mesh (${mainVaultPath || "<empty>"}); halting.`,
    };
  }
  return {
    phase: 9,
    name: "vault-init",
    ok: true,
    message: `First vault is \`personal/main\` at ${mainVaultPath}.`,
    data: { vaultPath: mainVaultPath },
  };
}

export async function phase8_initFederationRepo(
  dryRun: boolean,
  localOnly = false,
): Promise<WizardPhaseResult> {
  if (dryRun) {
    return {
      phase: 10,
      name: "federation-init",
      ok: true,
      skipped: true,
      message:
        "[dry-run] would create the local pod repository and stage local content only; run `lyt sync` later to create an online copy.",
    };
  }
  try {
    // Pod creation is always local-only; scoped sync owns remote creation and
    // publication after the handler explicitly chooses to run it.
    const result = await withPhaseWork("create", "your local pod", () =>
      federationInitFlow({
        pushToRemote: false,
        createRemoteIfMissing: false,
        localOnly: true,
        visibility: "private",
      }),
    );
    return {
      phase: 10,
      name: "federation-init",
      ok: true,
      // Brief C (F3) + honest text. local → "local pod (not on GitHub) —
      // run `lyt sync` to connect"; connected → created/adopted/staged.
      message: federationPhaseMessage(result, localOnly),
    };
  } catch (err) {
    recordInitFailure({
      site: "federation-init",
      step: "wizard:phase8_initFederationRepo",
      summary: `federationInitFlow failed: ${(err as Error).message}`,
      context: { localOnly: String(localOnly) },
    });
    return {
      phase: 10,
      name: "federation-init",
      ok: false,
      message: `federationInitFlow failed: ${(err as Error).message}`,
    };
  }
}

// Build the local-first end-of-phase pod-repo message. Creation never creates
// or attaches a remote; `lyt sync` is the only online mutation owner.
function federationPhaseMessage(
  result: Awaited<ReturnType<typeof federationInitFlow>>,
  localOnly = false,
): string {
  const where = `local: ${result.localPath}`;
  if (localOnly) {
    // the pod is a LOCAL git repo; no gh repo, no remote. Connect later.
    return `Local pod ready (${result.remoteFullName} — not on GitHub yet) · run \`lyt sync\` to connect + back up. ${where}`;
  }
  if (result.remoteCreated) {
    return `Local pod ready (${result.remoteFullName}) · run \`lyt sync\` to create and publish its online copy. ${where}`;
  }
  if (result.branch === "adopted") {
    return `Pod repo on GitHub (${result.remoteFullName}; adopted) · content staged — run \`lyt sync\` to publish. ${where}`;
  }
  // cached / no-remote-created: the repo is wired but not freshly created here.
  return `Pod repo ready (${result.remoteFullName}; ${result.branch}) — run \`lyt sync\` to publish. ${where}`;
}

// P11 compatibility seam. Pod-map generation is retired; keep one release
// window with an explicit skipped result so integrations that count the
// wizard's 12 phases do not break silently.
export async function phase9_podMapInit(
  _owner: string,
  _dryRun: boolean,
): Promise<WizardPhaseResult> {
  return {
    phase: 11,
    name: "pod-map-init",
    ok: true,
    skipped: true,
    message: "Skipped — pod maps are retired viewer artifacts and are not generated.",
  };
}

const WELCOME_FIGMENT_BODY = "Welcome to Lyt — your federated vaults are ready.";

export async function phase10_firstUseDemo(
  vaultPath: string,
  dryRun: boolean,
): Promise<WizardPhaseResult> {
  if (dryRun) {
    return {
      phase: 12,
      name: "first-use-demo",
      ok: true,
      skipped: true,
      message: "[dry-run] would write a 'Welcome to Lyt' figment + read it back.",
    };
  }
  if (vaultPath.length === 0 || !existsSync(vaultPath)) {
    return {
      phase: 12,
      name: "first-use-demo",
      ok: false,
      message: `First vault path not resolvable (${vaultPath || "<empty>"}); skipping demo.`,
    };
  }
  // Release review Cor-C1 + Sec-M2 fix-pass (destination-write-symlink-follow,
  // 2nd instance of NEW family seeded at G.5). Three defences before
  // writeFileSync:
  // (a) path.resolve absolute root + startsWith(notesDir) — blocks lexical
  // `..` traversal.
  // (b) lstatSync on the vault root, notesDir (if exists), and figmentPath
  // (if exists) — refuses any symlink-shaped destination, so an
  // attacker- or stale-environment-planted `<vault>/notes →
  // /etc/passwd`-shaped link cannot be followed.
  // (c) writeFileSync is invoked only after both (a) + (b) pass.
  const today = new Date().toISOString().slice(0, 10);
  const filename = `${today}-welcome-to-lyt.md`;
  const notesDir = pathResolve(vaultPath, "notes");
  const figmentPath = pathResolve(notesDir, filename);
  // (a) lexical traversal defence.
  if (!figmentPath.startsWith(notesDir)) {
    return {
      phase: 12,
      name: "first-use-demo",
      ok: false,
      message: `Resolved figment path escapes notes/ dir; refusing: ${figmentPath}`,
    };
  }
  // (b) symlink-follow defence — apply per G.5 NEW family-seed pattern.
  // Check vault root, notesDir (if exists), and figmentPath (if exists).
  try {
    if (lstatSync(vaultPath).isSymbolicLink()) {
      return {
        phase: 12,
        name: "first-use-demo",
        ok: false,
        message: `Refusing first-use demo: vault path is a symlink: ${vaultPath}`,
      };
    }
    if (existsSync(notesDir) && lstatSync(notesDir).isSymbolicLink()) {
      return {
        phase: 12,
        name: "first-use-demo",
        ok: false,
        message: `Refusing first-use demo: notes/ is a symlink: ${notesDir}`,
      };
    }
    if (existsSync(figmentPath) && lstatSync(figmentPath).isSymbolicLink()) {
      return {
        phase: 12,
        name: "first-use-demo",
        ok: false,
        message: `Refusing first-use demo: target figment is a symlink: ${figmentPath}`,
      };
    }
  } catch (err) {
    return {
      phase: 12,
      name: "first-use-demo",
      ok: false,
      message: `lstat defence failed: ${(err as Error).message}`,
    };
  }
  mkdirSync(notesDir, { recursive: true });
  const isoTs = new Date().toISOString();
  const content =
    `---\n` +
    `title: "Welcome to Lyt"\n` +
    `created: ${isoTs}\n` +
    `modified: ${isoTs}\n` +
    `tags: [lyt, welcome]\n` +
    `purpose: "First-use demo Figment created by the lyt setup wizard."\n` +
    `topic: "lyt"\n` +
    `mesh-visibility: local\n` +
    `weight: 3\n` +
    `meta: {}\n` +
    `---\n\n` +
    `${WELCOME_FIGMENT_BODY}\n`;
  try {
    writeFileSync(figmentPath, content, "utf8");
  } catch (err) {
    return {
      phase: 12,
      name: "first-use-demo",
      ok: false,
      message: `Capture write failed: ${(err as Error).message}`,
    };
  }
  // Read-back recall: load + assert content includes "welcome".
  let recalled: string;
  try {
    recalled = readFileSync(figmentPath, "utf8");
  } catch (err) {
    return {
      phase: 12,
      name: "first-use-demo",
      ok: false,
      message: `Recall read failed: ${(err as Error).message}`,
    };
  }
  if (!/welcome/i.test(recalled)) {
    return {
      phase: 12,
      name: "first-use-demo",
      ok: false,
      message: `Recall sanity-check failed (no 'welcome' match) at ${figmentPath}`,
    };
  }
  // V-C-1 (L1 index-on-write) — the welcome figment is on disk; index it so the
  // wizard's "captured + recalled" promise is true for a REAL subsequent
  // `lyt search welcome` (the §0 evidence: the demo wrote the file but never
  // indexed it, so search returned perTier [0,0,0,0] until a manual reindex).
  // captureIndexFlow resolves the vault by path + NEVER throws — a deferred
  // index is surfaced as a non-fatal note, never a failed demo (the figment is
  // saved + readable, which is what the demo proves).
  const relPath = `notes/${filename}`;
  let indexNote = "";
  try {
    const idx = await captureIndexFlow({ vaultPath, relPath });
    if (idx.deferred && idx.note !== undefined) {
      indexNote = ` (index ${idx.note})`;
    }
  } catch {
    // Defensive — captureIndexFlow is contracted never to throw, but the demo
    // must stay non-fatal regardless.
    indexNote = " (index deferred; run `lyt reindex`)";
  }
  return {
    phase: 12,
    name: "first-use-demo",
    ok: true,
    message: `Captured + recalled ${figmentPath}${indexNote}`,
  };
}

// ---- Helpers ----

function platformInstallerName(p: Platform): string {
  switch (p) {
    case "win32":
      return "winget";
    case "darwin":
      return "brew";
    case "linux":
      return "apt-get or dnf";
  }
}

function emit(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line);
}

// v1.GP F7-followup — run a heavy NON-interactive wizard phase under a
// phase-spanning spinner so the synchronous work (mesh forge, vault scaffold,
// libSQL writes, git init, pod.yon write) shows a
// live label + elapsed instead of a silent multi-second gap. Single-threaded
// Node can't animate frames INSIDE one blocking sync call (accepted), but the
// `setImmediate` yield lets the render interval fire at the boundary so the
// label + (Ns) appear; per-op gh/git spinners deep in the flow defer to this
// outer spinner (single-spinner invariant in util/spinner.ts). The spinner is
// torn down (line cleared + cursor restored) on return AND on throw via the
// finally — so an exception never leaves the cursor hidden before the next
// `emit()` header. NOT used for interactive phases (prompts need a clear line
// + visible cursor) — only the work phases that previously ran dark.
async function withPhaseWork<T>(op: SpinnerOp, label: string, fn: () => Promise<T>): Promise<T> {
  const spinner = startSpinner();
  spinner.phase(op, label);
  // Yield so the first frame + label render before the blocking work begins.
  await new Promise<void>((r) => setImmediate(r));
  try {
    return await fn();
  } finally {
    spinner.stop();
  }
}

// Default readline-backed prompt handler. Production callers use this;
// tests inject a stub via runWizard({promptHandler: <stub>}).
export class ReadlinePromptHandler implements IPromptHandler {
  private rl = createInterface({ input: process.stdin, output: process.stdout });

  async ask(question: string, defaultValue?: string): Promise<string> {
    const prompt = defaultValue !== undefined ? `${question} [${defaultValue}] ` : `${question} `;
    const answer = (await this.rl.question(prompt)).trim();
    return answer.length === 0 && defaultValue !== undefined ? defaultValue : answer;
  }

  async confirm(question: string, defaultValue?: boolean): Promise<boolean> {
    const suffix = defaultValue === true ? "[Y/n]" : defaultValue === false ? "[y/N]" : "[y/n]";
    const raw = (await this.rl.question(`${question} ${suffix} `)).trim().toLowerCase();
    if (raw.length === 0 && defaultValue !== undefined) return defaultValue;
    return raw === "y" || raw === "yes";
  }

  async select<T>(question: string, options: { label: string; value: T }[]): Promise<T> {
    // eslint-disable-next-line no-console
    console.log(question);
    options.forEach((opt, i) => {
      // eslint-disable-next-line no-console
      console.log(`  ${i + 1}) ${opt.label}`);
    });
    while (true) {
      const raw = (await this.rl.question("Choose [1]: ")).trim();
      const n = raw.length === 0 ? 1 : Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 1 && n <= options.length) {
        return options[n - 1]!.value;
      }
      // eslint-disable-next-line no-console
      console.log(`  ! Please enter a number 1..${options.length}`);
    }
  }

  close(): void {
    this.rl.close();
  }
}
