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

// Increment 1 · Phase A.1 — the git-error FIREWALL (narration core).
//
// The adoption-killer-#1 antidote: a raw git/gh failure must NEVER reach the
// human (charter's non-technical contract — no git noun, gh noun, rebase,
// detached HEAD, conflict marker, or stack trace). `narrate(raw)` maps any such
// failure to a NarratedError { category, plain, nextAction } — a plain-sense
// message + a safe next step naming only Lyt's OWN verbs (`lyt sync`/`doctor`/…),
// never git internals.
//
// GENERAL BOUNDARY-NARRATOR by design (angles finding): git is the first
// producer, but the shape (category + plain + nextAction) is reused by Phase-C
// leak-scan / [lyt.untrusted] so every safety-layer boundary speaks one handler
// voice. Lives in util/ (not op/) so the 4 lyt-vault spawn wrappers can call it
// without an op→util cycle.
//
// Coverage (SC-A3): 2 of the 5 named failure cases REUSE existing classifiers —
// `isPermissionDeniedPush` (auth/push-perm) + `inspectGhError` (404/gh-absent).
// The other 3 — rebase-conflict, detached-HEAD, dirty-tree — are NET-NEW stderr
// classifiers here.

import { isPermissionDeniedPush } from "./push-classify.js";
import { inspectGhError } from "./gh-federation.js";

/** Boundary-failure category. Extensible — Phase-C safety producers add their own. */
export type BoundaryCategory =
  | "auth"
  | "push-rejected"
  | "rebase-conflict"
  | "detached-head"
  | "dirty-tree"
  | "not-found"
  | "access-removed"
  | "tool-missing"
  | "unknown";

/** A boundary failure re-narrated for a non-technical handler. Never carries a raw noun. */
export interface NarratedError {
  category: BoundaryCategory;
  /** Plain-sense description — no git/gh internals (rebase/HEAD/refspec/fatal:/…). */
  plain: string;
  /** A safe next step, naming only Lyt's own verbs (or a plain install instruction). */
  nextAction: string;
}

// Pull a searchable string out of whatever the spawn wrappers threw — an Error
// (message [+ a `.stderr` property some wrappers attach]), a raw string, or an
// object with a stderr field. Never throws; unknown shapes → "".
function extractText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof Error) {
    const withStderr = raw as Error & { stderr?: unknown };
    const stderr = typeof withStderr.stderr === "string" ? withStderr.stderr : "";
    return `${raw.message}\n${stderr}`;
  }
  if (raw !== null && typeof raw === "object") {
    const o = raw as { stderr?: unknown; message?: unknown };
    const parts = [o.message, o.stderr].filter((p): p is string => typeof p === "string");
    if (parts.length > 0) return parts.join("\n");
  }
  return "";
}

// The net-new classifiers (the 3 the existing utils don't cover). Patterns match
// git's own English stderr; kept deliberately broad — a false-positive narration
// is a strictly better failure than a raw leak.
const RE_REBASE_CONFLICT =
  /CONFLICT|Merge conflict|needs merge|fix conflicts|could not apply|unmerged path|Automatic merge failed/i;
const RE_DETACHED_HEAD = /detached HEAD|HEAD detached|not currently on any branch|not on any branch/i;
const RE_DIRTY_TREE =
  /would be overwritten|uncommitted changes|Please commit your changes|Your local changes|changes not staged|Please, commit your changes or stash them/i;
const RE_PUSH_REJECTED =
  /\[rejected\]|non-fast-forward|failed to push|Updates were rejected|tip of your current branch is behind/i;

// `access-removed` is produced by the dedicated `narrateAccessRemoved()` (A6),
// NOT via this default-chain table — excluded here alongside `unknown`.
const NARRATION: Record<Exclude<BoundaryCategory, "unknown" | "access-removed">, NarratedError> = {
  auth: {
    category: "auth",
    plain: "Lyt couldn't save to your online copy — your access wasn't accepted (it may have expired).",
    nextAction: "Reconnect your account, then try again.",
  },
  "push-rejected": {
    category: "push-rejected",
    plain: "Your online copy has newer changes, so your save didn't go through.",
    nextAction: "Run `lyt sync` to bring in the latest, then save again.",
  },
  "rebase-conflict": {
    category: "rebase-conflict",
    plain: "You and your online copy changed the same place in a note.",
    nextAction: "Run `lyt sync` and choose which version to keep.",
  },
  "detached-head": {
    category: "detached-head",
    plain: "Your vault is in an unusual state and isn't tracking your latest work.",
    nextAction: "Run `lyt doctor` to check it, or `lyt repair` to fix it.",
  },
  "dirty-tree": {
    category: "dirty-tree",
    // nextAction routes to `lyt sync` (which auto-commits a dirty tree before it
    // pulls) — NOT `lyt capture`, which only writes a NEW note and would leave
    // the existing dirty files unsaved, looping the handler back here.
    plain: "You have unsaved changes that this action would overwrite.",
    nextAction: "Run `lyt sync` to save your changes first, then try again.",
  },
  "not-found": {
    category: "not-found",
    plain: "Lyt couldn't find that online copy.",
    nextAction: "Check the name, or set it up with `lyt init`.",
  },
  "tool-missing": {
    category: "tool-missing",
    // Generic across BOTH tools: git-run routes a missing `git` here and the gh
    // wrappers route a missing `gh` here — naming one tool would mis-instruct the
    // other (a missing-git handler told to install the GitHub CLI is a dead end).
    plain: "A tool Lyt needs (Git or the GitHub CLI) isn't set up on this machine.",
    nextAction: "Run `lyt doctor` to see what's missing, then install it and retry.",
  },
};

// ─── A6 share-revoke access-loss (0.12.0 Phase D) ────────────────────────────
// A revoked private-repo access (or a deleted repo) surfaces as `remote:
// Repository not found` / HTTP 404 / "could not resolve to a Repository" on git
// fetch/pull or a gh probe. That is a DISTINCT failure from a transient OFFLINE
// error (`could not resolve host`, connection timeout) — mis-classifying offline
// as access-loss would wrongly flip a reachable vault to access_lost. So
// `isAccessRemoved` matches the not-found / 404 signals but explicitly EXCLUDES
// the offline signals first.
//
// This helper lives in the firewall (same class as A1) but is deliberately NOT
// wired into `narrate()`'s default chain: the generic `not-found` narration
// ("Lyt couldn't find that online copy") stays for a first-time bad-name case,
// while the access-loss surfaces (sync / sync --check / vault info) call
// `isAccessRemoved` + `narrateAccessRemoved` to produce the sharper "your access
// was removed" message AND flip the vault status.
const RE_OFFLINE =
  /could not resolve host|couldn'?t resolve host|network is unreachable|temporary failure in name resolution|connection timed out|connection refused|operation timed out|failed to connect/i;
const RE_ACCESS_REMOVED =
  /remote: Repository not found|Repository not found|remote: Not Found|\bHTTP 404\b|could not resolve to a Repository|the requested URL returned error: 404/i;

/**
 * True when a raw git/gh failure proves our ACCESS to the online copy is gone
 * (revoked collaborator access, or the repo was deleted) — a `Repository not
 * found` / 404 signal. Fail-safe: an OFFLINE failure (host unreachable, timeout)
 * returns false so a merely-disconnected machine is never mistaken for access
 * loss. Never throws; unknown shapes → false.
 *
 * A6-1 (0.12.0 Phase D fix-pass) — a `Repository not found` / 404 is ALSO what
 * GitHub returns for a private repo that EXISTS but the caller isn't authorized
 * to see: logged-out HTTPS creds, an expired-or-underscoped `gh` token, or an
 * SSO-not-authorized session. That is a FIXABLE auth state, NOT a revoke —
 * flipping a vault to `access_lost` on it is a false positive. So the caller may
 * pass the CURRENT gh-auth verdict via `opts.ghAuthOk`; when it is anything other
 * than a confirmed `true` (false = unauthed, null = unverifiable), a not-found is
 * NOT classified as access-removed (the conservative call: let the caller treat
 * it as `unknown`/transient, never `access_lost`). When `opts.ghAuthOk` is
 * omitted, the pre-A6-1 text-only behaviour is preserved (pure-classifier callers
 * and unit tests that don't supply an auth verdict are unaffected).
 */
export function isAccessRemoved(
  raw: unknown,
  opts: { ghAuthOk?: boolean | null } = {},
): boolean {
  const text = extractText(raw);
  if (text.length === 0) return false;
  if (RE_OFFLINE.test(text)) return false;
  if (!RE_ACCESS_REMOVED.test(text)) return false;
  // A6-1: a not-found under absent/expired/unverifiable auth is a fixable auth
  // state, not a revoke. Only an EXPLICIT non-true verdict downgrades it — an
  // omitted verdict keeps the text-only classification (back-compat).
  if (opts.ghAuthOk !== undefined && opts.ghAuthOk !== true) return false;
  return true;
}

/** The plain, jargon-free "your access was removed" narration (A6). */
export function narrateAccessRemoved(): NarratedError {
  return {
    category: "access-removed",
    plain:
      "Your access to this shared vault was removed, so Lyt can't reach it online anymore. Your local copy is safe.",
    nextAction: "Ask the owner to share it with you again, or remove it with `lyt vault forget`.",
  };
}

/**
 * Re-narrate a raw git/gh failure into a NarratedError. Never throws, never
 * leaks a raw git/gh noun. `ctx.op` (e.g. "save your notes") personalises the
 * unknown-fallback. Classification is most-specific-first; the unknown fallback
 * guarantees SOMETHING plain is always returned rather than the raw error.
 */
export function narrate(raw: unknown, ctx: { op?: string } = {}): NarratedError {
  const text = extractText(raw);
  // A spawn ENOENT is the most reliable missing-binary signal — read it off the
  // error DIRECTLY (extractText omits `.code`). This must run BEFORE the 404
  // check: the wrappers' own message is "`git` not found on PATH", whose bare
  // "not found" would otherwise fall into not-found and mis-instruct the handler.
  const code =
    raw !== null && typeof raw === "object" ? (raw as { code?: unknown }).code : undefined;

  // 1. auth / permission (reused classifier — covers auth-expired + terminal push-perm)
  if (isPermissionDeniedPush(text)) return NARRATION.auth;

  // 2. tool missing / 404 (reused classifier — gh binary absent or repo not found)
  const gh = inspectGhError(raw);
  if (
    code === "ENOENT" ||
    /ENOENT|not installed|not (?:on|found on) PATH|command not found/i.test(text)
  ) {
    return NARRATION["tool-missing"];
  }
  if (gh.is404 || /\b404\b|repository .* not found|could not resolve host|not found/i.test(text)) {
    return NARRATION["not-found"];
  }

  // 3-5. NET-NEW classifiers
  if (RE_REBASE_CONFLICT.test(text)) return NARRATION["rebase-conflict"];
  if (RE_DETACHED_HEAD.test(text)) return NARRATION["detached-head"];
  if (RE_DIRTY_TREE.test(text)) return NARRATION["dirty-tree"];
  if (RE_PUSH_REJECTED.test(text)) return NARRATION["push-rejected"];

  // fallback — never leak the raw text
  return {
    category: "unknown",
    plain: `Something went wrong${ctx.op ? ` while trying to ${ctx.op}` : ""}.`,
    nextAction: "Run `lyt doctor` to check things, then try again.",
  };
}

// ─── Wrapper decoration (A.1) ────────────────────────────────────────────────
// The 4 lyt-vault spawn wrappers route their thrown failures through `firewall()`
// so every git/gh error ESCAPING the spawn boundary carries a pre-computed
// narration. Crucially, `firewall()` ATTACHES `.narrated` to the caught error
// WITHOUT altering `.message`/`.stderr`/`.code`/`.status` — internal classifiers
// that parse the raw text (gh-discover's 404 detection, `inspectGhError`) keep
// working, while the render boundary (Operation / CLI, A.2+) reads `.narrated`
// to show the handler plain sense. This is the "failure/return boundary only"
// decoration the plan mandates: the `.cmd`-quoting / argv-verbatim invocation
// path is never touched, and `allowFailure` raw-passthrough is untouched (a
// wrapper that returns instead of throwing is never narrated).

/**
 * An Error decorated with a pre-computed narration. `.message` (and `.stderr` /
 * `.code` / `.status` when present) stay RAW for internal classifiers; renderers
 * read `.narrated`.
 */
export interface FirewalledError extends Error {
  narrated: NarratedError;
}

/** Has this value already been through the firewall? (guards double-wrapping.) */
export function isFirewalled(e: unknown): e is FirewalledError {
  return (
    e instanceof Error &&
    (e as { narrated?: unknown }).narrated !== null &&
    typeof (e as { narrated?: unknown }).narrated === "object"
  );
}

/**
 * Decorate a raw git/gh failure with its narration and return it to be thrown.
 * - An Error is MUTATED in place (narration attached; message/stderr/code/stack
 *   preserved) so internal raw-text classifiers keep working.
 * - A non-Error (string / plain object) is wrapped in a fresh Error whose
 *   `.message` carries the raw text (never lost).
 * - Idempotent: an already-firewalled error is returned unchanged, so a lower
 *   wrapper's narration is never overwritten by an outer one.
 * Never throws.
 */
export function firewall(raw: unknown, ctx: { op?: string } = {}): FirewalledError {
  if (isFirewalled(raw)) return raw;
  const narrated = narrate(raw, ctx);
  if (raw instanceof Error) {
    try {
      (raw as Error & { narrated?: NarratedError }).narrated = narrated;
      return raw as FirewalledError;
    } catch {
      // A frozen/sealed Error can't take the property — honor "never throws" by
      // falling through to a fresh wrapper that carries the raw message + narration.
    }
  }
  const err = new Error(
    raw instanceof Error ? raw.message : typeof raw === "string" ? raw : extractText(raw),
  ) as FirewalledError;
  err.name = "FirewalledError";
  err.narrated = narrated;
  return err;
}
