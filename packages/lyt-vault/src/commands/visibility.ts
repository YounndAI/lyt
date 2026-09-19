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

import { createHash } from "node:crypto";

import { Command } from "commander";

import {
  setVaultVisibilityFlow,
  type VaultVisibilityResult,
} from "../flows/vault-visibility.js";
import {
  parseReceiptV1ForEmission,
  receiptSafeErrorSummary,
  type ReceiptV1,
} from "../op/receipt-v1.js";
import { newUuidv7Bytes, uuid7BytesToDashedString } from "../util/uuid7.js";

// `lyt vault visibility <name> --public|--private [--yes] [--json]` — the
// conscious-public flip AND its reversal (github-defaults.ts gaps #1 + #2).
//
// m3 (release review) — every terminal state emits ONE Receipt V1 object in `--json`
// mode (op/receipt-v1.ts parseReceiptV1ForEmission, the same producer contract
// commands/repair.ts and commands/mesh.ts use), so an agent consumer reads the
// same schema here as everywhere else. The human path keeps the readable
// rendering.
// Final review (item 3) - the ONE injection seam. The command is 300+ lines of
// terminal-state rendering and receipt shaping whose only dependency is the flow
// result, so tests drive every status through this instead of standing up a pod
// per case. Production passes nothing and gets `setVaultVisibilityFlow`.
export interface VisibilityCommandDeps {
  runFlow?: (args: {
    vaultName: string;
    visibility: "public" | "private";
    confirmed: boolean;
  }) => Promise<VaultVisibilityResult>;
  // Test-only: force the rendering/receipt half to throw AFTER the flow returned,
  // proving the post-mutation failure is reported as such and not as a refusal.
  emit?: (result: VaultVisibilityResult) => void;
}

export function buildVisibilityCommand(deps: VisibilityCommandDeps = {}): Command {
  const cmd = new Command("visibility");
  cmd
    .description(
      "Set a single vault's publication posture (public|private) — flips the GitHub repo, " +
        "reconciles the lyt-public topic, and records it in the @FED_VAULT manifest. Without " +
        "--yes it prints a read-only preview and exits non-zero.",
    )
    .argument("<name>", "Registered vault name")
    .option("--public", "Make the vault publicly subscribable")
    .option("--private", "Make the vault private again (strips the lyt-public topic)")
    .option("--yes", "Confirm the visibility change")
    .option("--json", "Emit a Receipt V1 object")
    .action(
      async (
        name: string,
        opts: { public?: boolean; private?: boolean; yes?: boolean; json?: boolean },
      ) => {
        const startedAt = new Date().toISOString();
        const operationId = uuid7BytesToDashedString(newUuidv7Bytes());
        const attemptId = uuid7BytesToDashedString(newUuidv7Bytes());
        let receipt: ReceiptV1;

        // Final review (item 4) - TWO phases, two failure meanings.
        //
        // PHASE 1 (flag validation + the flow) is the only stretch where a throw
        // means "nothing happened": the flow is fail-closed and every refusal it
        // raises fires BEFORE the first gh write.
        //
        // PHASE 2 (rendering + receipt building) runs only once the flow RETURNED
        // a result - i.e. the GitHub repo may already be flipped and the manifest
        // already appended. The old code shared one try with the flow, so a throw
        // out of a renderer or the receipt builder was reported as `refused`,
        // `mutations: 0` - a receipt that flatly denied an irreversible public
        // flip that had already happened. A phase-2 failure is now reported as a
        // REPORTING failure that still states what mutated, read off the result.
        let result: VaultVisibilityResult | null = null;
        let target: "public" | "private" | null = null;
        try {
          const wantsPublic = opts.public === true;
          const wantsPrivate = opts.private === true;
          if (wantsPublic === wantsPrivate) {
            throw new Error(
              wantsPublic
                ? "--public and --private are mutually exclusive — pass exactly one."
                : "pass exactly one of --public or --private.",
            );
          }
          target = wantsPublic ? "public" : "private";
          const runFlow = deps.runFlow ?? setVaultVisibilityFlow;
          result = await runFlow({
            vaultName: name,
            visibility: target,
            confirmed: opts.yes === true,
          });
        } catch (err) {
          if (opts.json !== true) {
            // eslint-disable-next-line no-console
            console.error(err instanceof Error ? err.message : String(err));
          }
          emitReceipt(
            buildRefusalReceipt({
              operationId,
              attemptId,
              startedAt,
              logicalKey: `vault-visibility|${name}`,
              summary: receiptSafeErrorSummary(err, "The visibility change was refused."),
            }),
            opts.json === true,
          );
          return;
        }

        try {
          if (opts.json !== true) renderHuman(result);
          deps.emit?.(result);
          receipt = buildReceipt({
            operationId,
            attemptId,
            startedAt,
            logicalKey: `vault-visibility|${name}|${target}`,
            result,
          });
        } catch (err) {
          const applied = describeApplied(result);
          if (opts.json !== true) {
            // eslint-disable-next-line no-console
            console.error(
              `The visibility change RAN and could not be reported - ` +
                `${err instanceof Error ? err.message : String(err)}. What actually changed: ` +
                `${applied}`,
            );
          }
          receipt = buildReportingFailureReceipt({
            operationId,
            attemptId,
            startedAt,
            logicalKey: `vault-visibility|${name}|${target}`,
            result,
            summary:
              `The visibility change ran but its receipt could not be rendered - ` +
              `${receiptSafeErrorSummary(err, "rendering failed")}. What changed: ${applied}`,
          });
        }
        emitReceipt(receipt, opts.json === true);
      },
    );
  return cmd;
}

function emitReceipt(receipt: ReceiptV1, json: boolean): void {
  if (json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(receipt, null, 2));
  }
  if (receipt.exit_code !== 0) process.exitCode = receipt.exit_code;
}

// Final review (item 4) - the one-line truth about the outward world, derived
// from the flow RESULT (never from the throw that stopped the reporting).
function describeApplied(r: VaultVisibilityResult): string {
  if (r.status === "preview-required") return "nothing - this was a read-only preview.";
  if (!r.changed) return `nothing - '${r.vault}' was already ${r.to}.`;
  const parts: string[] = [];
  parts.push(
    r.gh.edited
      ? `GitHub repository ${r.gh.owner ?? "?"}/${r.gh.repo ?? "?"} was set ${r.to}`
      : `the GitHub repository was NOT edited (${r.gh.skipReason ?? "unknown"})`,
  );
  parts.push(
    r.topics.skipped
      ? `topics were not reconciled (${r.topics.skipReason ?? "unknown"})`
      : `topics +[${r.topics.added.join(" ")}] -[${r.topics.removed.join(" ")}]`,
  );
  parts.push(
    r.ledger.appended
      ? `the @FED_VAULT manifest records ${r.ledger.visibility}`
      : `the @FED_VAULT manifest still reads ${r.ledger.visibility}`,
  );
  return `${parts.join("; ")}.`;
}

// Final review (item 4) - a POST-MUTATION reporting failure. Never `refused`:
// the mutations counted here are the ones the flow actually performed, so a
// consumer reading this receipt still learns that the repository moved.
function buildReportingFailureReceipt(args: {
  operationId: string;
  attemptId: string;
  startedAt: string;
  logicalKey: string;
  result: VaultVisibilityResult;
  summary: string;
}): ReceiptV1 {
  const r = args.result;
  const remote =
    r.status === "preview-required" ? 0 : (r.gh.edited ? 1 : 0) + (r.topics.skipped ? 0 : 1);
  const local = r.ledger.appended ? 1 : 0;
  const total = remote + local;
  return parseReceiptV1ForEmission({
    ...envelope(args, total > 0 ? "partial" : "failed", 1, { local, remote }, "new"),
    evidence: {
      before: [
        { kind: "manifest-visibility", subject: `manifest=${r.preview.ledgerVisibility}` },
        { kind: "github-visibility", subject: `github=${r.preview.githubVisibility}` },
      ],
      after: [{ kind: "visibility-applied", subject: describeApplied(r) }],
    },
    next_action: {
      code: "rerun-visibility-verb",
      summary:
        `Re-run 'lyt vault visibility ${r.vault} --${r.to} --yes'; it reads the live ` +
        `GitHub state and converges.`,
    },
    error: { code: "visibility-report-failed", summary: args.summary, retryable: true },
  });
}

// M1 — the human preview / outcome rendering. Mirrors how flows/share.ts states
// its gate: name the exact thing, say why it is irreversible, say what to re-run.
function renderHuman(result: VaultVisibilityResult): void {
  const log = (line: string): void => {
    // eslint-disable-next-line no-console
    console.log(line);
  };
  const p = result.preview;
  if (result.status === "preview-required") {
    log(`PREVIEW — nothing was changed.`);
    log(`  vault:     ${p.vault}`);
    log(`  repo:      ${p.owner === null ? "(no remote yet)" : `${p.owner}/${p.repo}`}`);
    log(`  manifest:  ${p.ledgerVisibility}`);
    log(`  github:    ${p.githubVisibility}`);
    log(`  target:    ${p.target}`);
    log(`  topics +:  ${p.topicsToAdd.length === 0 ? "(none)" : p.topicsToAdd.join(", ")}`);
    log(`  topics -:  ${p.topicsToRemove.length === 0 ? "(none)" : p.topicsToRemove.join(", ")}`);
    log(`  ${p.irreversible}`);
    log(`Re-run with --yes to apply.`);
    return;
  }
  if (!result.changed) {
    log(`'${result.vault}' is already ${result.to}; nothing to do.`);
    return;
  }
  log(
    result.status === "drift-repaired"
      ? `Converged '${result.vault}' onto ${result.to} (manifest was ${p.ledgerVisibility}, ` +
          `GitHub was ${p.githubVisibility}).`
      : `Set '${result.vault}' ${result.from} -> ${result.to}.`,
  );
  log(
    `  github repo: ${
      result.gh.edited
        ? `${result.gh.owner}/${result.gh.repo} set ${result.to}`
        : `skipped (${result.gh.skipReason ?? "unknown"})`
    }`,
  );
  log(
    `  topics: ${
      result.topics.skipped
        ? `skipped (${result.topics.skipReason ?? "unknown"})`
        : `+[${result.topics.added.join(", ")}] -[${result.topics.removed.join(", ")}]`
    }`,
  );
  log(
    `  manifest: ${
      result.ledger.appended
        ? "@FED_VAULT record appended"
        : result.from === result.to
          ? "@FED_VAULT already at target"
          : "NOT recorded"
    }`,
  );
  log(`  audit: ${result.auditRecorded ? "@AUDIT recorded" : "@AUDIT NOT recorded"}`);
  for (const note of result.notes) {
    log(`  note: ${note}`);
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function buildReceipt(args: {
  operationId: string;
  attemptId: string;
  startedAt: string;
  logicalKey: string;
  result: VaultVisibilityResult;
}): ReceiptV1 {
  const r = args.result;
  const p = r.preview;
  const remoteMutations = (r.gh.edited ? 1 : 0) + (r.topics.skipped ? 0 : 1);
  const localMutations = r.ledger.appended ? 1 : 0;
  const total = remoteMutations + localMutations;
  // A step that was ASKED to run and failed (a gh topic edit, a @FED_VAULT
  // append) degrades the receipt — an outward flip with an un-recorded manifest
  // must never read as a clean success.
  const topicFailed = (r.topics.skipReason ?? "").startsWith("gh-edit-failure");
  const ledgerFailed = r.from !== r.to && !r.ledger.appended;
  const clientBlind = r.gh.skipReason === "gh-client-lacks-set-repo-visibility";
  const degraded = topicFailed || ledgerFailed || clientBlind;

  const before = [
    { kind: "manifest-visibility", subject: `manifest=${p.ledgerVisibility}` },
    { kind: "github-visibility", subject: `github=${p.githubVisibility}` },
  ];

  if (r.status === "preview-required") {
    return parseReceiptV1ForEmission({
      ...envelope(args, "refused", 1, { local: 0, remote: 0 }, "rejected"),
      evidence: {
        before,
        after: [
          {
            kind: "visibility-preview",
            subject:
              `target=${p.target} topics_add=[${p.topicsToAdd.join(" ")}] ` +
              `topics_remove=[${p.topicsToRemove.join(" ")}]`,
          },
        ],
      },
      next_action: {
        code: "confirm-visibility-change",
        summary: `Re-run with --yes to apply. ${p.irreversible}`,
      },
      error: {
        code: "visibility-change-unconfirmed",
        summary: "The visibility change was not confirmed; nothing was changed.",
        retryable: true,
      },
    });
  }

  if (!r.changed) {
    return parseReceiptV1ForEmission({
      ...envelope(args, "no-op", 0, { local: 0, remote: 0 }, "new"),
      evidence: {
        before,
        after: [{ kind: "visibility-unchanged", subject: `already=${p.target}` }],
      },
      next_action: null,
      error: null,
    });
  }

  const after = [
    {
      kind: "visibility-applied",
      subject:
        `target=${p.target} github_edited=${r.gh.edited} ` +
        `topics_added=[${r.topics.added.join(" ")}] topics_removed=[${r.topics.removed.join(" ")}] ` +
        `manifest_appended=${r.ledger.appended} audit=${r.auditRecorded}`,
    },
  ];

  if (!degraded) {
    return parseReceiptV1ForEmission({
      ...envelope(args, "success", 0, { local: localMutations, remote: remoteMutations }, "new"),
      evidence: { before, after },
      next_action: null,
      error: null,
    });
  }
  const summary = ledgerFailed
    ? "The GitHub repository moved but the manifest record did not."
    : topicFailed
      ? "The repository visibility moved but its topics were not reconciled."
      : "The gh client in use cannot set repository visibility; only the manifest moved.";
  const nextAction = {
    code: "rerun-visibility-verb",
    summary: `Re-run 'lyt vault visibility ${r.vault} --${r.to} --yes'; it reads the live GitHub state and converges.`,
  };
  return parseReceiptV1ForEmission({
    ...envelope(
      args,
      total > 0 ? "partial" : "failed",
      1,
      total > 0 ? { local: localMutations, remote: remoteMutations } : { local: 0, remote: 0 },
      "new",
    ),
    evidence: { before, after },
    next_action: total > 0 ? nextAction : null,
    error: { code: "visibility-change-degraded", summary, retryable: true },
  });
}

function buildRefusalReceipt(args: {
  operationId: string;
  attemptId: string;
  startedAt: string;
  logicalKey: string;
  summary: string;
}): ReceiptV1 {
  return parseReceiptV1ForEmission({
    ...envelope(args, "refused", 1, { local: 0, remote: 0 }, "rejected"),
    evidence: { before: [], after: [] },
    next_action: {
      code: "inspect-visibility-refusal",
      summary: "Inspect the reported refusal, then retry with a valid target vault and flag.",
    },
    error: { code: "visibility-refused", summary: args.summary, retryable: false },
  });
}

function envelope(
  args: { operationId: string; attemptId: string; startedAt: string; logicalKey: string },
  status: string,
  exitCode: number,
  mutations: { local: number; remote: number },
  disposition: "new" | "rejected",
): Record<string, unknown> {
  return {
    schema_id: "lyt.receipt",
    schema_version: { major: 1, minor: 0 },
    operation_id: args.operationId,
    attempt_id: args.attemptId,
    operation: "vault-visibility",
    scope: { kind: "system" },
    timestamps: { started_at: args.startedAt, finished_at: new Date().toISOString() },
    replay: { disposition, key_digest: digest(args.logicalKey) },
    status,
    exit_code: exitCode,
    mutations,
  };
}
