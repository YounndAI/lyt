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

// Phase C (UNIT 2 — the fused-B-3 substance) — tier payload DEFINITIONS.
//
// The 5-artifact taxonomy splits scaffolded vaults into two tiers:
//   • RICH (`{mesh}/main`) — the mesh-defining main vault. Gets the full seed
//     set PLUS a written mesh-level directive block (welcome copy + mesh-prop
//     write target). It anchors the mesh, so it carries the orientation a fresh
//     handler/agent needs to understand the WHOLE mesh, not just one vault.
//   • MINI (non-main) — a member vault. Gets the minimal CONFORMANT set: the
//     same priming-file skeleton (so agents.md / lyt-overview.md / README all
//     exist and are FTS-honest), but a leaner welcome and no mesh-prop write
//     (a member vault does not define mesh properties — that is the main's job,
//     grounded by SPIKE-1).
//
// DATA-DRIVEN BY DESIGN (the plan's explicit constraint): this file is the
// single PAYLOAD-DEFINITION object. `scaffold/init.ts` SELECTS a payload by
// tier; it does NOT inline the contents. When B-1's vault-contract lands it can
// SUPPLY this data (e.g. from contract YON) without touching the init branch —
// the consumer reads `TIER_PAYLOADS[tier]`, never literal copy.
//
// DRAFT-FOR-RATIFICATION: the COPY in WELCOME_FIGMENT_* + the mesh-directive
// text below is draft seed content. The handler ratifies it before it ships
// (D-prototype: B-2 is the working prototype B-1 ratifies/revises). Keep the
// voice consistent with the existing templates (templates/*.md) — plain,
// non-marketing, byte-region-honest. Do NOT invent brand/marketing claims here.

import { buildFrontmatter } from "./contract.js";

/** The two scaffold tiers. `{mesh}/main` → "rich"; everything else → "mini". */
export type ScaffoldTier = "rich" | "mini";

// A fixed epoch sentinel timestamp for seed-Figment frontmatter. Same rationale
// as priming.ts SCAFFOLD_FRONTMATTER_TIMESTAMP: scaffold seeds are not authored
// at a meaningful instant, so `created == modified == epoch` is the truthful,
// deterministic value (no churn on re-scaffold, regen-idempotency preserved).
const SCAFFOLD_FRONTMATTER_TIMESTAMP = "1970-01-01T00:00:00.000Z";

/**
 * Resolve the scaffold tier from a vault NAME. The mesh-defining main vault is
 * addressed `{mesh}/main` (see mesh-init.ts mainVaultName); any other name is a
 * member vault. A bare name with no `/` is treated as mini (it is not a
 * mesh's main).
 */
export function resolveScaffoldTier(vaultName: string): ScaffoldTier {
  const leaf = vaultName.includes("/") ? vaultName.slice(vaultName.lastIndexOf("/") + 1) : vaultName;
  return leaf === "main" ? "rich" : "mini";
}

// ---------------------------------------------------------------------------
// Seed-Figment specification — a payload-defined Figment to write under notes/.
// Each tier names which seed Figments it writes (data, not inlined contents at
// the call site). `body` is plain markdown; `frontmatter()` always flows through
// the contract SoT (buildFrontmatter) carrying `lyt-scaffold: true` so the seed
// is FTS/primer-excluded by the g6 gate.
// ---------------------------------------------------------------------------

export interface SeedFigmentSpec {
  /** Path relative to the vault root, e.g. "notes/welcome.md". */
  relativePath: string;
  /** Figment title (frontmatter + H1). */
  title: string;
  /** Author-supplied `purpose` for the seed Figment's frontmatter. */
  purpose: string;
  /** Markdown body (no frontmatter — frontmatter is rendered via the SoT). */
  body: string;
}

/** Render the full Figment text (frontmatter + body) for a seed spec. */
export function renderSeedFigment(spec: SeedFigmentSpec): string {
  const frontmatter = buildFrontmatter({
    title: spec.title,
    created: SCAFFOLD_FRONTMATTER_TIMESTAMP,
    modified: SCAFFOLD_FRONTMATTER_TIMESTAMP,
    // PROVISIONAL tag schema (D-prototype, informs B-1): `lyt/scaffold` is a
    // suppressible content-origin marker for graph/primer surfaces — distinct
    // from the `lytScaffold: true` field below (the FTS-exclusion gate). Both
    // coexist; FTS exclusion stays the field's job, not the tag's.
    tags: ["lyt/scaffold"],
    purpose: spec.purpose,
    topic: "scaffold",
    lytScaffold: true,
  });
  return frontmatter + spec.body;
}

// ---------------------------------------------------------------------------
// DRAFT seed-Figment bodies. DRAFT-FOR-RATIFICATION.
// ---------------------------------------------------------------------------

// RICH (main) welcome — orients a handler/agent to the MESH this vault anchors.
const RICH_WELCOME_BODY = `# Welcome to this mesh

This is the **main vault** of its mesh — the vault that defines the mesh and
anchors its members. If you are reading this in a fresh pod, start here.

## What a mesh is

A mesh is a group of Lyt vaults that share context. Each vault is its own Git
repo of Obsidian-flavoured markdown; the mesh is the federation layer over them.
This main vault holds the cross-cutting material — identity, conventions, and
the decisions that apply across the whole mesh.

## Where things live

- \`lyt-overview.md\` — this vault's identity + a transclusion of its mesh context.
- \`.lyt/mesh-context.md\` — the auto-regenerated mesh edges (parent, peers).
- \`.lyt/primers/\` — agent-priming digests; read them before deep exploration.
- \`notes/\` — your Figments (markdown notes) live here.

## Next steps

- Add member vaults with \`lyt vault init <mesh>/<name>\`.
- Capture your first real note with \`lyt capture\` (or just write markdown in \`notes/\`).
- Lyt only writes inside the regions it marks (frontmatter + managed blocks);
  your prose is never touched.

_(This is a scaffold seed. Replace it with your own first note, or delete it.)_
`;

// MINI (member) welcome — leaner; orients to THIS vault, points back to the mesh.
const MINI_WELCOME_BODY = `# Welcome to this vault

This is a **member vault** in a Lyt mesh. Its main vault holds the mesh-wide
material; this vault holds its own Figments.

## Where things live

- \`lyt-overview.md\` — this vault's identity + its mesh context.
- \`.lyt/primers/\` — agent-priming digests; read them before deep exploration.
- \`notes/\` — your Figments (markdown notes) live here.

## Next steps

- Capture your first note with \`lyt capture\` (or just write markdown in \`notes/\`).
- Lyt only writes inside the regions it marks (frontmatter + managed blocks);
  your prose is never touched.

_(This is a scaffold seed. Replace it with your own first note, or delete it.)_
`;

// M1a fix — RICH_MESH_DIRECTIVE removed. The "this vault defines the mesh"
// signal is no longer seeded as stored prose into the derived mesh-context.md
// (that write was erased on the first regenMeshContextFromYon pass). It is now
// DERIVED structurally in scaffold/mesh-context.ts (isMeshDefiner: mesh.yon
// main_vault_rid === this vault's rid), so it is durable by construction.

// ---------------------------------------------------------------------------
// The payload-definition object — the SINGLE source the init branch SELECTS by
// tier. B-1's contract can later supply this same shape.
// ---------------------------------------------------------------------------

export interface TierPayload {
  tier: ScaffoldTier;
  /** Whether this tier writes the mesh-defining properties (rich only). */
  writesMeshProps: boolean;
  /** The seed Figments this tier writes under the vault tree. */
  seedFigments: readonly SeedFigmentSpec[];
}

const RICH_PAYLOAD: TierPayload = {
  tier: "rich",
  writesMeshProps: true,
  seedFigments: [
    {
      relativePath: "notes/welcome.md",
      title: "Welcome to this mesh",
      purpose: "Mesh main-vault welcome (scaffold seed)",
      body: RICH_WELCOME_BODY,
    },
  ],
};

const MINI_PAYLOAD: TierPayload = {
  tier: "mini",
  writesMeshProps: false,
  seedFigments: [
    {
      relativePath: "notes/welcome.md",
      title: "Welcome to this vault",
      purpose: "Member-vault welcome (scaffold seed)",
      body: MINI_WELCOME_BODY,
    },
  ],
};

/** Tier → payload definition. The init branch reads from HERE; never inlines copy. */
export const TIER_PAYLOADS: Record<ScaffoldTier, TierPayload> = {
  rich: RICH_PAYLOAD,
  mini: MINI_PAYLOAD,
};

/** Convenience: resolve the payload for a vault name in one call. */
export function payloadForVault(vaultName: string): TierPayload {
  return TIER_PAYLOADS[resolveScaffoldTier(vaultName)];
}
