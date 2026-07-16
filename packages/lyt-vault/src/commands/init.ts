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

import { Command, Option } from "commander";
import { createInterface } from "node:readline/promises";

import { initVaultFlow, type InitFlowResult } from "../flows/init.js";
import { federationRepoFullName, vaultRepoName } from "../util/federation-paths.js";
import { recordInitFailure } from "../util/failure-log.js";
import type { TemplateName } from "../templates/index.js";
import { uuid7BytesToDashedString } from "../util/uuid7.js";

export function buildInitCommand(): Command {
  const cmd = new Command("init");
  cmd
    .description("Create a new Lyt vault (folder + .lyt/) and register it")
    .argument("<name>", "Vault name (used for path + vault rid)")
    .option("--path <dir>", "Override the default location (~/lyt/vaults/<name>)")
    .option(
      "--mesh <mesh>",
      "Create the vault in mesh <mesh> (create-if-missing). Equivalent to passing '<mesh>/<name>'. The mesh is created if absent.",
    )
    .option(
      "--push-to <handle>",
      "When the home mesh is auto-created, make it a SHARING mesh pointed at this GitHub handle/org (otherwise the new mesh is local-only).",
    )
    .addOption(
      new Option("--template <name>", "Scaffold template")
        .choices(["empty", "obsidian-default"])
        .default("empty"),
    )
    .option("--parent <vault>", "Parent vault ref (e.g., vault:al0)")
    .option("--tier-hint <tier>", "Tier label hint (e.g., L0, L1, L2 — informational only)")
    .option(
      "--description <text>",
      "One-line vault description (written to vault.yon + used on gh repo create)",
    )
    .option(
      "--ask-description",
      "Prompt for the description interactively (TTY only; non-TTY runs skip the prompt)",
    )
    .option(
      "--topic <name>",
      "Custom GitHub topic (repeatable; appended to brand topics)",
      collectTopic,
      [] as string[],
    )
    .option("--no-starter-figment", "Skip writing the optional notes/welcome.md starter Figment")
    .option("--no-git", "Skip 'git init' inside the new vault")
    .option(
      "--commit-initial",
      "After scaffolding, stage and commit the lyt scaffold files (explicit path list, never `git add -A`). Off by default.",
    )
    .option("--json", "Emit machine-readable JSON instead of human-readable output")
    .action(async (name: string, opts: InitCliOpts) => {
      const desc = await resolveDescription(opts);

      // 0.9.4 (3c) — `--mesh <m>` is sugar for the `<m>/<name>` qualified form.
      // Reject the contradiction where both `--mesh` and a slashed name are
      // given with different meshes.
      let effectiveName = name;
      if (opts.mesh !== undefined && opts.mesh.length > 0) {
        if (name.includes("/")) {
          const namedMesh = name.slice(0, name.indexOf("/"));
          if (namedMesh !== opts.mesh) {
            const message = `lyt vault init: conflicting mesh — name '${name}' specifies mesh '${namedMesh}' but --mesh is '${opts.mesh}'. Pass one or the other.`;
            emitInitError(opts.json === true, "conflicting-mesh", message);
            process.exitCode = 2;
            return;
          }
        } else {
          effectiveName = `${opts.mesh}/${name}`;
        }
      }

      let result: Awaited<ReturnType<typeof initVaultFlow>>;
      try {
        result = await initVaultFlow({
          name: effectiveName,
          path: opts.path,
          template: opts.template as TemplateName | undefined,
          parent: opts.parent,
          tierHint: opts.tierHint,
          desc,
          topics: opts.topic ?? [],
          starterFigment: opts.starterFigment !== false,
          gitInit: opts.git !== false,
          commitInitial: opts.commitInitial === true,
          // v1.A.0 — `lyt vault init` opts into federation self-heal so a
          // handler running `lyt vault init alex/main` on a fresh machine
          // gets {handle}/lyt-pod forged transparently. Brief
          // acceptance (c). The flow's catch-block keeps failures
          // non-fatal — vault creation always succeeds first.
          //
          // v1.A.1 — reshaped to the `selfHeal.federation` sub-options bag
          // (fold #12). `mesh` sub-options ship empty in v1.A.1; v1.B.1
          // fills the body when `lyt mesh init` lands.
          //
          // v1.B.3 — populates `mesh` self-heal: a bare-name init
          // auto-normalizes to `personal/<name>`, auto-creating the
          // `personal` mesh in-process if it doesn't exist (local; no
          // push). `<owner>/<name>` form is preserved verbatim but the
          // `<owner>` mesh must already exist (HomeMeshNotFoundError
          // otherwise — avoids silently auto-creating non-personal
          // meshes with ambiguous push-target semantics).
          selfHeal: {
            federation: { enabled: true },
            mesh: {
              enabled: true,
              ...(opts.pushTo !== undefined && opts.pushTo.length > 0
                ? { pushTo: opts.pushTo }
                : {}),
            },
          },
        });
      } catch (err) {
        // Lane O Phase 0 — record the first-vault-create death point before
        // re-throwing. `lyt vault init` had no try/catch, so a throw here
        // crashed the command silently (no durable trail). Capture an
        // AI-readable record, then re-throw to PRESERVE the existing
        // control flow (commander surfaces the error + non-zero exit).
        const msg = err instanceof Error ? err.message : String(err);
        recordInitFailure({
          site: "first-vault-create",
          step: "command:lyt vault init",
          summary: `initVaultFlow threw: ${msg}`,
          context: { name },
        });
        if (opts.json === true) {
          const code =
            typeof err === "object" &&
            err !== null &&
            "errorCode" in err &&
            typeof err.errorCode === "string"
              ? err.errorCode
              : "vault-init-error";
          emitInitError(true, code, msg);
          process.exitCode = 1;
          return;
        }
        throw err;
      }

      const displayName = result.meshAssignment?.meshName
        ? `${result.meshAssignment.meshName}/${effectiveName.includes("/") ? effectiveName.slice(effectiveName.indexOf("/") + 1) : effectiveName}`
        : effectiveName;
      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(buildInitJsonPayload(result, displayName), null, 2));
        return;
      }

      // eslint-disable-next-line no-console
      console.log(`Created Lyt vault '${displayName}'`);
      // eslint-disable-next-line no-console
      console.log(`  path:     ${result.vaultPath}`);
      // eslint-disable-next-line no-console
      console.log(`  rid:      ${result.vaultRid}`);
      // eslint-disable-next-line no-console
      console.log(`  template: ${result.template}`);
      // eslint-disable-next-line no-console
      console.log(`  priming:  ${result.primingFilesWritten.join(", ")}`);
      // eslint-disable-next-line no-console
      console.log(`  git:      ${result.gitInitialized ? "initialized" : "skipped"}`);
      if (result.initialCommitMade) {
        // eslint-disable-next-line no-console
        console.log(`  commit:   scaffold committed`);
      }
      // 0.9.4 (3d) — only claim a clean "registered" when the read-back verified
      // the vault row landed; otherwise append the unverified note.
      const registrySuffix =
        result.committed === "verified" ? "" : ` ${result.unverifiedNote ?? "(unverified)"}`;
      // eslint-disable-next-line no-console
      console.log(`  registry: registered${registrySuffix}`);
      if (result.meshAssignment) {
        // eslint-disable-next-line no-console
        console.log(`  mesh:     ${result.meshAssignment.statusVoiceEmitted}`);
      }
      const publishNext = buildInitPublishNextStep(result, displayName);
      // eslint-disable-next-line no-console
      console.log(`  next:     ${publishNext.message}`);
      if (result.federationSelfHealed) {
        // eslint-disable-next-line no-console
        console.log(`  pod:      ${result.federationSelfHealed.statusVoiceEmitted}`);
        // eslint-disable-next-line no-console
        console.log(
          `            forged ${federationRepoFullName(result.federationSelfHealed.handle)} (${result.federationSelfHealed.visibility}, ${result.federationSelfHealed.branch})`,
        );
        // v1.A.2d fold (v1.A.0 #14): self-heal forges locally but does
        // NOT push by default. Without this hint, handlers may assume
        // "forged" means "published to GitHub".
        // Brief C (F3) — point at the canonical publish path `lyt sync`
        // (Brief B), not the retired `lyt federation rebuild --push` verb.
        // eslint-disable-next-line no-console
        console.log(` next: run \`lyt sync\` to publish your pod to GitHub`);
      }
    });
  return cmd;
}

interface InitCliOpts {
  path?: string;
  mesh?: string;
  pushTo?: string;
  template?: string;
  parent?: string;
  tierHint?: string;
  description?: string;
  askDescription?: boolean;
  topic?: string[];
  starterFigment?: boolean;
  git?: boolean;
  commitInitial?: boolean;
  json?: boolean;
}

export function buildInitJsonPayload(result: InitFlowResult, displayName: string) {
  return {
    ok: true,
    vault: {
      name: displayName,
      path: result.vaultPath,
      rid: uuid7BytesToDashedString(result.vaultRid),
      memscopeRid: uuid7BytesToDashedString(result.memscopeRid),
      template: result.template,
      tier: result.tier,
    },
    primingFilesWritten: result.primingFilesWritten,
    git: {
      initialized: result.gitInitialized,
      initialCommitMade: result.initialCommitMade,
    },
    registry: {
      registered: result.registered,
      committed: result.committed,
      unverifiedNote: result.unverifiedNote,
    },
    mesh: result.meshAssignment,
    federation: result.federationSelfHealed,
    publish: buildInitPublishNextStep(result, displayName),
  };
}

export function buildInitPublishNextStep(result: InitFlowResult, displayName: string) {
  const command = `lyt sync --vault ${displayName}`;
  const mesh = result.meshAssignment;
  const owner = mesh?.ownCreated === true ? mesh.pushTarget : null;
  if (owner !== null && owner.length > 0) {
    const expectedRepo = `${owner}/${vaultRepoName(displayName)}`;
    return {
      status: "pending-scoped-sync" as const,
      remoteAction: "none" as const,
      command,
      visibility: "private" as const,
      expectedRepo,
      message:
        `No remote action happened. Only the scoped sync remains: run \`${command}\` ` +
        `to create the private online copy ${expectedRepo} and save only this vault.`,
    };
  }
  return {
    status: "local-only-no-push-target" as const,
    remoteAction: "none" as const,
    command,
    visibility: "private" as const,
    expectedRepo: null,
    message:
      `No remote action happened. This mesh has no configured push target, so the vault ` +
      `remains local; configure the mesh before running \`${command}\`.`,
  };
}

function emitInitError(json: boolean, error: string, message: string): void {
  // eslint-disable-next-line no-console
  console.error(json ? JSON.stringify({ ok: false, error, message }, null, 2) : message);
}

function collectTopic(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function resolveDescription(opts: InitCliOpts): Promise<string | undefined> {
  if (opts.description !== undefined && opts.description.length > 0) {
    return opts.description;
  }
  if (opts.askDescription !== true) {
    return undefined;
  }
  if (process.stdin.isTTY !== true) {
    // Non-TTY (script / agent invocation): don't hang. Skip the prompt.
    return undefined;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Vault description: ");
    const trimmed = answer.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } finally {
    rl.close();
  }
}
