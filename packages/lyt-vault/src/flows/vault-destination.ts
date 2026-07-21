/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByName } from "../registry/repo.js";
import { setCanonicalDestinationPolicy } from "./federation/destination-policy-service.js";
import { parseGithubPublicationTarget } from "../util/permission-observation.js";
import { normalizeGithubPublicationCoordinate } from "../util/publication-coordinate.js";

export interface SetVaultDestinationArgs {
  name: string;
  local?: boolean;
  target?: string;
}

export interface SetVaultDestinationResult {
  operation: "vault-destination";
  status: "success";
  vault: string;
  vaultRid: string;
  destination: {
    kind: "local" | "github";
    target: string | null;
    repository: string | null;
    source: "vault-override";
    policyEpoch: number;
  };
  mutations: { local: 1; remote: 0 };
}

/** Set one explicit canonical destination for an existing active owned vault. */
export async function setVaultDestinationFlow(
  args: SetVaultDestinationArgs,
): Promise<SetVaultDestinationResult> {
  if ((args.local === true) === (args.target !== undefined)) {
    throw new Error("Choose exactly one of --local or --target github:user|org/<owner>.");
  }

  const target = args.target === undefined ? null : parseGithubPublicationTarget(args.target);
  if (args.target !== undefined && target === null) {
    throw new Error("--target must be github:user/<owner> or github:org/<owner>.");
  }

  const db = await openRegistry();
  try {
    const vault = await getVaultByName(db, args.name);
    if (vault === null) throw new Error(`No registered vault resolves from '${args.name}'.`);
    if (vault.status !== "active") throw new Error("Destination override requires an active vault.");
    if (vault.source !== "own") throw new Error("Destination override requires an owned vault.");

    let repositoryName: string | null = null;
    if (target !== null) {
      const origin = normalizeGithubPublicationCoordinate(vault.gitUrl);
      if (origin === null) {
        throw new Error("GitHub destination override requires one parseable existing GitHub origin.");
      }
      if (origin.owner.toLowerCase() !== target.owner) {
        throw new Error("Destination override cannot replace the existing origin owner.");
      }
      repositoryName = origin.repositoryName;
    }

    const winner = await setCanonicalDestinationPolicy(db, {
      subjectKind: "vault",
      subjectRid: vault.rid,
      destinationKind: target === null ? "local" : "github",
      targetOwner: target?.owner ?? null,
      targetKind: target?.kind ?? null,
      repositoryName,
      source: "vault-override",
    });

    return {
      operation: "vault-destination",
      status: "success",
      vault: vault.name,
      vaultRid: vault.ridHex,
      destination: {
        kind: target === null ? "local" : "github",
        target: target?.value ?? null,
        repository: repositoryName,
        source: "vault-override",
        policyEpoch: winner.policyEpoch ?? 0,
      },
      mutations: { local: 1, remote: 0 },
    };
  } finally {
    await closeRegistry(db);
  }
}
