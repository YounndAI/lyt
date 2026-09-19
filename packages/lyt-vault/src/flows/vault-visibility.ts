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

import type { Client } from "@libsql/client";

import { recordAudit } from "../registry/audit-write.js";
import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByName, type VaultRow } from "../registry/repo.js";
import { closeVaultDb, openAuditDb } from "../registry/vault-db.js";
import { baseTopicsForClass, PUBLIC_TOPIC } from "../scaffold/github-defaults.js";
import { resolveConfig } from "../util/config.js";
import { getFederationRoot, isReservedFederationRepoName } from "../util/federation-paths.js";
import {
  parseOwnerRepoFromUrl,
  realGhClient,
  type GhClient,
  type GhRepoInfo,
  type GhRepoVisibility,
} from "../util/gh.js";
import { realFederationGhClient, type FederationGhClient } from "../util/gh-federation.js";
import { collectKnownPodOwners } from "../util/pod-owners.js";
import { newUuidv7Bytes } from "../util/uuid7.js";
import { authorFedVaultMutation } from "../yon/federation-vault-ledger-author.js";
import {
  foldFedVaults,
  listFedVaultShards,
  readAllFedVaultRecords,
} from "../yon/federation-vault-ledger-read.js";
import type { FederationVisibility } from "../yon/federation-write.js";

// The CONSCIOUS-PUBLIC FLIP — `lyt vault visibility <vault> --public|--private`.
//
// Closes DEFERRED LIFECYCLE GAP #1 and GAP #2 (scaffold/github-defaults.ts). Before
// this verb no product path could write per-vault `@FED_VAULT visibility=public`:
// `lyt federation --public` is the POD-repo axis, and `createRepo` only fixes
// visibility AT CREATION. So `PUBLIC_VAULT_TOPICS` / the `lyt-public` topic and the
// subscribe-side public routing were reachable only via a hand-edited pod.yon.
//
// GAP #2 (reversal) ships in the SAME verb by construction: a `--private` flip both
// flips the GitHub repo back AND strips `lyt-public` via the `--remove-topic`
// capability (util/gh.ts editRepo). A de-published vault never keeps advertising
// itself as public.
//
// Ordering is fail-closed and effects are ordered outward-last-recorded-first:
//   1. validate flags -> pod-map refusal (C2) -> resolve the vault -> own-vault
//      check -> @FED_VAULT-shard check -> POD-OWNER FENCE (C1)
//   2. OBSERVE both sides of the truth: the @FED_VAULT ledger fold AND the LIVE
//      GitHub visibility (C3). Converged only when BOTH (and the topic floor)
//      already equal the target.
//   3. handler gate (M1): without `confirmed` return a read-only PREVIEW receipt
//   4. flip the GitHub repo where it disagrees, then reconcile topics
//   5. author the @FED_VAULT ledger mutation with the EXPLICIT new visibility
//
// The ledger record is the durable SoT for a vault with no remote yet: the value
// is recorded locally and the existing publish seam (federation/vault-publish.ts,
// which honours `opts.visibility`, fed by reconcile-publish's per-vault manifest
// read) creates the repo at the right visibility on first publish. But it is NOT
// evidence of what GitHub is currently serving — see C3 below.

export type VaultVisibilityTarget = FederationVisibility;

export interface VaultVisibilityArgs {
  vaultName: string;
  // The target visibility. The CLI derives this from --public / --private and
  // must refuse before calling when neither or both were given; the flow
  // re-validates (defense in depth, and the MCP/agent path has no commander).
  visibility: VaultVisibilityTarget;
  // The handler gate. `false` no longer throws: it runs every READ-ONLY step and
  // returns a `preview-required` receipt (M1, release review) so the handler can
  // SEE what would change before authorizing it. NOTHING is mutated on that
  // path — the gate itself is unchanged, only its output.
  confirmed: boolean;
}

export interface VaultVisibilityFlowOpts {
  db?: Client;
  // Topic + description + live-visibility reader/writer (util/gh.ts). Injected by tests.
  ghClient?: GhClient;
  // Repo-visibility writer (util/gh-federation.ts). Injected by tests.
  federationGhClient?: FederationGhClient;
  // Test seam — override the pod root (defaults to getFederationRoot()).
  podRoot?: string;
}

export interface VaultVisibilityGhReport {
  edited: boolean;
  skipped: boolean;
  skipReason: string | null;
  owner: string | null;
  repo: string | null;
  // C3 — the OBSERVED GitHub visibility before any write. `null` ONLY when the
  // vault has no remote at all; an unreadable remote refuses rather than guesses.
  observed: GhRepoVisibility | null;
}

export interface VaultVisibilityTopicReport {
  added: string[];
  removed: string[];
  skipped: boolean;
  skipReason: string | null;
}

// M1 — the pre-authorization surface. Every field is READ, never written.
export interface VaultVisibilityPreview {
  vault: string;
  owner: string | null;
  repo: string | null;
  ledgerVisibility: FederationVisibility;
  githubVisibility: GhRepoVisibility | "no-remote";
  target: FederationVisibility;
  topicsToAdd: string[];
  topicsToRemove: string[];
  irreversible: string;
}

export type VaultVisibilityStatus =
  | "flipped"
  // C3 — the manifest and GitHub (or the topic floor) disagreed, and the verb
  // converged them onto the target. The old code silently no-opped here.
  | "drift-repaired"
  | "already-at-target"
  // M1 — read-only: the handler gate was not satisfied.
  | "preview-required";

export interface VaultVisibilityResult {
  vault: string;
  vaultRid: string;
  from: FederationVisibility;
  to: FederationVisibility;
  changed: boolean;
  status: VaultVisibilityStatus;
  gh: VaultVisibilityGhReport;
  topics: VaultVisibilityTopicReport;
  ledger: { appended: boolean; visibility: FederationVisibility };
  // m3 — the @AUDIT mutation-journal entry in the vault's OWN audit ledger
  // (the same seam flows/rename.ts writes `vault.renamed` to). Best-effort and
  // non-fatal, exactly like rename's, but OBSERVABLE rather than silent.
  auditRecorded: boolean;
  // Always populated — the same shape the `preview-required` path returns, so a
  // machine reader can diff intent against outcome from a single field.
  preview: VaultVisibilityPreview;
  // An OWN vault's write gate never pays a gh probe (flows/writability.ts:238
  // early-returns for `source === "own"` with no subscription signal), and this
  // verb only ever acts on own vaults — so there is no cached writability verdict
  // for a visibility flip to invalidate. Stated in the receipt rather than paying a
  // pointless live re-probe. The DERIVED cache that DOES move is pod.yon, which is
  // regenerated from this ledger record on the next `lyt sync`.
  writableVerdictRefresh: "not-applicable-own-vault";
  notes: string[];
}

const VALID_VISIBILITIES: readonly FederationVisibility[] = ["private", "public"];

const IRREVERSIBLE_NOTE =
  "Flipping a vault PUBLIC exposes every note in it to the whole internet and cannot be " +
  "un-seen once crawled or forked.";

// C2 — mirrors flows/share.ts assertNotFederationManifestRepo. The federation
// manifest repo (`lyt-pod` / `lyt-pod-map`) carries every push_target, every
// vault rid and the whole federation map; flipping it PUBLIC publishes the pod
// topology in one command, and `--yes` is not an authorization anyone can give
// for that. Keyed on the REPO identity — the requested string literally being a
// reserved repo name, or the RESOLVED row's origin basename being one — so a
// legitimate vault whose LEAF is `lyt-pod` (qualified `{mesh}/lyt-pod`, real repo
// `lyt-vault-<mesh>--lyt-pod`) still passes.
function assertNotFederationManifestRepo(requested: string, row?: VaultRow): void {
  const originBasename = row?.gitUrl
    ? (row.gitUrl
        .split(/[\\/]/)
        .filter((s) => s.length > 0)
        .pop() ?? "")
    : "";
  if (
    isReservedFederationRepoName(requested) ||
    (originBasename.length > 0 && isReservedFederationRepoName(originBasename))
  ) {
    throw new Error(
      `Refusing to change the visibility of '${requested}': the federation manifest repo ` +
        `(lyt-pod / lyt-pod-map) is not a vault whose posture you flip — it exposes every ` +
        `push_target, vault rid, and your whole federation map. Use 'lyt federation' for the ` +
        `pod-repo axis.`,
    );
  }
}

export async function setVaultVisibilityFlow(
  args: VaultVisibilityArgs,
  opts: VaultVisibilityFlowOpts = {},
): Promise<VaultVisibilityResult> {
  if (!VALID_VISIBILITIES.includes(args.visibility)) {
    throw new Error(
      `invalid visibility '${args.visibility}' — expected exactly one of --public or --private.`,
    );
  }
  // C2 — cheap bare-name check BEFORE the handler gate; the resolved-row origin
  // check follows once the vault is looked up.
  assertNotFederationManifestRepo(args.vaultName);

  const podRoot = opts.podRoot ?? getFederationRoot();
  const { db, owns } = await resolveDb(opts.db);
  try {
    const row = await getVaultByName(db, args.vaultName);
    if (!row) {
      throw new Error(`No vault registered with name '${args.vaultName}'. Try 'lyt vault list'.`);
    }
    // Fail-closed — a SUBSCRIBED / cloned vault is somebody else's publication
    // decision. Never let this pod flip a foreign vault's visibility.
    if (row.source !== "own") {
      throw new Error(
        `Refusing to change the visibility of '${row.name}': it is not your vault ` +
          `(source '${row.source}'). Only an owned vault's publication posture is yours to ` +
          `change — ask the vault's owner.`,
      );
    }
    // C2 — belt-and-suspenders on the RESOLVED row's origin basename.
    assertNotFederationManifestRepo(args.vaultName, row);
    // Fail-closed — with no @FED_VAULT shard on disk there is no manifest to
    // record the decision in, so the flip would silently evaporate
    // (authorFedVaultMutation no-ops on a non-federated pod by design). Refuse
    // loudly instead of pretending.
    if (listFedVaultShards(podRoot).length === 0) {
      throw new Error(
        `Refusing to change the visibility of '${row.name}': this pod has no @FED_VAULT ` +
          `manifest ledger yet, so the decision could not be recorded anywhere. Run ` +
          `'lyt sync' (or 'lyt federation init') first, then retry.`,
      );
    }

    const ownerRepo = resolveOwnerRepo(row);
    // C1 — THE POD-OWNER FENCE. `ownerRepo` is parsed from the OBSERVED `git_url`
    // row, and `source === 'own'` is the one registry field known to lie: a vault
    // received by accepting a GitHub invitation and registered with `lyt vault
    // join` (whose `source` is optional and fail-closes to `own`) is FOREIGN
    // while claiming to be owned. Without this fence, `lyt vault visibility
    // <joined-vault> --public --yes` fires `gh repo edit --visibility public` at
    // a STRANGER'S repository using the local handler's admin token — an
    // irreversible publication of someone else's notes under their account.
    //
    // The discriminator is the CURRENT origin owner against the set of owners
    // this pod actually publishes to (federation handles, mesh push targets,
    // canonical destination owners) — derived from POLICY, never from the
    // observed remote, so a hijacked origin cannot vote itself in. Same set,
    // same helper, as flows/repair-vault-origin-owner.ts's mis-owned fence
    // (util/pod-owners.ts). Refuses BEFORE any gh call.
    if (ownerRepo !== null) {
      const knownPodOwners = await collectKnownPodOwners(db);
      // Final review (item 11) — an EMPTY owner set is not evidence that the
      // repository belongs to somebody else; it is evidence that this pod has not
      // established WHO IT IS yet (no federation identity, no mesh push target,
      // no canonical destination owner). Asserting "that repository is somebody
      // else's" there accuses the handler of hijacking their own vault and points
      // at no remedy. Same refusal, honest cause.
      if (knownPodOwners.size === 0) {
        throw new Error(
          `Refusing to change the visibility of '${row.name}': this pod has no known GitHub ` +
            `owners yet — no federation identity, no mesh push target, and no canonical ` +
            `destination owner — so its origin owner '${ownerRepo.owner}' cannot be checked ` +
            `against anything. Publishing a repository this pod cannot prove is yours is never ` +
            `safe. Run 'lyt sync' (or 'lyt federation init') to establish the pod identity ` +
            `first, then retry. No GitHub call was made.`,
        );
      }
      if (!knownPodOwners.has(ownerRepo.owner.toLowerCase())) {
        throw new Error(
          `Refusing to change the visibility of '${row.name}': its origin points at GitHub ` +
            `owner '${ownerRepo.owner}', which is not an owner this pod publishes to (it is ` +
            `not your federation handle, not a mesh push target, and not a canonical ` +
            `destination owner). That repository is somebody else's — a vault joined by ` +
            `invitation registers as 'own' but is FOREIGN — and publishing it is never yours ` +
            `to do. No GitHub call was made.`,
        );
      }
    }

    const ledgerVisibility = readLiveVisibility(podRoot, row.ridHex);
    const to = args.visibility;
    const notes: string[] = [];

    // C3 — OBSERVE GITHUB. The old flow folded the LEDGER only, so `--private`
    // no-opped whenever the repo was public but the record already said private —
    // exactly the drift this flow's own partial-failure paths create (a repo
    // flipped, then a failed ledger append; or a ledger append with a failed
    // topic edit). The observation reuses the SAME `/repos/{owner}/{repo}` payload
    // the topic reconciliation already needs, so it costs no extra round trip.
    const ghClient = opts.ghClient ?? realGhClient;
    let info: GhRepoInfo | null = null;
    if (ownerRepo !== null) {
      try {
        info = await ghClient.getRepo(ownerRepo.owner, ownerRepo.repo);
      } catch (err) {
        throw new Error(
          `Refusing to change the visibility of '${row.name}': could not read the live state of ` +
            `'${ownerRepo.owner}/${ownerRepo.repo}' from GitHub — ` +
            `${err instanceof Error ? err.message : String(err)}. The local ledger is NOT ` +
            `evidence of what GitHub is currently serving, so guessing from it could leave a ` +
            `public repository public. Fix connectivity/auth and retry.`,
        );
      }
      if (info.visibility === undefined) {
        throw new Error(
          `Refusing to change the visibility of '${row.name}': GitHub did not report a ` +
            `visibility for '${ownerRepo.owner}/${ownerRepo.repo}', so its live state is ` +
            `unobserved. The local ledger is not evidence of it. Retry once 'gh' can read the ` +
            `repository.`,
        );
      }
    }
    const ghVisibility: GhRepoVisibility | null = info?.visibility ?? null;

    // The per-class topic floor for the TARGET, diffed against the live set.
    const topicPlan = planTopics(info, to);
    const preview: VaultVisibilityPreview = {
      vault: row.name,
      owner: ownerRepo?.owner ?? null,
      repo: ownerRepo?.repo ?? null,
      ledgerVisibility,
      githubVisibility: ghVisibility ?? "no-remote",
      target: to,
      topicsToAdd: [...topicPlan.add],
      topicsToRemove: [...topicPlan.remove],
      irreversible: IRREVERSIBLE_NOTE,
    };

    const ledgerAtTarget = ledgerVisibility === to;
    const ghAtTarget = ghVisibility === null || ghVisibility === to;
    const topicsAtTarget = topicPlan.add.length === 0 && topicPlan.remove.length === 0;
    // M2(b) — the topic floor is part of "converged". Without it, a run whose
    // topic edit failed after a successful flip would find ledger === gh ===
    // target on the retry and no-op, leaving `lyt-public` advertised forever —
    // which is exactly what made the old remedy note untrue.
    const converged = ledgerAtTarget && ghAtTarget && topicsAtTarget;

    // M1 — the handler gate. Everything above is read-only; nothing below runs.
    if (!args.confirmed) {
      return {
        vault: row.name,
        vaultRid: row.ridHex,
        from: ledgerVisibility,
        to,
        changed: false,
        status: "preview-required",
        gh: {
          edited: false,
          skipped: true,
          skipReason: "preview-required",
          owner: preview.owner,
          repo: preview.repo,
          observed: ghVisibility,
        },
        topics: { added: [], removed: [], skipped: true, skipReason: "preview-required" },
        ledger: { appended: false, visibility: ledgerVisibility },
        auditRecorded: false,
        preview,
        writableVerdictRefresh: "not-applicable-own-vault",
        notes: [
          converged
            ? `'${row.name}' is already ${to} on GitHub and in the manifest; nothing would change.`
            : `'${row.name}': ${ledgerVisibility} (manifest) / ${preview.githubVisibility} ` +
              `(GitHub) -> ${to}.`,
          IRREVERSIBLE_NOTE,
          "Nothing was changed. Re-run with --yes to apply.",
        ],
      };
    }

    if (converged) {
      return {
        vault: row.name,
        vaultRid: row.ridHex,
        from: ledgerVisibility,
        to,
        changed: false,
        status: "already-at-target",
        gh: {
          edited: false,
          skipped: true,
          skipReason: "already-at-target",
          owner: preview.owner,
          repo: preview.repo,
          observed: ghVisibility,
        },
        topics: { added: [], removed: [], skipped: true, skipReason: "already-at-target" },
        ledger: { appended: false, visibility: ledgerVisibility },
        auditRecorded: false,
        preview,
        writableVerdictRefresh: "not-applicable-own-vault",
        notes: [`'${row.name}' is already ${to}; nothing to do.`],
      };
    }

    const gh: VaultVisibilityGhReport = {
      edited: false,
      skipped: true,
      skipReason: null,
      owner: ownerRepo?.owner ?? null,
      repo: ownerRepo?.repo ?? null,
      observed: ghVisibility,
    };
    const topics: VaultVisibilityTopicReport = {
      added: [],
      removed: [],
      skipped: true,
      skipReason: topicPlan.skipReason,
    };

    if (ownerRepo === null) {
      gh.skipReason = "no-remote";
      topics.skipReason = "no-remote";
      notes.push(
        `'${row.name}' has no GitHub remote yet — the GitHub step was skipped. The recorded ` +
          `visibility is honoured when the repo is first created by 'lyt sync'.`,
      );
    } else {
      const federationGh = opts.federationGhClient ?? realFederationGhClient;
      if (ghAtTarget) {
        gh.skipReason = "github-already-at-target";
      } else if (typeof federationGh.setRepoVisibility !== "function") {
        gh.skipReason = "gh-client-lacks-set-repo-visibility";
        notes.push(
          `The gh client in use cannot set repository visibility; only the local ledger was ` +
            `updated. The GitHub repo is still ${ghVisibility}.`,
        );
      } else {
        await federationGh.setRepoVisibility(ownerRepo.owner, ownerRepo.repo, to);
        gh.edited = true;
        gh.skipped = false;
      }
      // `applyTopicPlan` is a no-op for every non-actionable plan (already
      // conformant / not-admin / no-remote) and reports WHY, so it is always
      // reached when the repo was observed.
      if (info !== null) {
        await applyTopicPlan(ghClient, ownerRepo, info, topicPlan, topics, notes);
      }
    }

    // GAP #1 — the durable record. An EXPLICIT visibility override, so the
    // author does NOT carry the old value forward (the rename/move carry-forward
    // behaviour is untouched when `visibility` is omitted). Skipped when the
    // ledger already reads the target: the drift being repaired is elsewhere and
    // a redundant append would only add ledger noise.
    let ledgerAppended = false;
    if (!ledgerAtTarget) {
      ledgerAppended = true;
      try {
        authorFedVaultMutation({
          vaultRidHex: row.ridHex,
          vaultName: row.name,
          homeMeshRidHex: row.homeMeshRidHex,
          visibility: to,
          ...(opts.podRoot !== undefined ? { podRoot: opts.podRoot } : {}),
        });
      } catch (err) {
        ledgerAppended = false;
        const msg = err instanceof Error ? err.message : String(err);
        notes.push(
          `@FED_VAULT author FAILED — ${msg}. The GitHub repo may already be ${to} while the ` +
            `manifest still reads ${ledgerVisibility}. Re-run ` +
            `'lyt vault visibility ${row.name} --${to} --yes': it now reads the LIVE GitHub ` +
            `state, so it converges the manifest instead of no-opping.`,
        );
      }
    }

    // C3 — name the drift explicitly in the receipt. `flipped` is reserved for
    // the clean case where the manifest AND GitHub both moved together.
    // A vault with NO remote (`ghVisibility === null`) has nothing to disagree
    // with, so a ledger move there is a clean flip, not a drift repair.
    const status: VaultVisibilityStatus =
      !ledgerAtTarget && (ghVisibility === null || !ghAtTarget) ? "flipped" : "drift-repaired";
    if (status === "drift-repaired") {
      notes.push(
        `Converged drift: the manifest read ${ledgerVisibility}, GitHub read ` +
          `${preview.githubVisibility}${topicsAtTarget ? "" : ", the topic floor was non-conformant"}` +
          ` — all now ${to}.`,
      );
    } else if (!topicsAtTarget) {
      // Final review (item 14) — a clean `flipped` can ALSO have carried a topic
      // repair (a previous run whose topic edit failed after the flip). The
      // drift-repaired branch said so and this one stayed silent, so the receipt
      // under-reported half of what the verb reconciled.
      notes.push(
        topics.skipped
          ? `The topic floor was non-conformant and was NOT reconciled ` +
              `(${topics.skipReason ?? "unknown"}).`
          : `The topic floor was non-conformant and was reconciled alongside the flip: ` +
              `+[${topics.added.join(", ")}] -[${topics.removed.join(", ")}].`,
      );
    }

    // m3 — the MUTATION JOURNAL. Same seam and same best-effort posture as
    // flows/rename.ts's `vault.renamed` @AUDIT record: the mutation already
    // landed, so a journal failure must not fail the verb, but it IS reported.
    const auditRecorded = await recordVisibilityAudit(row, {
      from: ledgerVisibility,
      to,
      status,
      ghEdited: gh.edited,
      topicsAdded: topics.added,
      topicsRemoved: topics.removed,
      ledgerAppended,
    });

    // Final review (item 5) — the OBSERVED manifest value, never the intended
    // one. `visibility: to` reported the target even when the @FED_VAULT append
    // had FAILED, so a receipt whose notes said "NOT recorded" simultaneously
    // claimed the manifest was already at the target. Re-read the fold after the
    // attempt; fall back to the pre-state (which is what the ledger still holds
    // when nothing was appended, and the only honest answer if the re-read itself
    // cannot run).
    let ledgerVisibilityAfter: FederationVisibility = ledgerAppended ? to : ledgerVisibility;
    try {
      ledgerVisibilityAfter = readLiveVisibility(podRoot, row.ridHex);
    } catch {
      ledgerVisibilityAfter = ledgerAppended ? to : ledgerVisibility;
    }

    return {
      vault: row.name,
      vaultRid: row.ridHex,
      from: ledgerVisibility,
      to,
      changed: true,
      status,
      gh,
      topics,
      ledger: { appended: ledgerAppended, visibility: ledgerVisibilityAfter },
      auditRecorded,
      preview,
      writableVerdictRefresh: "not-applicable-own-vault",
      notes,
    };
  } finally {
    if (owns) await closeRegistry(db);
  }
}

// The @AUDIT mutation-journal record for a completed visibility change. Written
// into the VAULT'S OWN audit ledger (`.lyt/lyt.db` + the @AUDIT YON shard), the
// same place flows/rename.ts records `vault.renamed`. Best-effort: the outward
// mutation has already happened, so a journal failure is reported (`false`),
// never thrown.
async function recordVisibilityAudit(
  row: VaultRow,
  details: {
    from: FederationVisibility;
    to: FederationVisibility;
    status: VaultVisibilityStatus;
    ghEdited: boolean;
    topicsAdded: readonly string[];
    topicsRemoved: readonly string[];
    ledgerAppended: boolean;
  },
): Promise<boolean> {
  try {
    const auditDb = await openAuditDb(row.path);
    try {
      await recordAudit(row.path, auditDb, {
        id: newUuidv7Bytes(),
        ts: Date.now(),
        actor: "user:lyt",
        action: "vault.visibility.changed",
        targetType: "vault",
        targetId: row.ridHex,
        result: "success",
        details: {
          from: details.from,
          to: details.to,
          status: details.status,
          gh_repo_edited: details.ghEdited,
          topics_added: [...details.topicsAdded],
          topics_removed: [...details.topicsRemoved],
          fed_vault_appended: details.ledgerAppended,
        },
        stampSrc: "flows/vault-visibility",
      });
      return true;
    } finally {
      await closeVaultDb(auditDb);
    }
  } catch {
    return false;
  }
}

interface TopicPlan {
  add: string[];
  remove: string[];
  skipReason: string | null;
}

// Assert the per-class topic floor for the NEW visibility and, on a flip back to
// private, STRIP `lyt-public` (GAP #2). PURE — diffs the live topic set read by
// the C3 observation so `added` / `removed` in the receipt are the REAL deltas,
// not the requested set. Performs no gh write.
function planTopics(info: GhRepoInfo | null, to: FederationVisibility): TopicPlan {
  if (info === null) return { add: [], remove: [], skipReason: "no-remote" };
  if (!info.isAdmin) return { add: [], remove: [], skipReason: "not-admin" };
  const have = new Set(info.topics.map((t) => t.trim().toLowerCase()));
  // "public-vault" is BRAND_TOPICS + `lyt-public`; "vault" is the plain floor.
  const floor = baseTopicsForClass(to === "public" ? "public-vault" : "vault");
  const add = floor.filter((t) => !have.has(t.toLowerCase()));
  // GAP #2 — the reversal. Only ever removes the publication marker, never a
  // user-authored topic (editRepo stays additive for everything else).
  const remove = to === "private" && have.has(PUBLIC_TOPIC) ? [PUBLIC_TOPIC] : [];
  const skipReason = add.length === 0 && remove.length === 0 ? "already-conformant" : null;
  return { add, remove, skipReason };
}

// The one gh WRITE for topics. The existing description is written back verbatim
// (editRepo takes one) so a topic assertion never clobbers it.
async function applyTopicPlan(
  ghClient: GhClient,
  ownerRepo: { owner: string; repo: string },
  info: GhRepoInfo,
  plan: TopicPlan,
  topics: VaultVisibilityTopicReport,
  notes: string[],
): Promise<void> {
  if (plan.skipReason !== null) {
    if (plan.skipReason === "not-admin") {
      notes.push(`Not an admin on '${ownerRepo.owner}/${ownerRepo.repo}' — topics were left as-is.`);
    }
    return;
  }
  try {
    await ghClient.editRepo(
      ownerRepo.owner,
      ownerRepo.repo,
      info.description,
      plan.add,
      plan.remove,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    topics.skipReason = `gh-edit-failure: ${msg}`;
    // M2 (release review) — the OLD note pointed at `lyt vault sync-metadata
    // --apply`, which was additive-only and could never strip `lyt-public`. Both
    // halves are now true: this verb re-runs correctly (C3 + the topic floor in
    // `converged`, so a retry is not a no-op), and sync-metadata's assert path
    // reconciles the class floor downward for a private vault.
    notes.push(
      `Topic reconciliation failed on '${ownerRepo.owner}/${ownerRepo.repo}' — ${msg}. ` +
        `Re-run this verb to heal it: 'lyt vault visibility <vault> ` +
        `--${plan.remove.length > 0 ? "private" : "public"} --yes' now reconciles the topic ` +
        `floor even when the repository visibility already matches.`,
    );
    return;
  }
  topics.skipped = false;
  topics.added = [...plan.add];
  topics.removed = [...plan.remove];
}

// The CURRENT converged visibility for this vault_rid, from the same HLC-LWW fold
// the manifest renderer and reconcile-publish read. No live record for the rid yet
// → the configured default (`private`), which is exactly what the author would
// otherwise carry forward. NOT evidence of what GitHub is serving — see C3.
function readLiveVisibility(podRoot: string, vaultRidHex: string): FederationVisibility {
  const live = foldFedVaults(readAllFedVaultRecords(podRoot)).find(
    (v) => v.vaultRid === vaultRidHex,
  );
  return live?.visibility ?? resolveConfig().defaultRepoVisibility;
}

function resolveOwnerRepo(row: VaultRow): { owner: string; repo: string } | null {
  if (row.gitUrl === null || row.gitUrl.trim().length === 0) return null;
  return parseOwnerRepoFromUrl(row.gitUrl);
}

async function resolveDb(injected?: Client): Promise<{ db: Client; owns: boolean }> {
  if (injected !== undefined) return { db: injected, owns: false };
  return { db: await openRegistry(), owns: true };
}
