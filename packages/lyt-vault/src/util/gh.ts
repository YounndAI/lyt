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

import { execFileSync } from "node:child_process";

import { firewall } from "./git-error-firewall.js";

export interface GhRepoInfo {
  description: string;
  topics: string[];
  isAdmin: boolean;
  // C3 (release review, vault-visibility) — the REAL GitHub visibility, read from
  // the same `/repos/{owner}/{repo}` payload that already carries description /
  // topics / permissions, so observing it costs no extra round trip (the
  // separate `gh repo view --json visibility` probe in gh-discover.ts stays for
  // the subscribe path, which has no repo payload in hand).
  //
  // OPTIONAL so pre-existing 3-field fakes stay source-compatible. A CONSUMER
  // THAT DECIDES ON VISIBILITY MUST TREAT `undefined` AS UNOBSERVED AND REFUSE —
  // never as "matches the local record". `internal` (enterprise) is a non-public
  // grant and maps to `private`, matching checkRepoVisibility.
  visibility?: GhRepoVisibility | undefined;
}

export interface GhClient {
  getRepo(owner: string, name: string): Promise<GhRepoInfo>;
  editRepo(
    owner: string,
    name: string,
    description: string,
    topics: readonly string[],
    // GAP #2 (github-defaults.ts) — the REVERSAL capability. Additive-only
    // `--add-topic` could never strip `lyt-public` off a de-published vault, so a
    // vault flipped back to private kept advertising itself as public forever.
    // OPTIONAL and defaulted-empty: every pre-existing caller (sync-metadata.ts)
    // and every 4-arg fake keeps its exact additive behaviour — the union-not-
    // clobber drift logic that depends on "editRepo never removes" is unchanged
    // for them. Only `lyt vault visibility --private` passes a non-empty set, and
    // only ever the publication marker itself.
    removeTopics?: readonly string[],
  ): Promise<void>;
  // The per-repo visibility writer. OPTIONAL so alternate clients / older fakes
  // stay source-compatible (mirrors FederationGhClient's optional probes); the
  // caller reports a skip when it is absent.
  setRepoVisibility?(owner: string, name: string, visibility: GhRepoVisibility): Promise<void>;
}

export type GhRepoVisibility = "private" | "public";

export const realGhClient: GhClient = {
  async getRepo(owner, name): Promise<GhRepoInfo> {
    let raw: string;
    try {
      raw = execFileSync("gh", ["api", `/repos/${owner}/${name}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      throw firewall(err, { op: "reach GitHub" });
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const description =
      typeof parsed["description"] === "string" ? (parsed["description"] as string) : "";
    const topics = Array.isArray(parsed["topics"]) ? (parsed["topics"] as string[]) : [];
    const permissions = (parsed["permissions"] as Record<string, unknown> | undefined) ?? {};
    const isAdmin = permissions["admin"] === true;
    const visibility = normalizeGhVisibility(parsed["visibility"], parsed["private"]);
    return { description, topics, isAdmin, ...(visibility === null ? {} : { visibility }) };
  },

  async editRepo(owner, name, description, topics, removeTopics): Promise<void> {
    // NOTE (Phase E release review): this WAS `--add-topic`-only — additive, never
    // removing. That is still the behaviour for every caller that omits
    // `removeTopics`, and the union-not-clobber drift logic (sync-metadata.ts)
    // depends on it. SHIPPED (gap #2): `--remove-topic` is now available so
    // `lyt vault visibility --private` can strip `lyt-public` when a vault is
    // de-published (see PUBLIC_VAULT_TOPICS in scaffold/github-defaults.ts).
    const args = ["repo", "edit", `${owner}/${name}`, "--description", description];
    for (const t of topics) {
      args.push("--add-topic", t);
    }
    for (const t of removeTopics ?? []) {
      args.push("--remove-topic", t);
    }
    try {
      execFileSync("gh", args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      throw firewall(err, { op: "reach GitHub" });
    }
  },

  async setRepoVisibility(owner, name, visibility): Promise<void> {
    ghSetRepoVisibility(owner, name, visibility);
  },
};

// `visibility` is `public` | `private` | `internal` on the REST payload; the
// older/leaner shape only carries the `private` boolean. `internal` is a
// non-public enterprise grant, so it maps to `private` (parity with
// gh-discover.ts checkRepoVisibility). Anything unrecognised is UNOBSERVED
// (`null`) — never guessed.
function normalizeGhVisibility(raw: unknown, isPrivate: unknown): GhRepoVisibility | null {
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (v === "public") return "public";
    if (v === "private" || v === "internal") return "private";
  }
  if (typeof isPrivate === "boolean") return isPrivate ? "private" : "public";
  return null;
}

// The single shell implementation of the repo-visibility flip, shared by
// `realGhClient` and `realFederationGhClient` (util/gh-federation.ts delegates
// here rather than re-implementing the gh invocation).
//
// GH FLAG COMPATIBILITY — measured on the installed gh 2.78.0 (2025-08-21):
// `gh repo edit --help` states verbatim "When the `--visibility` flag is used,
// `--accept-visibility-change-consequences` flag is required." Older gh builds
// predate that flag and reject it as an unknown flag. Rather than parse a
// version string (which drifts, and which a shimmed / vendored gh can misreport),
// this probes BEHAVIOURALLY: send the flag first — correct and required on every
// current gh — and retry once WITHOUT it only when gh itself says the flag is
// unknown. Any other failure is a real failure and is firewalled straight through.
export type GhArgvExec = (args: readonly string[]) => void;

// Final review (item 7) — stdout is PIPED, not ignored. `isUnknownFlagError`
// inspects `err.stdout` because some gh builds print the usage error there, but
// with stdout ignored `execFileSync` never populated that field, so the branch was
// dead in production while the injected-exec test made it look live. Piping both
// streams makes the retry contract real on those builds. gh's normal output for
// `repo edit` is a single confirmation line, so capturing it costs nothing.
// EXPORTED so the stdout branch above can be proved under the SHAPE production
// actually runs with, not only under an injected exec.
export const GH_EXEC_STDIO = ["ignore", "pipe", "pipe"] as const;

const defaultGhExec: GhArgvExec = (args) => {
  execFileSync("gh", [...args], { stdio: [...GH_EXEC_STDIO] });
};

export function ghSetRepoVisibility(
  owner: string,
  name: string,
  visibility: GhRepoVisibility,
  // Test seam (M3, release review) — the retry contract below is the only
  // behaviour in this file that BRANCHES on what gh printed, so it is the one
  // that has to be provable without a real gh on PATH.
  exec: GhArgvExec = defaultGhExec,
): void {
  const base = ["repo", "edit", `${owner}/${name}`, "--visibility", visibility];
  try {
    exec([...base, VISIBILITY_CONSEQUENCES_FLAG]);
    return;
  } catch (err) {
    if (!isUnknownFlagError(err, VISIBILITY_CONSEQUENCES_FLAG)) {
      throw firewall(err, { op: "reach GitHub" });
    }
  }
  // Legacy gh (pre-`--accept-visibility-change-consequences`): the bare
  // `--visibility` flip is the whole contract there.
  try {
    exec(base);
  } catch (err) {
    throw firewall(err, { op: "reach GitHub" });
  }
}

export const VISIBILITY_CONSEQUENCES_FLAG = "--accept-visibility-change-consequences";

// m1 (release review) — some gh builds print the usage error to STDOUT rather than
// stderr, so both streams are inspected (plus the Error message as a last
// resort). The keying stays TIGHT on purpose: the text must both say "unknown
// flag" AND name the literal flag, so an unrelated gh failure is never
// swallowed into a silent retry that drops the required consequences flag.
export function isUnknownFlagError(err: unknown, flag: string): boolean {
  const e = err as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const parts: string[] = [];
  for (const stream of [e?.stderr, e?.stdout]) {
    if (stream instanceof Buffer) parts.push(stream.toString("utf8"));
    else if (typeof stream === "string") parts.push(stream);
  }
  if (typeof e?.message === "string") parts.push(e.message);
  const text = parts.join("\n");
  return /unknown flag/i.test(text) && text.includes(flag);
}

export function parseOwnerRepoFromUrl(url: string): { owner: string; repo: string } | null {
  let s = url
    .trim()
    .replace(/\.git$/i, "")
    .replace(/[\\/]+$/, "");
  if (s.length === 0) return null;

  let pathPart: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+(.*)$/i);
    pathPart = m?.[1] ?? "";
  } else if (/^[^@/\\]+@[^:]+:/.test(s)) {
    pathPart = s.replace(/^[^@/\\]+@[^:]+:/, "");
  } else {
    pathPart = s;
  }

  pathPart = pathPart.replace(/^[\\/]+/, "");
  const segments = pathPart.split(/[\\/]+/).filter(Boolean);
  if (segments.length < 2) return null;
  return { owner: segments[segments.length - 2]!, repo: segments[segments.length - 1]! };
}
