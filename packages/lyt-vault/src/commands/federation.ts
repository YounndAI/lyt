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
import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";

import { applyPodCheckpoint, previewPodCheckpoint } from "../flows/federation/checkpoint.js";
import { parseReceiptV1ForEmission, receiptSafeErrorSummary } from "../op/receipt-v1.js";
import { generateFederationCanvasFlow } from "../flows/canvas-federation.js";
import { federationInitFlow } from "../flows/federation/init.js";
import { federationListFlow } from "../flows/federation/list.js";
import { federationRebuildFlow } from "../flows/federation/rebuild.js";
import { getFederationRoot } from "../util/federation-paths.js";
import type { FederationRepoVisibility } from "../util/gh-federation.js";
import { readPodIdentity, sanitizePodAlias } from "../util/identity-cache.js";
import { appendPodAlias, readPodAlias } from "../yon/pod-alias-ledger.js";
import { VOICE } from "../voice.js";

// v1.A.0 — `lyt federation init|list|rebuild`. CLI verbs stay plain per
// brand-voice §5 rule #1; status messages get the warm voice (rule #2);
// errors stay plain (rule #4). Pod = Federation in user-facing copy; CLI
// keeps `federation` per brand-voice §1 + §5 rule #6.

interface FedInitCliOpts {
  handle?: string;
  private?: boolean; // commander: --private sets this true
  public?: boolean; // commander: --public sets this true
  noPush?: boolean;
  description?: string;
  json?: boolean;
}

interface FedListCliOpts {
  handle?: string;
  json?: boolean;
}

interface FedRebuildCliOpts {
  handle?: string;
  push?: boolean;
  json?: boolean;
}

export function buildFederationCommand(): Command {
  const cmd = new Command("federation").description(
    "Manage Your Pod — the pod repo (`{handle}/lyt-pod`) that anchors which meshes you participate in.",
  );
  cmd.addCommand(buildInitSubcommand());
  cmd.addCommand(buildListSubcommand());
  cmd.addCommand(buildRebuildSubcommand());
  cmd.addCommand(buildCanvasSubcommand());
  cmd.addCommand(buildAliasSubcommand());
  cmd.addCommand(buildCheckpointSubcommand());
  return cmd;
}

function buildCheckpointSubcommand(): Command {
  return new Command("checkpoint")
    .description("Review or commit a local pod baseline. No sync or remote operation is performed.")
    .option("--preview", "Inspect current exact candidate files and their digest")
    .option("--apply <digest>", "Commit the exact reviewed preview digest locally")
    .option("--json", "Emit the preview or receipt as JSON")
    .action(async (opts: { preview?: boolean; apply?: string; json?: boolean }) => {
      const started = new Date().toISOString();
      const operationId = uuidv7();
      const attemptId = uuidv7();
      let applyReturned = false;
      try {
        if (opts.json !== true || (opts.preview === true) === (opts.apply !== undefined)) throw new Error("Choose exactly one of --preview or --apply <digest>, with --json.");
        if (opts.preview === true) {
          const preview = await previewPodCheckpoint();
          console.log(JSON.stringify({ status: "preview", baseline: preview, validation: "Selected ledger framing and fields plus canonical local projection; not provenance or a historical operation." }, null, 2));
          return;
        }
        const result = await applyPodCheckpoint(opts.apply!);
        applyReturned = true;
        const success = result.checkpoint.status === "committed" || result.checkpoint.status === "skipped";
        const committed = result.checkpoint.status === "committed";
        const receipt = parseReceiptV1ForEmission({
          schema_id: "lyt.receipt", schema_version: { major: 1, minor: 0 }, operation_id: operationId, attempt_id: attemptId,
          operation: "pod-checkpoint", scope: { kind: "system" }, timestamps: { started_at: started, finished_at: new Date().toISOString() },
          replay: { disposition: "new", key_digest: result.boundary.digest },
          status: success ? (committed ? "success" : "no-op") : "partial", exit_code: success ? 0 : 2,
          mutations: { local: committed || !success ? 1 : 0, remote: 0 },
          evidence: { before: [{ kind: "reviewed-baseline", subject: "Exact preview boundary", digest: result.boundary.digest, count: result.boundary.paths.length }],
            after: committed ? [{ kind: "local-commit", subject: result.checkpoint.commitSha!, count: result.boundary.paths.length }] : [] },
          error: success ? null : { code: "checkpoint-incomplete", summary: "Checkpoint did not finish cleanly; its index or commit may have changed.", retryable: false },
          next_action: success ? null : { code: "inspect-local-state", summary: "Inspect the exact pod paths and local commit state before retrying." },
        });
        console.log(JSON.stringify({ receipt, repository: result.boundary.repository, beforeHead: result.boundary.beforeHead, paths: result.boundary.paths, commitSha: result.checkpoint.commitSha ?? null, checkpoint: result.checkpoint }, null, 2));
        if (!success) process.exitCode = 2;
      } catch (error) {
        const message = receiptSafeErrorSummary(error, "Pod checkpoint could not be verified.");
        if (opts.apply !== undefined) {
          const digest = /^[a-f0-9]{64}$/u.test(opts.apply) ? opts.apply : createHash("sha256").update(opts.apply).digest("hex");
          const receipt = parseReceiptV1ForEmission({
            schema_id: "lyt.receipt", schema_version: { major: 1, minor: 0 }, operation_id: operationId, attempt_id: attemptId,
            operation: "pod-checkpoint", scope: { kind: "system" }, timestamps: { started_at: started, finished_at: new Date().toISOString() },
            replay: { disposition: applyReturned ? "new" : "rejected", key_digest: digest },
            status: applyReturned ? "partial" : "refused", exit_code: 2, mutations: { local: applyReturned ? 1 : 0, remote: 0 }, evidence: { before: [], after: [] },
            error: { code: applyReturned ? "checkpoint-incomplete" : "pod-checkpoint-refused", summary: message, retryable: false },
            next_action: { code: "inspect-local-state", summary: "Inspect the local pod state and obtain a fresh preview before retrying." },
          });
          console.error(JSON.stringify({ receipt }));
        } else console.error(JSON.stringify({ status: "refused", error: "pod-checkpoint-refused", message }));
        process.exitCode = 2;
      }
    });
}

function buildAliasSubcommand(): Command {
  return new Command("alias")
    .description("Inspect or update Your Pod's mutable alias; the stable pod RID is unchanged.")
    .argument("[alias]", "New pod alias; omit to inspect")
    .option("--json", "Emit structured pod identity metadata")
    .action((alias: string | undefined, opts: { json?: boolean }) => {
      const podRoot = getFederationRoot();
      const identity = readPodIdentity(podRoot);
      if (identity === null || identity.podRid === undefined || identity.podAlias === undefined) {
        throw new Error("Pod identity metadata is not initialized; run `lyt init` first.");
      }
      if (alias !== undefined) {
        const normalized = sanitizePodAlias(alias);
        if (normalized === null) throw new Error("Pod alias must contain at least one letter or number.");
        appendPodAlias({ podRoot, podRid: identity.podRid, alias: normalized });
      }
      const podAlias = readPodAlias(podRoot, identity.podRid)?.alias ?? identity.podAlias;
      const payload = {
        podRid: identity.podRid,
        podAlias,
        accountIdentity: `${identity.provider}:${identity.handle}`,
      };
      // eslint-disable-next-line no-console
      console.log(
        opts.json === true
          ? JSON.stringify(payload, null, 2)
          : `Pod alias: ${payload.podAlias}\nPod RID:   ${payload.podRid}`,
      );
    });
}

function buildInitSubcommand(): Command {
  const sub = new Command("init")
    .description("Create a local pod and scaffold pod.yon; use lyt sync to publish it.")
    .option("--handle <h>", "GitHub handle (overrides cached identity)")
    .addOption(
      new Option("--public", "Create the GitHub repo public (opt-in; default is --private)"),
    )
    .addOption(new Option("--private", "Create the GitHub repo private (DEFAULT)"))
    .option("--no-push", "Legacy compatibility flag; creation is always local-only")
    .option("--description <text>", "Stored for later scoped publication")
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (opts: FedInitCliOpts) => {
      const visibility: FederationRepoVisibility = opts.public === true ? "public" : "private";
      if (opts.json !== true) console.error(VOICE.forgingYourPod);

      const result = await federationInitFlow({
        ...(opts.handle !== undefined ? { handle: opts.handle } : {}),
        visibility,
        pushToRemote: false,
        createRemoteIfMissing: false,
        localOnly: true,
        ...(opts.description !== undefined ? { description: opts.description } : {}),
      });

      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              handle: result.handle,
              fed_rid: `fed:${result.fedRidHex}`,
              branch: result.branch,
              visibility: result.visibility,
              local_path: result.localPath,
              federation_yon: result.federationYonPath,
              remote: result.remoteFullName,
              remote_created: result.remoteCreated,
              pushed: result.pushed,
            },
            null,
            2,
          ),
        );
        return;
      }

      // eslint-disable-next-line no-console
      console.log(`Your local pod:  ${result.remoteFullName} (${result.visibility})`);
      // eslint-disable-next-line no-console
      console.log(`  rid:           fed:${result.fedRidHex}`);
      // eslint-disable-next-line no-console
      console.log(`  branch:        ${result.branch}`);
      // eslint-disable-next-line no-console
      console.log(`  local:         ${result.localPath}`);
      // eslint-disable-next-line no-console
      console.log(`  pod.yon        ${result.federationYonPath}`);
      // eslint-disable-next-line no-console
      console.log(" remote: not published; run `lyt sync` when ready");
    });
  return sub;
}

function buildListSubcommand(): Command {
  return new Command("list")
    .description("List meshes in Your Pod — reads cached ~/lyt/pod/pod.yon.")
    .option("--handle <h>", "GitHub handle (overrides cached identity)")
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (opts: FedListCliOpts) => {
      const result = await federationListFlow(
        opts.handle !== undefined ? { handle: opts.handle } : {},
      );
      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              federation: {
                fed_rid: `fed:${result.federation.fedRidHex}`,
                handle: result.federation.handle,
                visibility: result.federation.visibility,
                created_at: result.federation.createdAt,
              },
              meshes: result.meshes.map((m) => ({
                fed_rid: `fed:${m.fedRidHex}`,
                mesh_rid: `mesh:${m.meshRidHex}`,
                mesh_name: m.meshName,
                push_target: m.pushTarget,
                push_kind: m.pushKind,
                role: m.role,
                added_at: m.addedAt,
              })),
              last_synced_at: result.lastSyncedAt,
              federation_yon: result.federationYonPath,
            },
            null,
            2,
          ),
        );
        return;
      }
      // eslint-disable-next-line no-console
      console.log(VOICE.yourPodSpansMeshes(result.meshes.length));
      if (result.meshes.length === 0) {
        // eslint-disable-next-line no-console
        console.log("  (no meshes yet)");
        return;
      }
      for (const m of result.meshes) {
        // eslint-disable-next-line no-console
        console.log(`  ${m.meshName.padEnd(24)} ${m.role.padEnd(5)} ${m.pushKind}:${m.pushTarget}`);
      }
    });
}

interface FedCanvasCliOpts {
  target?: string;
  nowIso?: string;
  json?: boolean;
}

function buildCanvasSubcommand(): Command {
  return new Command("canvas")
    .description(
      "Render Your Pod as an Obsidian Canvas (.canvas) — federation → meshes → vaults. Writes to ~/lyt/pod/canvases/federation-graph.canvas when federation-repo populated; else a per-vault stub with a federation-repo-pending warning.",
    )
    .option(
      "--target <handle>",
      "GitHub handle override (otherwise resolved from identity / federation_state)",
    )
    .option("--now-iso <iso>", "Pin the 'now' timestamp for deterministic testing (ISO 8601)")
    .option("--json", "Emit JSON result instead of human-readable output")
    .action(async (opts: FedCanvasCliOpts) => {
      try {
        const res = await generateFederationCanvasFlow({
          ...(opts.target !== undefined ? { target: opts.target } : {}),
          ...(opts.nowIso !== undefined ? { nowIso: opts.nowIso } : {}),
        });
        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify(
              {
                canvasPath: res.canvasPath,
                handle: res.handle,
                federationRid: res.federationRid,
                isVaultStub: res.isVaultStub,
                meshCount: res.meshCount,
                vaultCount: res.vaultCount,
                nodeCount: res.nodeCount,
                edgeCount: res.edgeCount,
                durationMs: res.durationMs,
              },
              null,
              2,
            ),
          );
          return;
        }
        const stubNote = res.isVaultStub ? " (vault-stub: federation-repo pending)" : "";
        // eslint-disable-next-line no-console
        console.log(
          `Federation canvas written to ${res.canvasPath}${stubNote} (${res.meshCount} meshes, ${res.vaultCount} vaults, ${res.nodeCount} nodes, ${res.edgeCount} edges; ${res.durationMs}ms).`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.error(JSON.stringify({ error: "canvas-federation-error", message }, null, 2));
        } else {
          // eslint-disable-next-line no-console
          console.error(`lyt federation canvas: ${message}`);
        }
        process.exitCode = 2;
      }
    });
}

function buildRebuildSubcommand(): Command {
  return new Command("rebuild")
    .description(
      "Rebuild pod.yon deterministically from the registry (idempotent modulo last_synced_at).",
    )
    .option("--handle <h>", "GitHub handle (overrides cached identity)")
    .option("--push", "Commit + push the rebuilt pod.yon if it changed")
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (opts: FedRebuildCliOpts) => {
      // eslint-disable-next-line no-console
      console.log(VOICE.rebuildingPod);
      const result = await federationRebuildFlow({
        ...(opts.handle !== undefined ? { handle: opts.handle } : {}),
        pushToRemote: opts.push === true,
      });
      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              handle: result.handle,
              federation_yon: result.federationYonPath,
              local_path: result.localPath,
              changed: result.changed,
              pushed: result.pushed,
              mesh_count: result.meshCount,
            },
            null,
            2,
          ),
        );
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`Rebuilt:        ${result.federationYonPath}`);
      // eslint-disable-next-line no-console
      console.log(`  changed:      ${result.changed ? "yes" : "no (timestamp-only)"}`);
      // eslint-disable-next-line no-console
      console.log(`  meshes:       ${result.meshCount}`);
      if (result.pushed) {
        // eslint-disable-next-line no-console
        console.log(`  pushed:       yes`);
      }
    });
}
