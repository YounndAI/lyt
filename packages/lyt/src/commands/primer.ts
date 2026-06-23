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

// v1.D.4 — `lyt primer` top-level meta-CLI verb (default).
//
// Second CONSUMER verb of Lane D (mirrors v1.D.3 `lyt search` posture).
// Composes a deterministic agent-priming markdown file from the
// already-shipped per-vault caches (lanes.db + arcs.db + provenance.db)
// into <vault>/.lyt/primers/{scope}-primer.md.
//
// Lives at meta-CLI level — placing under `vault` would tilt user
// mental model toward single-vault use; the verb operates at
// vault/mesh/federation scope. Mirrors how `lyt search` is wired.
//
// Error contract (default):
// missing --target on scope=vault/mesh → exit 1 + structured JSON
// unknown vault / mesh → exit 1 + structured JSON
// invalid --top-keywords / --top-arcs / → exit 1 + structured JSON
// --provenance-days
// underlying flow throws → exit 2 + structured JSON

import { Command } from "commander";

import {
  generatePrimerFlow,
  withSpinner,
  type PrimerGenerateArgs,
  type PrimerGenerateResult,
  type PrimerScope,
} from "@younndai/lyt-vault";

interface PrimerCliOpts {
  scope?: string;
  target?: string;
  topKeywords?: string;
  topArcs?: string;
  provenanceDays?: string;
  dryRun?: boolean;
  json?: boolean;
  nowIso?: string;
}

const VALID_SCOPES: ReadonlySet<PrimerScope> = new Set(["vault", "mesh", "federation"]);

export function buildPrimerCommand(): Command {
  return new Command("primer")
    .description(
      "Generate an agent-priming markdown file by aggregating top keywords (frequency × recency), active arcs, recent provenance entries, and top lanes across the selected scope. Writes to <vault>/.lyt/primers/{scope}-primer.md (atomic). Query-less aggregation — distinct from `lyt search` (query-driven).",
    )
    .requiredOption("--scope <scope>", "Aggregation scope: vault | mesh | federation")
    .option(
      "--target <name>",
      "Target name (required for scope=vault | mesh; ignored for scope=federation)",
    )
    .option("--top-keywords <n>", "Top-N keywords to surface (default 20)")
    .option("--top-arcs <n>", "Top-N arcs + top-N lanes to surface (default 10; shared cap)")
    .option(
      "--provenance-days <n>",
      "Days of provenance history to include in Recent activity (default 7)",
    )
    .option("--dry-run", "Render markdown to stdout WITHOUT writing the primer file")
    .option("--json", "Emit deterministic JSON (includes full markdown payload)")
    .option("--now-iso <iso>", "Pin the 'now' timestamp for deterministic testing (ISO 8601)")
    .action(async (opts: PrimerCliOpts) => {
      const scopeRaw = String(opts.scope ?? "");
      if (!VALID_SCOPES.has(scopeRaw as PrimerScope)) {
        emitError(opts.json === true, {
          error: "invalid-scope",
          value: scopeRaw,
          message: `--scope must be one of: vault, mesh, federation (got: ${JSON.stringify(scopeRaw)}).`,
        });
        process.exitCode = 1;
        return;
      }
      const scope = scopeRaw as PrimerScope;

      if ((scope === "vault" || scope === "mesh") && opts.target === undefined) {
        emitError(opts.json === true, {
          error: "missing-target",
          scope,
          message: `--target <name> is required for --scope ${scope}.`,
        });
        process.exitCode = 1;
        return;
      }

      const topKeywords = parsePositiveInt(opts.topKeywords, "top-keywords");
      if (topKeywords.error !== null) {
        emitError(opts.json === true, topKeywords.error);
        process.exitCode = 1;
        return;
      }
      const topArcs = parsePositiveInt(opts.topArcs, "top-arcs");
      if (topArcs.error !== null) {
        emitError(opts.json === true, topArcs.error);
        process.exitCode = 1;
        return;
      }
      const provenanceDays = parsePositiveInt(opts.provenanceDays, "provenance-days");
      if (provenanceDays.error !== null) {
        emitError(opts.json === true, provenanceDays.error);
        process.exitCode = 1;
        return;
      }

      const args: PrimerGenerateArgs = {
        scope,
        ...(opts.target !== undefined ? { scopeTarget: opts.target } : {}),
        ...(topKeywords.value !== null ? { topKeywords: topKeywords.value } : {}),
        ...(topArcs.value !== null ? { topArcs: topArcs.value } : {}),
        ...(provenanceDays.value !== null ? { provenanceDays: provenanceDays.value } : {}),
        ...(opts.dryRun === true ? { dryRun: true } : {}),
        ...(opts.nowIso !== undefined ? { nowIso: opts.nowIso } : {}),
      };

      try {
        // V-DX-1 — liveness spinner over the silent aggregate window. Gated
        // off for BOTH --json AND --dry-run: dry-run renders pipeable markdown
        // to stdout ("pipeable into other tools"), so a spinner byte would
        // pollute it. Non-TTY otherwise prints "Priming…" once (zero escapes).
        const useSpinner = opts.json !== true && opts.dryRun !== true;
        const res: PrimerGenerateResult = useSpinner
          ? await withSpinner(
              scope === "federation" ? "federation" : (opts.target ?? scope),
              () => generatePrimerFlow(args),
              { op: "primer" },
            )
          : await generatePrimerFlow(args);
        if (opts.json === true) {
          emitJsonResult(res);
        } else if (opts.dryRun === true) {
          // Human dry-run: print the rendered markdown verbatim per the ratified default
          // default (full markdown to stdout; pipeable into other tools).
          // eslint-disable-next-line no-console
          console.log(res.markdown);
        } else {
          emitHumanResult(res);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emitError(opts.json === true, {
          error: "primer-generate-error",
          message,
        });
        process.exitCode = 2;
      }
    });
}

interface ParsedInt {
  value: number | null;
  error: Record<string, unknown> | null;
}

function parsePositiveInt(raw: string | undefined, name: string): ParsedInt {
  if (raw === undefined) return { value: null, error: null };
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return {
      value: null,
      error: {
        error: `invalid-${name}`,
        value: raw,
        message: `--${name} must be a positive integer (got: ${JSON.stringify(raw)}).`,
      },
    };
  }
  return { value: parsed, error: null };
}

function emitJsonResult(res: PrimerGenerateResult): void {
  // Stable-key-ordered output per Lock 0.3.
  const stable = {
    scope: res.scope,
    scopeTarget: res.scopeTarget,
    primerPath: res.primerPath,
    dryRun: res.dryRun,
    vaultsScanned: res.vaultsScanned,
    topKeywords: res.topKeywords.map((k) => ({
      keyword: k.keyword,
      score: k.score,
      totalMemCount: k.totalMemCount,
      lastSeen: k.lastSeen,
    })),
    topArcs: res.topArcs.map((a) => ({
      name: a.name,
      category: a.category,
      lastTouched: a.lastTouched,
      vaultName: a.vaultName,
      memberCount: a.memberCount,
    })),
    recentActivity: res.recentActivity.map((r) => ({
      ts: r.ts,
      tsIso: r.tsIso,
      targetType: r.targetType,
      targetId: r.targetId,
      src: r.src,
      vaultName: r.vaultName,
      idHex: r.idHex,
    })),
    topLanes: res.topLanes.map((l) => ({
      name: l.name,
      keywords: l.keywords,
      memCount: l.memCount,
      vaultName: l.vaultName,
    })),
    markdown: res.markdown,
    durationMs: res.durationMs,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(stable, null, 2));
}

function emitHumanResult(res: PrimerGenerateResult): void {
  // eslint-disable-next-line no-console
  console.log(
    `Primer written to ${res.primerPath} (${res.topKeywords.length} keywords, ${res.topArcs.length} arcs, ${res.recentActivity.length} recent activity entries, ${res.topLanes.length} lanes; ${res.durationMs}ms).`,
  );
}

function emitError(json: boolean, body: Record<string, unknown>): void {
  if (json) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(body, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.error(`lyt primer: ${String(body["message"] ?? body["error"])}`);
  }
}
