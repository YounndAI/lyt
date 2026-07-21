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

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { resolveSpawnInvocation } from "../../util/gh-federation.js";
import {
  buildPermissionObservation,
  parseGithubPublicationTarget,
  type PermissionEvidence,
  type PermissionObservation,
  type PublicationCapability,
} from "../../util/permission-observation.js";

const execFileAsync = promisify(execFile);

export const PUBLICATION_PERMISSION_PROMPT_GUARDS = Object.freeze({
  GH_PROMPT_DISABLED: "1",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
});

export interface ObservePublicationPermissionArgs {
  capability: PublicationCapability;
  target: string;
  repository: string;
  actor: string;
  attemptId: string;
  policyEpoch: number;
  observedAt?: string;
}

export type PublicationPermissionObserver = (
  args: ObservePublicationPermissionArgs,
) => Promise<PermissionObservation>;

export type PublicationPermissionGhRunner = (args: readonly string[]) => Promise<string>;

/** Fresh GitHub evidence for one outward operation; no result is cached. */
export async function observePublicationPermission(
  args: ObservePublicationPermissionArgs,
  gh: PublicationPermissionGhRunner = runGh,
): Promise<PermissionObservation> {
  const target = parseGithubPublicationTarget(args.target);
  if (target === null) {
    throw new Error("Publication permission requires a canonical GitHub target.");
  }

  const observedAt = args.observedAt ?? new Date().toISOString();
  let authenticatedActor: string | null = null;
  try {
    authenticatedActor = (await gh(["api", "/user", "--jq", ".login"])).trim().toLowerCase();
  } catch (error) {
    return build(args, observedAt, null, evidenceFromError(error));
  }
  if (authenticatedActor !== args.actor.trim().toLowerCase()) {
    return build(args, observedAt, authenticatedActor, { kind: "ambiguous" });
  }

  if (args.capability === "repository-push") {
    try {
      const permission = (
        await gh([
          "repo",
          "view",
          args.repository,
          "--json",
          "viewerPermission",
          "--jq",
          ".viewerPermission",
        ])
      )
        .trim()
        .toUpperCase();
      return build(args, observedAt, authenticatedActor, {
        kind: "repository-push",
        canPush: ["ADMIN", "MAINTAIN", "WRITE"].includes(permission),
      });
    } catch (error) {
      return build(args, observedAt, authenticatedActor, evidenceFromError(error));
    }
  }

  if (target.kind === "user") {
    return build(args, observedAt, authenticatedActor, {
      kind: "personal-self-target",
      actorConfirmed: authenticatedActor === target.owner,
    });
  }

  try {
    const membershipRaw = await gh([
      "api",
      `/user/memberships/orgs/${target.owner}`,
      "--jq",
      "{state:.state,role:.role}",
    ]);
    const orgRaw = await gh([
      "api",
      `/orgs/${target.owner}`,
      "--jq",
      "{members_can_create_repositories:.members_can_create_repositories}",
    ]);
    const membership = JSON.parse(membershipRaw) as { state?: string; role?: string };
    const org = JSON.parse(orgRaw) as { members_can_create_repositories?: boolean };
    return build(args, observedAt, authenticatedActor, {
      kind: "organization-create",
      effectiveMembership: membership.state === "active" ? "verified" : "unknown",
      creationPolicy: org.members_can_create_repositories === true ? "verified" : "unknown",
      administrator: membership.role === "admin" ? "verified" : "unknown",
    });
  } catch (error) {
    return build(args, observedAt, authenticatedActor, evidenceFromError(error));
  }
}

function build(
  args: ObservePublicationPermissionArgs,
  observedAt: string,
  actor: string | null,
  evidence: PermissionEvidence,
): PermissionObservation {
  return buildPermissionObservation({
    capability: args.capability,
    target: args.target,
    repository: args.repository,
    actor,
    attemptId: args.attemptId,
    policyEpoch: args.policyEpoch,
    observedAt,
    evidence,
  });
}

function evidenceFromError(error: unknown): PermissionEvidence {
  const value = error as { code?: string; stderr?: unknown; message?: string; killed?: boolean };
  const stderr =
    typeof value.stderr === "string"
      ? value.stderr
      : value.stderr instanceof Buffer
        ? value.stderr.toString("utf8")
        : "";
  const text = `${stderr}\n${value.message ?? ""}`;
  if (/HTTP\s*404|not found/i.test(text))
    return { kind: "unavailable", reason: "404-or-invisible" };
  if (/rate.?limit|HTTP\s*429/i.test(text)) return { kind: "unavailable", reason: "rate-limit" };
  if (value.killed === true || /timed?\s*out|ETIMEDOUT/i.test(text)) {
    return { kind: "unavailable", reason: "timeout" };
  }
  if (value.code === "ENOENT" || /offline|network|ENOTFOUND|ECONN/i.test(text)) {
    return { kind: "unavailable", reason: "offline" };
  }
  if (/HTTP\s*401|HTTP\s*403|permission denied|forbidden/i.test(text)) {
    return { kind: "confirmed-denial" };
  }
  return { kind: "ambiguous" };
}

async function runGh(args: readonly string[]): Promise<string> {
  const invocation = resolveSpawnInvocation("gh", args);
  const result = await execFileAsync(invocation.command, invocation.args as string[], {
    encoding: "utf8",
    shell: invocation.shell,
    timeout: 10_000,
    windowsHide: true,
    env: { ...process.env, ...PUBLICATION_PERMISSION_PROMPT_GUARDS },
  });
  return result.stdout;
}
