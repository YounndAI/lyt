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

import { z, type ZodRawShape } from "zod";

import {
  abandonVaultFlow,
  generatePrimerFlow,
  infoVaultFlow,
  listVaultsFlow,
  patternRunFlow,
  reconnectVaultFlow,
  searchCascadeFlow,
  shareVaultFlow,
  syncMetadataFlow,
  unshareVaultFlow,
  vaultAccessFlow,
  vaultInvitesFlow,
  verifyVaultsFlow,
  type AccessProvider,
  type PrimerScope,
  type SearchCascadeResult,
  type SearchCascadeScope,
  type ShareLevel,
} from "@younndai/lyt-vault";
import {
  addSource,
  listSources,
  parseScope,
  removeSource,
  serializeScope,
  withRegistry,
} from "@younndai/lyt-mesh";

import { guarded } from "./errors.js";

/** Result shape an MCP tool handler returns (the SDK's CallToolResult subset we use). */
export interface ToolResult {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
}

/**
 * Phase 0 — a declarative op-registry row. One row per MCP tool. The
 * per-tool result-shaping logic lives inside `handler` so behavior is
 * byte-identical to the prior hand-registered tools. `access`, `handlerGated`,
 * and `defaultProfile` are carried now and consumed by later phases.
 */
export interface OpRow {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  access: "read" | "write";
  handlerGated: boolean;
  defaultProfile: boolean;
}

function asText(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

// feat/agent-query-expansion — recall-lean projection of the cascade result for
// the MCP `search` tool. The agent consuming this filters among crowded,
// equally-relevant docs, so we drop internal-only noise (rawScore, kpMatch,
// trace, durationMs) and surface a compact top-N list: per hit the path + its
// vault/mesh + snippet + the scoring fields it needs to triage (tier,
// confidence, blendedScore). The projection happens ONLY at the MCP layer —
// `searchCascadeFlow`'s own result contract is unchanged (other consumers +
// tests depend on it). `query` echoes the ORIGINAL query (never the expansion).
interface LeanSearchHit {
  path: string;
  vault: string;
  mesh: string | null;
  snippet: string;
  tier: number;
  confidence: number;
  blendedScore?: number;
}

interface LeanSearchResult {
  query: string;
  scope: string;
  scopeTarget: string | null;
  limit: number;
  count: number;
  results: LeanSearchHit[];
}

function projectSearchResult(result: SearchCascadeResult): LeanSearchResult {
  const results: LeanSearchHit[] = result.results.map((r) => ({
    path: r.figment_path,
    vault: r.vault_name,
    mesh: r.mesh_name,
    snippet: r.snippet,
    tier: r.tier,
    confidence: r.confidence,
    ...(r.blendedScore !== undefined ? { blendedScore: r.blendedScore } : {}),
  }));
  return {
    query: result.query,
    scope: result.scope,
    scopeTarget: result.scopeTarget,
    limit: result.limit,
    count: results.length,
    results,
  };
}

// Phase A — test seam for the `capture` write gate. patternRunFlow accepts
// an injectable AccessProvider (defaulting to the real gh-backed provider);
// the MCP layer has no arg channel for it (generic clients must not pass auth
// internals), so tests set this override to inject a fake provider returning a
// blocked verdict and exercise the structured-refusal path WITHOUT a real
// gh probe or a heavy subscriber-vault fixture. Undefined in production → the
// flow uses its real GhAccessProvider default.
let captureAccessProviderOverride: AccessProvider | undefined;

/** Test-only: inject (or clear, with `undefined`) the capture write-gate provider. */
export function __setCaptureAccessProvider(provider: AccessProvider | undefined): void {
  captureAccessProviderOverride = provider;
}

export function buildOpRegistry(): OpRow[] {
  return [
    {
      name: "vault.list",
      title: "List Lyt vaults",
      description:
        "List all registered Lyt vaults on this machine. Returns rid, name, path, status, edges-count, etc.",
      inputSchema: {
        includeTombstones: z
          .boolean()
          .optional()
          .describe("Include tombstoned vaults in the result (default: true)"),
      },
      access: "read",
      handlerGated: false,
      defaultProfile: true,
      handler: async ({ includeTombstones }) => {
        const noTombstones = includeTombstones === false;
        const { vaults } = await listVaultsFlow({ noTombstones });
        return asText({ vaults });
      },
    },
    {
      name: "vault.info",
      title: "Vault info",
      description:
        "Show metadata for a registered vault: path, mesh edges (outbound + inbound), size, file count.",
      inputSchema: {
        name: z.string().describe("Registered vault name"),
      },
      access: "read",
      handlerGated: false,
      defaultProfile: true,
      handler: async ({ name }) => {
        const result = await infoVaultFlow(name as string);
        return asText(result);
      },
    },
    {
      name: "vault.verify",
      title: "Verify vaults",
      description:
        "Walk the registry, stat each path, flip missing vaults to status='missing'. Read-only on files. Auto-promotes 'missing' rows to 'tombstoned' after threshold N failures (default 3; override via LYT_TOMBSTONE_THRESHOLD).",
      inputSchema: {
        thresholdN: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Auto-promotion threshold; defaults to env LYT_TOMBSTONE_THRESHOLD or 3"),
      },
      access: "read",
      handlerGated: false,
      defaultProfile: true,
      handler: async ({ thresholdN }) => {
        const result = await verifyVaultsFlow(
          thresholdN === undefined ? {} : { thresholdN: thresholdN as number },
        );
        return asText(result);
      },
    },
    {
      name: "vault.reconnect",
      title: "Reconnect vault",
      description:
        "Heal a missing or disconnected vault by repointing the registry row to a new filesystem path. Validates .lyt/vault.yon rid matches the registry row.",
      inputSchema: {
        name: z.string().describe("Registered vault name"),
        newPath: z.string().describe("New filesystem path containing the vault"),
      },
      access: "write",
      handlerGated: false,
      defaultProfile: true,
      handler: async ({ name, newPath }) => {
        const result = await reconnectVaultFlow({
          name: name as string,
          newPath: newPath as string,
        });
        return asText(result);
      },
    },
    {
      name: "mesh.source.list",
      title: "List mesh sources",
      description: "List configured vault sources (where Lyt looks for vaults to clone).",
      inputSchema: {},
      access: "read",
      handlerGated: false,
      defaultProfile: true,
      handler: async () => {
        const sources = await withRegistry(listSources);
        const serialized = sources.map((s) => ({ ...s, scope: serializeScope(s.scope) }));
        return asText({ sources: serialized });
      },
    },
    {
      name: "mesh.source.add",
      title: "Add mesh source",
      description: "Register a new vault source.",
      inputSchema: {
        name: z.string().describe("Soft label, e.g. 'younndai', 'acme', 'personal'"),
        host: z.string().describe("Git host hostname, e.g. 'github.com'"),
        owner: z.string().describe("Org or user under that host"),
        scope: z
          .string()
          .optional()
          .describe(
            "Which repos count: 'all' | 'topic=<tag>' | 'repos=<a,b,c>' (default: topic=lyt-vault)",
          ),
      },
      access: "write",
      handlerGated: false,
      defaultProfile: true,
      handler: async ({ name, host, owner, scope }) => {
        const parsed = parseScope((scope as string | undefined) ?? "topic=lyt-vault");
        const row = await withRegistry((db) =>
          addSource(db, {
            name: name as string,
            host: host as string,
            owner: owner as string,
            scope: parsed,
          }),
        );
        return asText({ ...row, scope: serializeScope(row.scope) });
      },
    },
    {
      name: "mesh.source.remove",
      title: "Remove mesh source",
      description: "Remove a configured vault source by name.",
      inputSchema: {
        name: z.string().describe("Source name to remove"),
      },
      access: "write",
      handlerGated: false,
      defaultProfile: true,
      handler: async ({ name }) => {
        const removed = await withRegistry((db) => removeSource(db, name as string));
        return asText({ name, removed });
      },
    },
    // ----------------------------------------------------------------------
    // Phase A — T1 core-loop verbs over lyt-vault flows.
    // ----------------------------------------------------------------------
    {
      name: "capture",
      title: "Capture a Figment",
      description:
        "Capture a Figment (Obsidian-flavored markdown note) into a Lyt vault under the v1 8-field frontmatter contract. Writes <vault>/notes/<date>-<slug>.md via the knowledge-capture pattern.",
      inputSchema: {
        purpose: z.string().describe("Author-supplied: why keep this Figment? (mandatory)"),
        topic: z.string().describe("Author-supplied: semantic category for this Figment (mandatory)"),
        vault: z.string().describe("Registered vault name to capture into"),
        content: z
          .string()
          .min(1, "content must be non-empty")
          .describe("Figment body — plain Obsidian-flavored markdown (mandatory, non-empty, at the MCP layer)"),
        tags: z.array(z.string()).optional().describe("Optional tags, e.g. ['alpha','beta']"),
        weight: z.number().optional().describe("Figment weight 1-5 (default 3)"),
        title: z.string().optional().describe("Optional explicit title (else derived from slug)"),
        slug: z.string().optional().describe("Optional filename slug (else auto-generated)"),
      },
      access: "write",
      handlerGated: false,
      defaultProfile: true,
      handler: ({ purpose, topic, vault, content, tags, weight, title, slug }) =>
        guarded(async () => {
          const vars: Record<string, string> = {
            purpose: purpose as string,
            topic: topic as string,
            content: content as string,
          };
          if (Array.isArray(tags)) vars["tags"] = (tags as string[]).join(", ");
          if (weight !== undefined) vars["weight"] = String(weight);
          if (title !== undefined) vars["title"] = title as string;
          const result = await patternRunFlow({
            patternName: "knowledge-capture",
            verbId: "capture",
            vaultName: vault as string,
            ...(slug !== undefined ? { slug: slug as string } : {}),
            vars,
            ...(captureAccessProviderOverride !== undefined
              ? { accessProvider: captureAccessProviderOverride }
              : {}),
          });
          return asText(result);
        }),
    },
    {
      name: "search",
      title: "Search the pod",
      description:
        "Tiered-cascade search across the pod (or a single mesh/vault): arcs → lanes → FTS5 → edges, confidence-ranked. " +
        "BEFORE searching, EXPAND the query: emit 6–10 domain/synonym terms a relevant note would likely use but the " +
        "literal query omits (related concepts, alternate phrasings, technical terms, near-synonyms), and pass them as " +
        "`expansionTerms`. The tool folds those terms into the keyword/BM25 channel to build the lexical handle that " +
        "surfaces buried, vocabulary-mismatched targets the bare query would miss. Returns a compact top-N projection: " +
        "per hit { path, vault, mesh, snippet, tier, confidence, blendedScore? }, plus { query, scope, scopeTarget, limit, count }.",
      inputSchema: {
        query: z.string().describe("Search query (the literal user intent)"),
        expansionTerms: z
          .array(z.string().max(64))
          .max(20)
          .optional()
          .describe(
            "6–10 domain/synonym/related terms a relevant note might use but the literal query omits. " +
              "Emit these BEFORE searching to manufacture rare high-signal keywords; the tool folds them into the " +
              "FTS5/BM25 channel so buried, vocabulary-mismatched targets surface. Does not change the displayed query.",
          ),
        scope: z
          .enum(["vault", "mesh", "federation"])
          .optional()
          .describe("Search scope (default: federation)"),
        scopeTarget: z
          .string()
          .optional()
          .describe("Vault or mesh name when scope is 'vault' or 'mesh'"),
        limit: z.number().optional().describe("Max results (default 20)"),
      },
      access: "read",
      handlerGated: false,
      defaultProfile: true,
      handler: ({ query, expansionTerms, scope, scopeTarget, limit }) =>
        guarded(async () => {
          const result = await searchCascadeFlow({
            query: query as string,
            ...(expansionTerms !== undefined
              ? { expansionTerms: expansionTerms as string[] }
              : {}),
            ...(scope !== undefined ? { scope: scope as SearchCascadeScope } : {}),
            ...(scopeTarget !== undefined ? { scopeTarget: scopeTarget as string } : {}),
            ...(limit !== undefined ? { limit: limit as number } : {}),
          });
          return asText(projectSearchResult(result));
        }),
    },
    {
      name: "sync",
      title: "Sync vault metadata",
      description:
        "Sync GitHub repo metadata (description + topics) from a vault's .lyt/vault.yon, and regenerate mesh-context/agents.md. Scope is mandatory (vault / vaults / mesh).",
      inputSchema: {
        vault: z.string().optional().describe("Single vault name to sync"),
        vaults: z
          .array(z.string())
          .optional()
          .describe("Vault name patterns (glob) to sync"),
        mesh: z.string().optional().describe("Root vault name to traverse a mesh from"),
        mode: z
          .enum(["dry-run", "apply"])
          .optional()
          .describe("'dry-run' (default) reports changes; 'apply' writes to GitHub"),
        noConfirm: z
          .boolean()
          .optional()
          .describe("Required for --apply on a non-TTY run (script safety)"),
      },
      access: "write",
      handlerGated: false,
      defaultProfile: true,
      handler: ({ vault, vaults, mesh, mode, noConfirm }) =>
        guarded(async () => {
          const scope: {
            vault?: string;
            vaults?: readonly string[];
            mesh?: string;
          } = {};
          if (vault !== undefined) scope.vault = vault as string;
          if (Array.isArray(vaults)) scope.vaults = vaults as string[];
          if (mesh !== undefined) scope.mesh = mesh as string;
          const result = await syncMetadataFlow({
            scope,
            mode: (mode as "dry-run" | "apply" | undefined) ?? "dry-run",
            // MCP invocations are non-interactive; treat as non-TTY so an
            // --apply without noConfirm is refused (the flow's script-safety
            // guard), surfaced as a structured error.
            isTty: false,
            ...(noConfirm !== undefined ? { noConfirm: noConfirm as boolean } : {}),
          });
          return asText(result);
        }),
    },
    {
      name: "primer",
      title: "Generate a primer",
      description:
        "Generate a deterministic agent-priming markdown digest for a vault, mesh, or the federation (top keywords, active arcs, recent activity, top lanes).",
      inputSchema: {
        scope: z
          .enum(["vault", "mesh", "federation"])
          .describe("Primer scope"),
        scopeTarget: z
          .string()
          .optional()
          .describe("Vault or mesh name when scope is 'vault' or 'mesh'"),
        topKeywords: z.number().optional().describe("Top-N keywords (default 20)"),
        topArcs: z.number().optional().describe("Top-N arcs/lanes (default 10)"),
        provenanceDays: z.number().optional().describe("Recent-activity window in days (default 7)"),
        dryRun: z.boolean().optional().describe("Render + return markdown without writing to disk"),
      },
      access: "read",
      handlerGated: false,
      defaultProfile: true,
      handler: ({ scope, scopeTarget, topKeywords, topArcs, provenanceDays, dryRun }) =>
        guarded(async () => {
          const result = await generatePrimerFlow({
            scope: scope as PrimerScope,
            ...(scopeTarget !== undefined ? { scopeTarget: scopeTarget as string } : {}),
            ...(topKeywords !== undefined ? { topKeywords: topKeywords as number } : {}),
            ...(topArcs !== undefined ? { topArcs: topArcs as number } : {}),
            ...(provenanceDays !== undefined ? { provenanceDays: provenanceDays as number } : {}),
            ...(dryRun !== undefined ? { dryRun: dryRun as boolean } : {}),
          });
          return asText(result);
        }),
    },
    // ----------------------------------------------------------------------
    // keystone Phase C C8 — vault access/share federation verbs. The
    // mutation verbs here (vault.share, vault.unshare, vault.invites.accept,
    // vault.abandon) act against the gh repo-collaborator ACL / LYT local
    // adoption state (gh-as-sole-SoT for sharing — the gh repo-collaborator
    // grant IS the record; no new store). The read verbs (vault.access,
    // vault.invites list-path) never mutate.
    //
    // NOTE: `handlerGated: true` on the MUTATION OpRows (vault.share,
    // vault.unshare, vault.invites.accept, vault.abandon) is now READ and
    // ENFORCED at MCP DISPATCH (fed-v2 L2 Governance Phase 2). `registerTools`
    // (generate-tools.ts) wraps each gated op with a default-deny dispatch: a
    // handlerGated op FAILS CLOSED (returns an error ToolResult, never calls the
    // handler) unless the server was launched with the out-of-band handler
    // approval — resolved ONCE at startup from `LYT_MCP_HANDLER_APPROVAL`
    // (server.ts: resolveHandlerApproval), NEVER from a tool-call `args` object,
    // so a caller cannot forge it. As a structural invariant, `registerTools`
    // also STRIPS any caller-settable `confirmed` field from a write op's
    // inputSchema at registration, so the schema the client sees never carries
    // it and an attacker `confirmed:true` is inexpressible (the SDK validates
    // args against the registered schema). The per-flow `confirmed: false`
    // below is RETAINED as
    // defense-in-depth (a second, independent fail-closed beneath dispatch) —
    // do NOT remove it. The CLI path remains separately gated via `--yes` →
    // `confirmed` (it calls the flows directly, not through MCP dispatch). The
    // read verbs declare `handlerGated: false` — listing never mutates, no gate.
    //
    // SEE ALSO (coupled — keep in sync): the literal `confirmed: false` field
    // name on the 4 gated handlers below is the SAME gate field as
    // CALLER_SETTABLE_GATE_FIELD = "confirmed" in
    // packages/lyt-mcp/src/generate-tools.ts (the field the registration-time
    // strip removes from a write op's inputSchema) and the
    // `if (!args.confirmed) throw ...` refusals in
    // packages/lyt-vault/src/flows/{share.ts,invites.ts,abandon.ts}. A rename of
    // that constant MUST move these `confirmed` field names with it — grep
    // `confirmed` across lyt-mcp + lyt-vault before renaming (/audit-coupled-constant).
    //
    // RESIDUAL SCOPE CUT ([P2-D], deferred): the local append-only gh-ACL grant
    // ledger is DEFERRED to follow-on P2.b — so the irreversible
    // `vault.share` / `vault.unshare` gh-collaborator grant remains UNAUDITED
    // (no local tamper-evident record of who was granted what, when) until P2.b
    // lands. Dispatch is gated; the grant itself is not yet ledgered.
    // ----------------------------------------------------------------------
    {
      name: "vault.share",
      title: "Share a vault",
      description:
        "Grant a GitHub handle read|write access to a vault (gh repo-collaborator). Handler-gated.",
      inputSchema: {
        vault: z.string().describe("Registered vault name"),
        with: z.string().describe("GitHub handle to share with"),
        access: z.enum(["read", "write"]).describe("Access level"),
      },
      access: "write",
      handlerGated: true,
      defaultProfile: true,
      handler: ({ vault, with: withHandle, access }) =>
        guarded(async () => {
          const result = await shareVaultFlow({
            vaultName: vault as string,
            withHandle: withHandle as string,
            level: access as ShareLevel,
            confirmed: false,
          });
          return asText(result);
        }),
    },
    {
      name: "vault.unshare",
      title: "Unshare a vault",
      description:
        "Revoke a GitHub handle's access to a vault (remove the gh repo-collaborator). Handler-gated.",
      inputSchema: {
        vault: z.string().describe("Registered vault name"),
        with: z.string().describe("GitHub handle to unshare from"),
      },
      access: "write",
      handlerGated: true,
      defaultProfile: true,
      handler: ({ vault, with: withHandle }) =>
        guarded(async () => {
          const result = await unshareVaultFlow({
            vaultName: vault as string,
            withHandle: withHandle as string,
            confirmed: false,
          });
          return asText(result);
        }),
    },
    {
      name: "vault.access",
      title: "Show vault access",
      description:
        "Read the live gh repo-collaborator access state of a vault and reconcile it against LYT's local subscription view. Read-only.",
      inputSchema: {
        vault: z.string().describe("Registered vault name"),
        canIShare: z
          .boolean()
          .optional()
          .describe("Skip listing grants; just resolve whether the caller can share this vault"),
      },
      access: "read",
      handlerGated: false,
      defaultProfile: true,
      handler: ({ vault, canIShare }) =>
        guarded(async () => {
          const result = await vaultAccessFlow(
            { vaultName: vault as string },
            canIShare ? { canIShareOnly: true } : {},
          );
          return asText(result);
        }),
    },
    {
      name: "vault.invites",
      title: "List vault invitations",
      description:
        "List the caller's pending GitHub repository invitations (read-only). Accept via vault.invites.accept.",
      inputSchema: {},
      access: "read",
      handlerGated: false,
      defaultProfile: true,
      handler: () =>
        guarded(async () => {
          // accept undefined → list path (read-only); confirmed is irrelevant here.
          const result = await vaultInvitesFlow({ confirmed: false });
          return asText(result);
        }),
    },
    {
      name: "vault.invites.accept",
      title: "Accept a vault invitation",
      description:
        "Accept a pending GitHub repository invitation by id (gh user-repository-invitation). Handler-gated.",
      inputSchema: {
        id: z.number().int().positive().describe("The gh invitation id to accept"),
      },
      access: "write",
      handlerGated: true,
      defaultProfile: true,
      handler: ({ id }) =>
        guarded(async () => {
          const result = await vaultInvitesFlow({ accept: id as number, confirmed: false });
          return asText(result);
        }),
    },
    {
      name: "vault.abandon",
      title: "Abandon a vault",
      description:
        "Un-adopt a vault: remove only LYT's local .lyt/ adoption state and deregister it. Your markdown files and GitHub repo are untouched. Handler-gated.",
      inputSchema: {
        vault: z.string().describe("Registered vault name"),
      },
      access: "write",
      handlerGated: true,
      defaultProfile: true,
      handler: ({ vault }) =>
        guarded(async () => {
          const result = await abandonVaultFlow(vault as string, { confirmed: false });
          return asText(result);
        }),
    },
  ];
}
