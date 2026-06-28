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

// Built-artifact (dist) smoke — the gate coverage source-tests provably cannot
// provide (LYT). vitest imports from `src` via vite-transform and NEVER
// from `dist`, so a green test suite can sit on top of a stale/wrong built
// artifact (root-caused in turbo restores `dist/**` from cache on an
// input-hash HIT, stamping fresh mtimes onto stale content; and the turbo
// `test` task is `dependsOn: ["^build"]` — upstream only — so the package's own
// dist is never built or exercised by the test gate). This smoke runs the
// COMPILED flows from ../dist against a throwaway fixture vault and asserts the
// B-4 figment-roots contract on real built code: a figment under a SEMANTIC
// folder (identity/, NOT notes/) must be searchable. A pre-B-4 / stale dist
// indexes only notes/ → 0 hits → this exits non-zero.
//
// Deliberately deep-imports ../dist/flows/*.js (the built output), never ../src.
// Run: `npm run smoke:dist` (wired into prepack so a clean-built-but-broken dist
// cannot pack/publish).

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { initVaultFlow } from "../dist/flows/init.js";
import { rebuildVaultFlow } from "../dist/flows/rebuild-vault.js";
import { searchCascadeFlow } from "../dist/flows/search-cascade.js";
// UNIT 3 (dist parity) — deep-import the BUILT render loader. This is the
// dist-parity hazard the smoke exists for: the scaffold bodies now live in
// `templates/*.md` (shipped via the package.json "files" glob), and render.ts
// resolves them relative to its OWN compiled location (dist/templates/render.js
// → <pkg>/templates). If the templates/ dir does not ship in the tarball, this
// import path renders fine in the dev tree but THROWS RenderError("template not
// found") from an installed package. Asserting render from ../dist proves the
// templates resolve from the built/packable layout, not just from src/.
import { loadTemplate, renderTemplate } from "../dist/templates/render.js";
// Canonical on-disk write paths for the agent-priming seeds. Phase D relocated
// agents.md / lyt-overview.md from the vault ROOT into `.lyt/`; importing the
// constants (instead of hardcoding "agents.md") keeps this gate from drifting
// out of sync with the scaffold the way the legacy-root literals below did.
import {
  AGENTS_MD_REL_WRITE_PATH,
  LYT_OVERVIEW_REL_WRITE_PATH,
} from "../dist/util/agent-file-paths.js";

const TOKEN = "zqxsmoketoken4291"; // distinctive — no collision with scaffold figments
const SEMANTIC_REL = "identity/identity.md"; // a B-4 semantic folder, NOT notes/

function writeNote(vaultPath, rel, frontmatter, body) {
  const full = join(vaultPath, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `---\n${frontmatter}\n---\n${body}\n`, "utf8");
}

async function main() {
  const tmpRoot = mkdtempSync(join(tmpdir(), "lyt-smoke-dist-"));
  const prevHome = process.env["LYT_HOME"];
  process.env["LYT_HOME"] = join(tmpRoot, "lyt-home");

  try {
    // ── UNIT 3: template dist-parity gate ──────────────────────────────────
    // (a) every shipped template resolves + renders from the BUILT loader.
    const SCAFFOLD_TEMPLATES = [
      ["README.md", { vaultName: "smoke" }],
      ["lyt-overview.md", { vaultName: "smoke", descBlock: "_demo_", owner: "smoke-owner" }],
      ["agents.md", { vaultName: "smoke", version: "3", primerBlock: "p", patternsBlock: "q" }],
      ["notes-index.md", { vaultName: "smoke" }],
    ];
    for (const [file, vars] of SCAFFOLD_TEMPLATES) {
      let out;
      try {
        // loadTemplate throws if the templates/ dir didn't ship next to dist.
        loadTemplate(file);
        out = renderTemplate(file, vars);
      } catch (err) {
        console.error(
          `[smoke:dist] FAIL — template "${file}" did not resolve/render from the BUILT package.\n` +
            `  ${err?.message ?? err}\n` +
            `  This is the dist-parity signature: templates/*.md must ship via the package.json\n` +
            `  "files" glob so render.ts (dist/templates/render.js → <pkg>/templates) finds them.`,
        );
        return 1;
      }
      if (typeof out !== "string" || out.length === 0 || /\$\{[A-Za-z0-9_]+\}/.test(out)) {
        console.error(
          `[smoke:dist] FAIL — template "${file}" rendered empty or left an un-substituted placeholder.`,
        );
        return 1;
      }
    }

    const init = await initVaultFlow({
      name: "smoke",
      gitInit: false,
      commitInitial: false,
      selfHeal: { federation: { enabled: false } },
    });

    // (b) the scaffold writers (which call render under the hood) actually
    // emitted the template-backed seed files with the lyt-scaffold sentinel.
    // Phase C (M3 fix): notes/welcome.md (the rich/mini tier seed Figment) is
    // included — so a future drop of `lytScaffold:true` from renderSeedFigment
    // (which would re-admit welcome.md into FTS and break lyt-mesh's
    // 1 + SCAFFOLD_FIGMENT_COUNT invariant) is caught by this gate.
    // agents.md / lyt-overview.md write under `.lyt/` (Phase D); notes/welcome.md
    // stays at notes/. All three still carry the lyt-scaffold:true sentinel.
    for (const seed of [AGENTS_MD_REL_WRITE_PATH, LYT_OVERVIEW_REL_WRITE_PATH, "notes/welcome.md"]) {
      const seedPath = join(init.vaultPath, seed);
      if (!existsSync(seedPath)) {
        console.error(`[smoke:dist] FAIL — scaffold did not write ${seed} from the built templates.`);
        return 1;
      }
      const content = readFileSync(seedPath, "utf8");
      // Sentinel must live inside the LEADING frontmatter block (between the
      // first `---` fence and its close), not anywhere in the body.
      const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fmMatch === null || !/^lyt-scaffold:\s*true\s*$/m.test(fmMatch[1] ?? "")) {
        console.error(
          `[smoke:dist] FAIL — built scaffold ${seed} is missing the lyt-scaffold:true frontmatter sentinel.`,
        );
        return 1;
      }
    }

    // One figment under a SEMANTIC folder — the exact content class B-4 made
    // searchable and a stale/pre-B-4 dist (notes/-only walk) does NOT index.
    writeNote(
      init.vaultPath,
      SEMANTIC_REL,
      "title: Smoke Identity\npurpose: dist smoke\ntopic: smoke",
      `This identity figment carries the marker ${TOKEN} under a semantic folder.`,
    );

    const rebuilt = await rebuildVaultFlow({ vault: "smoke" });
    const ftsCount = rebuilt.fts?.figmentCount ?? rebuilt.fts?.count ?? null;

    const search = await searchCascadeFlow({ query: TOKEN, scope: "federation" });
    const hits = search.results ?? [];
    const semanticHit = hits.some((r) =>
      String(r.figment_path ?? "").replace(/\\/g, "/").endsWith(SEMANTIC_REL),
    );

    if (hits.length === 0 || !semanticHit) {
      console.error(
        `[smoke:dist] FAIL — built dist did not index the semantic-folder figment.\n` +
          `  query="${TOKEN}" hits=${hits.length} semanticHit=${semanticHit} fts.figmentCount=${ftsCount}\n` +
          `  This is the stale-dist signature: the test suite stays green (it tests src),\n` +
          `  but the BUILT dist is wrong. Run a clean build (npm run clean && npm run build) and retry.`,
      );
      return 1;
    }

    // NB: stderr, not stdout. This script runs in `prepack`, and the publish
    // precheck invokes `npm pack --dry-run --json` and JSON.parses stdout — any
    // stdout write here corrupts that JSON. All diagnostics (success included)
    // go to stderr so stdout stays reserved for npm's pack JSON.
    console.error(
      `[smoke:dist] OK — built dist indexes semantic-folder figments. ` +
        `query="${TOKEN}" hits=${hits.length} (figment_path=${SEMANTIC_REL}) fts.figmentCount=${ftsCount}`,
    );
    return 0;
  } finally {
    // temp-dir hygiene L0 — pair every scaffold with teardown. Best-effort +
    // SWALLOW: on Windows @libsql's native binding holds the registry.db lock
    // for several seconds after close, so deletion races EBUSY. Cleanup must
    // NEVER gate the verdict (the assertion above already decided it); a
    // leaked temp dir is reaped by the OS / global temp sweep. Mirrors the
    // repo's tests/_helpers/fs-retry.ts rmSyncRetry policy.
    if (prevHome === undefined) delete process.env["LYT_HOME"];
    else process.env["LYT_HOME"] = prevHome;
    try {
      rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // swallow — correctness already asserted; OS reaps the temp dir later.
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[smoke:dist] ERROR — ${err?.stack ?? err}`);
    process.exit(1);
  });
