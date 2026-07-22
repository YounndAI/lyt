/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import type { Client } from "@libsql/client";

import { listAliases } from "../registry/aliases-repo.js";
import { openRegistryReadOnly } from "../registry/read-only-client.js";
import { listVaults } from "../registry/repo.js";
import { vaultLeaf } from "../registry/vault-addressing.js";
import { slugifyVaultName } from "../util/identity.js";

export const MAX_RECOMMENDED_ALIAS_LENGTH = 96;
const MAX_RECOMMENDED_ALIAS_SUFFIX = 9_999;

export type AliasRecommendationReason = "bare-leaf-collision" | "long-qualified-address";
export type AliasRecommendationAction = "create" | "already-available";

export interface ExistingVaultAlias {
  readonly alias: string;
  /** UUIDv7 in dashed or compact hexadecimal form. */
  readonly vaultRid: string;
}

export interface VaultAliasRecommendation {
  readonly action: AliasRecommendationAction;
  readonly alias: string;
  readonly canonicalTarget: string;
  readonly vaultRid: string;
  readonly reason: AliasRecommendationReason;
  /** Argument vector, never a shell command. Empty when the alias already exists. */
  readonly argv: readonly string[];
}

function normalizeRid(rid: string): string {
  return rid.replaceAll("-", "").toLowerCase();
}

function isSafeRecommendedAlias(alias: string): boolean {
  return (
    alias.length <= MAX_RECOMMENDED_ALIAS_LENGTH && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(alias)
  );
}

function safeAliasBase(raw: string, vaultRid: string): string {
  let slug: string;
  try {
    slug = slugifyVaultName(raw);
  } catch {
    const ridStem = normalizeRid(vaultRid).slice(0, 8) || "local";
    slug = `vault-${ridStem}`;
  }
  return slug.slice(0, MAX_RECOMMENDED_ALIAS_LENGTH).replace(/-+$/u, "") || "vault-local";
}

function candidateWithSuffix(base: string, ordinal: number): string {
  if (ordinal === 1) return base;
  const suffix = `-${ordinal}`;
  const stem = base.slice(0, MAX_RECOMMENDED_ALIAS_LENGTH - suffix.length).replace(/-+$/u, "");
  return `${stem || "vault"}${suffix}`;
}

export function deriveVaultAliasRecommendation(args: {
  canonicalName: string;
  vaultRid: string;
  bareLeafCollides: boolean;
  existingAliases?: readonly ExistingVaultAlias[];
}): VaultAliasRecommendation | null {
  const leaf = vaultLeaf(args.canonicalName);
  const longQualifiedAddress = args.canonicalName.length > 32;
  if (!args.bareLeafCollides && !longQualifiedAddress) return null;

  const reason: AliasRecommendationReason = args.bareLeafCollides
    ? "bare-leaf-collision"
    : "long-qualified-address";
  const rawBase = args.bareLeafCollides ? args.canonicalName.replace("/", "-") : leaf;
  const base = safeAliasBase(rawBase, args.vaultRid);
  const aliases = [...(args.existingAliases ?? [])].sort((a, b) =>
    a.alias.localeCompare(b.alias, "en"),
  );
  const targetRid = normalizeRid(args.vaultRid);
  const existingForTarget = aliases.find(
    (entry) => normalizeRid(entry.vaultRid) === targetRid && isSafeRecommendedAlias(entry.alias),
  );
  if (existingForTarget !== undefined) {
    return Object.freeze({
      action: "already-available",
      alias: existingForTarget.alias,
      canonicalTarget: args.canonicalName,
      vaultRid: args.vaultRid,
      reason,
      argv: Object.freeze([]),
    });
  }

  const byAlias = new Map(aliases.map((entry) => [entry.alias, entry]));
  for (let ordinal = 1; ordinal <= MAX_RECOMMENDED_ALIAS_SUFFIX; ordinal += 1) {
    const candidate = candidateWithSuffix(base, ordinal);
    if (!byAlias.has(candidate)) {
      return Object.freeze({
        action: "create",
        alias: candidate,
        canonicalTarget: args.canonicalName,
        vaultRid: args.vaultRid,
        reason,
        argv: Object.freeze(["lyt", "alias", candidate, args.canonicalName]),
      });
    }
  }
  return null;
}

/** Read-only observation through the shared SELECT-only capability. */
export async function observeVaultAliasRecommendation(
  args: { canonicalName: string; vaultRid: string },
  registryDb?: Client,
): Promise<VaultAliasRecommendation | null> {
  const opened = registryDb === undefined ? openRegistryReadOnly() : null;
  if (opened?.kind === "missing") return null;
  const db = registryDb ?? (opened!.client as unknown as Client);
  try {
    const leaf = vaultLeaf(args.canonicalName);
    const matchingLeaves = (await listVaults(db)).filter(
      (vault) => vault.status !== "tombstoned" && vaultLeaf(vault.name) === leaf,
    );
    const aliases = (await listAliases(db)).map((entry) => ({
      alias: entry.alias,
      vaultRid: entry.vaultRidHex,
    }));
    return deriveVaultAliasRecommendation({
      ...args,
      bareLeafCollides: matchingLeaves.length > 1,
      existingAliases: aliases,
    });
  } finally {
    opened?.close();
  }
}
