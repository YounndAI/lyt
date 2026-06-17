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
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

import { meshInitFlow } from "./mesh-init.js";
import { captureIndexFlow } from "./capture-index.js";
import { federationInitFlow } from "./federation/init.js";
import {
  reconcilePublishFlow,
  type ReconcilePublishResult,
} from "./federation/reconcile-publish.js";
import { adoptAndPrimeFlow } from "./adopt-and-prime.js";
import { generatePodMapFlow, installPodManagerPlugin } from "./pod-map-generate.js";
import { detectInstalledRuntimes } from "./agent-manual.js";
import {
  deriveProvisionalHandle,
  getHandleFromIdentity,
  isValidGhHandle,
  validateMeshName,
} from "../util/identity.js";
import { writeProvisionalIdentity } from "../util/identity-cache.js";
import {
  federationRepoName,
  federationRepoFullName,
  getFederationRepoDir,
  slugifyHandle,
} from "../util/federation-paths.js";
import { getDefaultVaultsRoot } from "../util/paths.js";
import { recordInitFailure } from "../util/failure-log.js";
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
// Per the ratified default (phased, handler-ratified 2026-06-01): 9 of 10 phases shipped
// in G.4 with Phase 9 deferred. v1.G.10 RE-WIRES the pod-map phase (now P11)
// to invoke the pod-map vault generator + install the Pod Manager Obsidian
// plugin (per G.4 retro @RECOMMENDATIONS #2 load-bearing contract).
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
// P11 Pod-map vault + plugin install (generatePodMapFlow + installPodManagerPlugin)
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
  // Brief C (F1) test seam — override the consented publish engine so the
  // end-of-wizard staged-HIL publish prompt can be exercised without live
  // gh/git. Defaults to the real reconcilePublishFlow.
  publishFlowOverride?: typeof reconcilePublishFlow;
}

export interface WizardRunResult {
  status: "completed" | "halted";
  phases: WizardPhaseResult[];
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
  const p4b = await phase4b_installSkills(opts.dryRun, spawn);
  phases.push(p4b);
  if (!p4b.ok && !p4b.skipped) return { status: "halted", phases };

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
    await establishProvisionalIdentity(ph, opts.dryRun, isTty);
  }

  // firstVaultPath + ownerForPodMap feed the shared P11/P12 tail, sourced from
  // the adopt branch OR the fresh-scaffold branch (local or connected).
  let firstVaultPath = "";
  let ownerForPodMap = "";

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
    ownerForPodMap = handleForProbe.length > 0 ? handleForProbe : safeHandleForOwner();
  } else {
    // FRESH — scaffold personal mesh + first vault + pod repo. `localMode` (no
    // gh / chose local) forges the pod LOCAL-ONLY (no gh repo, no remote);
    // connected mode creates the pod container repo per two-tier consent.
    const localMode = mode === "local";
    emit(
      "\nPhase 8 — Create your `personal` mesh\nA mesh is a named group of vaults; `personal` is the default starter mesh.",
    );
    const p6 = await phase6_createPersonalMesh(opts.dryRun);
    phases.push(p6);
    if (!p6.ok && !p6.skipped) return { status: "halted", phases };

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
    const p8 = await phase8_initFederationRepo(opts.dryRun, localMode);
    phases.push(p8);
    if (!p8.ok && !p8.skipped) return { status: "halted", phases };

    firstVaultPath = p7.data?.vaultPath ?? "";
    ownerForPodMap = resolveOwnerForPodMap(p8);
  }

  // P11 — pod-map vault auto-init + Pod Manager plugin install (v1.G.10).
  // Owner derives from the fresh federation-init handle OR (adopt branch) the
  // probed handle. If unknown, the generator returns ok:false (the ratified default refuse)
  // and the wizard surfaces the gap to the handler.
  emit(
    "\nPhase 11 — Pod-map vault\n" +
      "Generating your pod-map vault at `lyt-pod-map` — every mesh + vault gets " +
      "a note; wikilinks encode federation edges; Obsidian's graph view renders the " +
      "topology natively. The Pod Manager community plugin installs alongside for " +
      "mesh-boundary coloring + 🔒 read-only badges. (writable=false; generator-managed.)",
  );
  const p9 = await phase9_podMapInit(ownerForPodMap, opts.dryRun);
  phases.push(p9);
  if (!p9.ok && !p9.skipped) return { status: "halted", phases };

  // P12 — first-use demo against the resolved primary vault path. R1 cold-
  // review fix-pass: if the adopt branch couldn't resolve a vault (e.g. a
  // torn-mesh repair case), SKIP the demo gracefully rather than halting the
  // wizard — the pod is still adopted, and a non-fatal init is the contract.
  emit("\nPhase 12 — First-use demo\nCapturing a 'Welcome to Lyt' sample Figment + recalling it.");
  let p10: WizardPhaseResult;
  if (!opts.dryRun && firstVaultPath.length === 0) {
    p10 = {
      phase: 12,
      name: "first-use-demo",
      ok: true,
      skipped: true,
      message: "Skipped — no primary vault resolved (adopt left a repair case); run 'lyt doctor'.",
    };
  } else {
    p10 = await phase10_firstUseDemo(firstVaultPath, opts.dryRun);
  }
  phases.push(p10);

  // v1.GP WS4 — end-of-init pod card + clickable links + Next-steps trio.
  // Skipped under --dry-run (the phase-walk output stays deterministic; a
  // dry-run has no real paths to surface). On a real run, the card LEADS with
  // "pod" and bridges "federation" once, with OSC 8 hyperlinks when
  // the terminal supports them (graceful plain-text fallback otherwise).
  if (!opts.dryRun) {
    const localMode = mode === "local";
    emitPodCard(firstVaultPath, localMode);
    if (localMode) {
      // a local pod has no gh to publish to. NO publish
      // prompt; nudge to CONNECT instead (the self-heal lives in `lyt sync`).
      emit(
        "\nYour pod is local-only (not connected to GitHub). Run `lyt sync` to connect + back it up.\n",
      );
    } else {
      // Brief C (F1) — staged-HIL publish prompt. The wizard materialized the pod
      // LOCALLY (mesh/federation init held the push; the pod CONTAINER repo may
      // already exist on GitHub per two-tier consent, but the CONTENT —
      // vault repos + pod push — is HELD until this consent). Offer to publish now
      // (default-Yes per the ratified default); the prompt itself IS the explicit content-consent.
      // Skipped on a non-TTY (never hangs).
      await maybePromptAndPublishWizard(ph, {
        isTty: process.stdin.isTTY === true,
        publishFlow: opts.publishFlowOverride ?? reconcilePublishFlow,
      });
    }
  } else {
    emit("\nDone. Your pod is ready.\n");
  }

  const completed = phases.every((p) => p.ok || p.skipped === true);
  return { status: completed ? "completed" : "halted", phases };
}

export interface WizardPublishPromptDeps {
  // Whether stdin is an interactive TTY. A non-TTY MUST NOT prompt (the prompt
  // would hang a script waiting on stdin) — it surfaces the staged nudge instead.
  isTty: boolean;
  // The consented publish engine (injected for tests). The real impl regen's
  // pod.yon → creates missing vault repos + pushes → commits + pushes the pod,
  // resumable via the outbox.
  publishFlow: typeof reconcilePublishFlow;
}

// Brief C (F1) — the end-of-wizard staged-HIL publish prompt. Default-Yes
// publishing is the expected end-state and the prompt is the explicit
// consent (two-tier consent — running the prompt's "Yes" is the
// content-publish consent; "No" genuinely holds the pod staged). Exported so it
// can be unit-tested with a stub prompt handler + injected publish flow.
//
// Release review invariants this encodes: non-TTY NEVER prompts (no hang); "No"
// publishes nothing (the flow is not called); a single "Yes" calls the engine
// exactly once (the wizard performs no other outward publish, so no
// double-publish is possible).
export async function maybePromptAndPublishWizard(
  ph: IPromptHandler,
  deps: WizardPublishPromptDeps,
): Promise<void> {
  if (!deps.isTty) {
    emit("\nYour pod is staged locally (not published). Run `lyt sync` to publish it to GitHub.");
    return;
  }

  // Release review F1 (I1+Mi1) — branch-agnostic wording: "pushes … + its vault
  // repo(s)" reads honestly after BOTH a fresh scaffold AND an adopt (where the
  // vault repos already exist on GitHub — "creates" would lie there), and aligns
  // with the --auto path's phrasing (init.ts) for cross-path consistency.
  const yes = await ph.confirm(
    "\nPublish your pod to GitHub now? (pushes your pod + its vault repo(s))",
    true,
  );
  if (!yes) {
    emit("Staged. Run `lyt sync` when you're ready to publish to GitHub.");
    return;
  }

  emit("Publishing your pod to GitHub…");
  // Release review F1 (M2) — a throw here (e.g. registry/outbox open failure) is
  // INTENTIONALLY left to propagate: runWizard awaits this helper, and its caller
  // (lyt init's --wizard branch) wraps runWizard in a try/catch that surfaces the
  // failure as `wizard-error` + a non-zero exit. The engine does NOT throw on a
  // normal partial/conflict publish — it returns `result.ok=false` (handled
  // below) and a partial push is always resumable via `lyt sync` (outbox). A
  // try/catch is kept OUT of here so a real failure isn't swallowed into a
  // falsely-clean wizard finish.
  const result: ReconcilePublishResult = await deps.publishFlow({ push: true });
  if (result.skipped) {
    emit(`Publish skipped — ${result.reason ?? "no pod"}.`);
    return;
  }
  const pushed = result.vaultOutcomes.filter((o) => o.pushed).length;
  if (result.ok) {
    emit(`✓ Published to GitHub — ${pushed} vault repo(s) + your pod.`);
    return;
  }
  emit(
    `⚠ Partial publish — ${pushed} vault(s) pushed; ${result.outboxRemaining} op(s) pending. ` +
      "Re-run `lyt sync` to finish (resumable, no data lost).",
  );
  for (const o of result.vaultOutcomes) {
    if (o.status === "conflict" || o.status === "failed") {
      emit(`  ${o.status}: ${o.vaultName} — ${o.message}`);
    }
  }
}

// Build + print the WS4 pod card. Best-effort: handle resolution / pod-map
// presence are tolerant (a missing piece simply doesn't render). Never throws
// into the wizard return path. `localOnly` drives the honest "not
// connected to GitHub" status line (vs the connected "staged" wording).
function emitPodCard(firstVaultPath: string, localOnly: boolean): void {
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

  // First vault: always `personal/main` (mesh-init's main vault).
  const vaultLeaf = firstVaultPath.length > 0 ? basenameOf(firstVaultPath) : "main";
  const vaultName = `personal/${vaultLeaf}`;

  // the pod-map vault sits FLAT under `vaults/` (no `<owner>` segment)
  // — mirrors derivePodMapPaths in pod-map-generate.ts.
  const ownerSlug = slugifyHandle(handle);
  const podMapPath = join(getDefaultVaultsRoot(), "lyt-pod-map");

  // no `obsidian://open` deep-link — the card emits the honest
  // file:// vault-FOLDER path + "Open folder as vault" instruction for every
  // vault, so no per-vault verified-file (README) resolution is needed here.
  const data: PodCardData = {
    handle,
    mesh: {
      meshName: "personal",
      vaultName,
      vaultPath: firstVaultPath,
    },
    podRepoFullName: federationRepoFullName(handle),
    podLocalPath: getFederationRepoDir(handle),
    ...(existsSync(podMapPath)
      ? {
          podMapVaultPath: podMapPath,
          ownerSlug,
        }
      : {}),
    hyperlinksEnabled: process.stdout.isTTY === true,
    // local pod → "not connected to GitHub"; connected (staged) pod →
    // "not yet published". Both lead the Next-steps with `lyt sync`.
    publishState: localOnly ? "local-only" : "staged",
  };

  emit(renderPodCard(data));
  // Brief C (F4) + the wizard's pod is always unpublished at this point
  // (staged or local-only), so the Next-steps lead with `lyt sync`.
  emit(renderNextSteps({ unpublished: true }));
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
async function establishProvisionalIdentity(
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
  writeProvisionalIdentity(handle);
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
    recordInitFailure({
      site: "gh-auth",
      step: "wizard:phase4_ghAuthLogin",
      summary: `gh auth status spawn failed: ${status.error.message}`,
      context: { reason: "spawn-error" },
    });
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
  recordInitFailure({
    site: "gh-auth",
    step: "wizard:phase4_ghAuthLogin",
    summary: "gh auth status reported not signed in to GitHub",
    context: { reason: "not-authed", exitStatus: String(status.status) },
  });
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
  // F3 (console-DX): CAPTURE the sub-command output instead of inheriting it.
  // `lyt skills install` prints one line per skill × runtime (~45 lines) which
  // previously dominated the wizard. The one-line phase message below is the
  // summary the user sees; on failure a short stderr tail is surfaced.
  const result = spawn("lyt", ["skills", "install"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.error !== undefined) {
    return {
      phase: 5,
      name: "skills-install",
      ok: false,
      message: `lyt skills install not found on PATH (npm install -g @younndai/lyt). ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    const errTail = String(result.stderr ?? "")
      .trim()
      .split(/\r?\n/)
      .filter((l) => l.length > 0)
      .slice(-3)
      .join("; ");
    return {
      phase: 5,
      name: "skills-install",
      ok: false,
      message: `lyt skills install exited ${result.status}${errTail.length > 0 ? ` — ${errTail}` : ""}`,
    };
  }
  return {
    phase: 5,
    name: "skills-install",
    ok: true,
    message: "Lyt skills installed tri-runtime (symlink/copy).",
  };
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
    recordInitFailure({
      site: "network-probe",
      step: "wizard:phase5c_crossMachineAdoptDetect",
      summary: `gh federation probe failed: ${(err as Error).message}`,
      context: { handle, probe: `gh api /repos/${handle}/${federationRepoName()}` },
    });
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

// Resolve the gh handle for the pod-map owner in the adopt branch (the probe
// handle may have been empty if identity wasn't cached when P7 ran).
function safeHandleForOwner(): string {
  try {
    return getHandleFromIdentity();
  } catch {
    return "";
  }
}

export async function phase6_createPersonalMesh(dryRun: boolean): Promise<WizardPhaseResult> {
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
    const result = await withPhaseWork("git-init", "your `personal` mesh + main vault", () =>
      meshInitFlow({ name: "personal", noPush: true }),
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
      data: { vaultPath: result.mainVault.path },
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
      // Brief C (F3) — honest dry-run preview: a real run CREATES the pod
      // container repo on GitHub (two-tier consent) and STAGES content
      // locally (push held). Not "local-only".
      message:
        "[dry-run] would create the pod repo on GitHub + stage content locally (push held until `lyt sync`).",
    };
  }
  try {
    // local mode forges the pod LOCAL-ONLY (no gh probe, no remote);
    // connected mode creates the gh container repo (push still held).
    const result = await withPhaseWork(
      "create",
      localOnly ? "your local pod" : "your pod repo",
      () => federationInitFlow({ pushToRemote: false, localOnly, visibility: "private" }),
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

// Brief C (F3) — build the honest end-of-phase pod-repo message. The federation
// init holds the push (pushToRemote:false) but, per two-tier consent, the
// pod CONTAINER repo IS created on GitHub on a fresh forge (remoteCreated). So
// the message must distinguish created-on-GitHub / adopted / cached from the
// stale "local-only" — and always point at `lyt sync` as the publish step.
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
    return `Pod repo created on GitHub (${result.remoteFullName}) · content staged (unpushed) — run \`lyt sync\` to publish. ${where}`;
  }
  if (result.branch === "adopted") {
    return `Pod repo on GitHub (${result.remoteFullName}; adopted) · content staged — run \`lyt sync\` to publish. ${where}`;
  }
  // cached / no-remote-created: the repo is wired but not freshly created here.
  return `Pod repo ready (${result.remoteFullName}; ${result.branch}) — run \`lyt sync\` to publish. ${where}`;
}

// v1.G.10 — Phase 10 (post-G.13 numbering) pod-map vault auto-init + Pod
// Manager plugin install. Per G.4 retro @RECOMMENDATIONS #2 LOAD-BEARING
// contract: replaces the G.4-era phase9_deferred() stub. Generator runs
// the markdown emission;
// installer copies the plugin from packages/lyt-vault/obsidian-plugins/
// lyt-pod-manager/ into <pod-map-vault>/.obsidian/plugins/lyt-pod-manager/.
//
// Owner unknown → ok:false with the the ratified default refuse message; halt-on-fail in
// runWizard so the handler explicitly gh-auth-logins before retry.
//
// Plugin install conflict-handling (the ratified default condition 4): if the install
// dir already has manifest.json (community-store install, or prior
// wizard run), the install is SKIPPED rather than overwriting — defers
// to the user-controlled store install to keep semver in lockstep.
export async function phase9_podMapInit(
  owner: string,
  dryRun: boolean,
): Promise<WizardPhaseResult> {
  if (dryRun) {
    return {
      phase: 11,
      name: "pod-map-vault",
      ok: true,
      skipped: true,
      message: `[dry-run] would generate pod-map vault at <vaults-root>/${owner || "<owner-unknown>"}/lyt-pod-map + install Pod Manager plugin`,
    };
  }
  const genResult = await withPhaseWork("pod-map", "your pod-map vault", () =>
    generatePodMapFlow({ owner }),
  );
  if (!genResult.ok) {
    return {
      phase: 11,
      name: "pod-map-vault",
      ok: false,
      message: `pod-map vault auto-init failed: ${genResult.error}`,
    };
  }
  // Plugin install. The source dir resolves relative to this file's
  // built location: `<lyt-vault>/dist/flows/wizard.js` → `../../obsidian-plugins/lyt-pod-manager/`.
  const pluginSourceDir = resolvePluginSourceDir();
  const installResult = installPodManagerPlugin({
    pluginInstallDir: genResult.paths.pluginInstallDir,
    pluginSourceDir,
  });
  const installNote = installResult.skipped
    ? " (plugin install skipped — already present)"
    : installResult.ok
      ? ""
      : ` (plugin install failed: ${installResult.reason})`;
  // A failed plugin install is non-fatal (the pod-map vault still
  // renders in stock Obsidian per the degrade-to-baseline contract).
  return {
    phase: 11,
    name: "pod-map-vault",
    ok: true,
    message: `pod-map vault generated at ${genResult.vaultPath} (${genResult.meshCount} mesh(es), ${genResult.vaultCount} vault(s), ${genResult.notesEmitted} note(s))${installNote}`,
  };
}

// Owner resolution for Phase 10 (pod-map). Priority order:
// 1. P9 federation init's self-heal handle (the canonical source).
// 2. gh identity probe fallback (covers the case where P9 was skipped
// or didn't run a self-heal because federation already existed).
// 3. Empty string → generator returns ok:false per the ratified default refuse.
function resolveOwnerForPodMap(p8: WizardPhaseResult): string {
  // The federation-init flow does NOT yet expose the resolved handle on
  // WizardPhaseResult.data — federation-init's narration includes the
  // handle in its message but we don't want to regex-extract (release review
  // Cor-mi1/Sec-M1 fragility). Fall straight to the gh identity probe;
  // if Phase 9 succeeded, `getHandleFromIdentity()` will hit the live
  // cache populated by federation init's own probe.
  if (!p8.ok) return "";
  try {
    return getHandleFromIdentity();
  } catch {
    return "";
  }
}

// Resolves the plugin source dir relative to the built wizard.js file
// location. In dev (vitest), __dirname-equivalent points at src/flows/;
// in built dist, it points at dist/flows/. Both walk up to the package
// root and into obsidian-plugins/lyt-pod-manager/.
function resolvePluginSourceDir(): string {
  // import.meta.url → file:// URL of this module's source/built location.
  const thisFile = fileURLToPath(import.meta.url);
  const flowsDir = dirname(thisFile);
  // .../src/flows or .../dist/flows → .../src/.. or .../dist/.. → pkg root
  const pkgRoot = join(flowsDir, "..", "..");
  return join(pkgRoot, "obsidian-plugins", "lyt-pod-manager");
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
// libSQL writes, git init, pod.yon write, pod-map emission) shows a
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
