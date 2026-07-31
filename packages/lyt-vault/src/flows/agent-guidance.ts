/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 * Licensed under the Apache License, Version 2.0.
 */

import { createHash } from "node:crypto";

export const MANAGED_MANUAL_BEGIN_RE =
  /<!-- lyt-manual v[0-9][0-9A-Za-z.\-+]* BEGIN -->/g;
export const MANAGED_MANUAL_END_RE = /<!-- lyt-manual v[0-9][0-9A-Za-z.\-+]* END -->/g;

export type ManagedMarkerComposition =
  | Readonly<{ status: "composed"; result: string; replaced: boolean }>
  | Readonly<{ status: "malformed"; beginCount: number; endCount: number }>;

export type ManagedManualMarkerInspection =
  | Readonly<{
      status: "exact";
      block: string;
      digest: string;
      markerBegin: string;
      markerEnd: string;
    }>
  | Readonly<{ status: "missing" }>
  | Readonly<{
      status: "malformed";
      beginCount: number;
      endCount: number;
      reason: "duplicate" | "reversed" | "version-mismatch";
    }>;

export const AGENT_MANUAL_MAX_WORDS = 2_500;

/** Canonical budget counter for the generated managed manual body. */
export function countGuidanceWords(content: string): number {
  const trimmed = content.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;
}

/**
 * Pure owned-marker composition shared by direct manual install, heal, and
 * install reconciliation. It never reads or writes the filesystem.
 */
export function composeManagedManualMarker(
  existing: string,
  managedBlock: string,
): ManagedMarkerComposition {
  const inspection = inspectManagedManualMarker(existing);
  if (inspection.status === "missing") {
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    return {
      status: "composed",
      result: `${existing}${separator}${managedBlock}`,
      replaced: false,
    };
  }
  if (inspection.status === "malformed") {
    return {
      status: "malformed",
      beginCount: inspection.beginCount,
      endCount: inspection.endCount,
    };
  }
  const beginIndex = existing.indexOf(inspection.markerBegin);
  const endIndex = existing.indexOf(inspection.markerEnd, beginIndex + inspection.markerBegin.length);
  const after = existing.slice(endIndex + inspection.markerEnd.length);
  const trailing = after.startsWith("\n") ? "" : "\n";
  return {
    status: "composed",
    result: `${existing.slice(0, beginIndex)}${managedBlock.replace(/\n$/, "")}${trailing}${after}`,
    replaced: true,
  };
}

/**
 * Inspect the one exact Lyt-owned manual block without treating surrounding
 * Handler text as managed content. The digest includes both versioned markers.
 */
export function inspectManagedManualMarker(content: string): ManagedManualMarkerInspection {
  const begins = [...content.matchAll(MANAGED_MANUAL_BEGIN_RE)];
  const ends = [...content.matchAll(MANAGED_MANUAL_END_RE)];
  if (begins.length === 0 && ends.length === 0) return Object.freeze({ status: "missing" });
  if (begins.length !== 1 || ends.length !== 1) {
    return Object.freeze({
      status: "malformed",
      beginCount: begins.length,
      endCount: ends.length,
      reason: "duplicate",
    });
  }
  const begin = begins[0]!;
  const end = ends[0]!;
  if (end.index! < begin.index! + begin[0].length) {
    return Object.freeze({
      status: "malformed",
      beginCount: 1,
      endCount: 1,
      reason: "reversed",
    });
  }
  const beginVersion = begin[0].slice("<!-- lyt-manual v".length, -" BEGIN -->".length);
  const endVersion = end[0].slice("<!-- lyt-manual v".length, -" END -->".length);
  if (beginVersion !== endVersion) {
    return Object.freeze({
      status: "malformed",
      beginCount: 1,
      endCount: 1,
      reason: "version-mismatch",
    });
  }
  const block = content.slice(begin.index!, end.index! + end[0].length);
  return Object.freeze({
    status: "exact",
    block,
    digest: createHash("sha256").update(block, "utf8").digest("hex"),
    markerBegin: begin[0],
    markerEnd: end[0],
  });
}
