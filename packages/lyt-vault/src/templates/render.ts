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

// Phase B (UNIT 2) — typed, closed, fail-fast template renderer.
//
// The scaffold BODY text lives in `packages/lyt-vault/templates/*.md`; this
// module is the ONLY loader that turns those files into rendered strings. It is
// deliberately tiny and strict — there is no template DIALECT here, no logic, no
// loops, no conditionals. A template is plain markdown with a fixed, named
// placeholder syntax; render() substitutes the declared variables and FAILS
// FAST on any drift between the template's placeholders and the supplied vars.
//
// FRONTMATTER IS NOT RENDERED HERE. Frontmatter always flows through the single
// SoT (contract.ts buildFrontmatter). render() handles the markdown body only;
// callers prepend the frontmatter block. This keeps the schema in exactly one
// place and keeps the template files free of frontmatter to drift.
//
// ── PLACEHOLDER SYNTAX ──────────────────────────────────────────────────────
//   ${name}        — substituted with vars[name]. `name` matches [A-Za-z0-9_].
//   $${            — escape: emits a literal `${` (the only escape). Use this
//                    when seed CONTENT must contain a literal `${` (e.g. a
//                    code example showing a shell/JS template literal).
//
// ── ESCAPING POLICY ─────────────────────────────────────────────────────────
//   • `${name}` is the ONLY interpolation form. There is NO `{{ }}` dialect —
//     a literal `{{` or `}}` in a template is a HARD ERROR (assertNoBraceDialect)
//     so a wrong-dialect placeholder can never silently ship un-substituted.
//   • To emit a literal `${` in seed content, write `$${`. After all real
//     `${name}` substitutions run, every remaining `$${` collapses to `${`.
//   • A bare `$` not followed by `{` is literal and passes through untouched.
//   • An unterminated `${` (no closing `}`) is a HARD ERROR.
//
// ── FAIL-FAST CONTRACT ──────────────────────────────────────────────────────
//   render(file, template, vars) throws RenderError when:
//     (a) the template references `${name}` and `name` is NOT a key of `vars`
//         (unknown / undeclared placeholder),
//     (b) a key of `vars` is declared but NEVER used by the template
//         (dead variable — catches manifest drift),
//     (c) the template contains a `{{`/`}}` brace-dialect token,
//     (d) the template contains an unterminated `${`,
//     (e) the rendered output STILL contains an un-substituted `${...}`.
//   (e) is the belt-and-suspenders guard: a literal `${}` / `{{}}` must NEVER
//   reach disk. Every throw names the template file so a scaffold/build-time
//   failure is immediately diagnosable.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderError";
  }
}

/** Variables supplied to a template render. All values are strings. */
export type RenderVars = Record<string, string>;

// A `${name}` reference. `name` is a conservative identifier set so a stray
// `${` in prose (already escaped to `$${` by policy) can't be misread.
const PLACEHOLDER_RE = /\$\{([A-Za-z0-9_]+)\}/g;
// Sentinel for the `$${` escape — replaced AFTER all real substitutions so an
// escaped literal can never be re-scanned as a placeholder.
const ESCAPE_SENTINEL = "\u0000LYT_DOLLAR_BRACE\u0000";

/** Guard: no `{{`/`}}` brace-dialect tokens may appear in a Lyt template. */
function assertNoBraceDialect(file: string, template: string): void {
  if (template.includes("{{") || template.includes("}}")) {
    throw new RenderError(
      `template "${file}" contains a {{ }} brace-dialect token — Lyt templates use ` +
        `\${name} only (no {{ }}). If a literal brace is intended, it is still rejected ` +
        `to prevent a wrong-dialect placeholder shipping un-substituted.`,
    );
  }
}

/** Guard: every `${` must be a well-formed `${name}` or the `$${` escape. */
function assertNoUnterminated(file: string, template: string): void {
  // Strip escapes + valid placeholders, then any remaining `${` is malformed.
  const stripped = template
    .split("$${").join("") // remove escape openers
    .replace(PLACEHOLDER_RE, "");
  const idx = stripped.indexOf("${");
  if (idx >= 0) {
    throw new RenderError(
      `template "${file}" contains an unterminated or malformed \${ ... } placeholder ` +
        `(near index ${idx}). Use \${name} with name matching [A-Za-z0-9_], or $${"{"} ` +
        `to emit a literal \${.`,
    );
  }
}

/**
 * Render a template body with the supplied variables.
 *
 * @param file  display name of the template (for error messages), e.g. "agents.md".
 * @param template  the raw template text.
 * @param vars  the EXACT set of variables the template may use. Extra (unused)
 *              vars and missing (referenced-but-absent) vars both throw.
 */
export function render(file: string, template: string, vars: RenderVars): string {
  assertNoBraceDialect(file, template);
  assertNoUnterminated(file, template);

  // Protect the `$${` escape so it is not treated as a placeholder.
  const protectedTemplate = template.split("$${").join(ESCAPE_SENTINEL + "{");

  const used = new Set<string>();
  const out = protectedTemplate.replace(PLACEHOLDER_RE, (_m, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      throw new RenderError(
        `template "${file}" references unknown placeholder \${${name}} — not in the ` +
          `declared variable manifest [${Object.keys(vars).join(", ") || "<empty>"}].`,
      );
    }
    used.add(name);
    return vars[name]!;
  });

  // Dead-variable check: every declared var must be used (catches manifest drift).
  for (const key of Object.keys(vars)) {
    if (!used.has(key)) {
      throw new RenderError(
        `template "${file}" was given an unused variable "${key}" — the declared ` +
          `manifest must match the placeholders the template actually uses.`,
      );
    }
  }

  // Belt-and-suspenders: no un-substituted placeholder may reach disk. Run this
  // BEFORE collapsing the `$${` escape — at this point a genuine un-substituted
  // placeholder is still `${name}` (caught), while an INTENDED literal is still
  // in its protected sentinel form (ESCAPE_SENTINEL + "{"), so it is not a false
  // positive. Collapsing first would mis-flag a legitimately-escaped literal.
  if (/\$\{[A-Za-z0-9_]+\}/.test(out)) {
    throw new RenderError(
      `template "${file}" still contains an un-substituted \${...} after render — refusing ` +
        `to emit a literal placeholder.`,
    );
  }

  // Collapse the protected escape back to a literal `${`.
  return out.split(ESCAPE_SENTINEL + "{").join("${");
}

// ---------------------------------------------------------------------------
// Template resolution — load a `.md` from the shipped `templates/` directory.
//
// The directory resolves relative to THIS module's compiled location. Both the
// src/ (vitest) and dist/ (built/installed) layouts place the module at
// `<pkg>/{src|dist}/templates/render.{ts|js}`, and the template files ship at
// `<pkg>/templates/*.md` — i.e. two levels up from this module's dir. UNIT 3
// (dist parity) ensures the `templates/*.md` files are present in the tarball
// AND copied next to dist/, asserted by smoke-built-dist.mjs.
// ---------------------------------------------------------------------------
function templatesDir(): string {
  // import.meta.url → .../{src|dist}/templates/render.{ts|js}
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <pkg>/{src|dist}/templates  →  <pkg>/templates
  return join(here, "..", "..", "templates");
}

const templateCache = new Map<string, string>();

/** Load a template `.md` by basename (e.g. "agents.md") from the shipped dir. */
export function loadTemplate(file: string): string {
  const cached = templateCache.get(file);
  if (cached !== undefined) return cached;
  const abs = join(templatesDir(), file);
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    throw new RenderError(
      `template "${file}" not found at ${abs} — the templates/ directory must ship ` +
        `alongside the package (see package.json "files" + the dist copy step).`,
    );
  }
  templateCache.set(file, raw);
  return raw;
}

/** Convenience: load `file` then render it with `vars`. */
export function renderTemplate(file: string, vars: RenderVars): string {
  return render(file, loadTemplate(file), vars);
}
