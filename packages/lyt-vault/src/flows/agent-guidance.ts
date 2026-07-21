/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 * Licensed under the Apache License, Version 2.0.
 */

export const MANAGED_MANUAL_BEGIN_RE =
  /<!-- lyt-manual v[0-9][0-9A-Za-z.\-+]* BEGIN -->/g;
export const MANAGED_MANUAL_END_RE = /<!-- lyt-manual v[0-9][0-9A-Za-z.\-+]* END -->/g;

export type ManagedMarkerComposition =
  | Readonly<{ status: "composed"; result: string; replaced: boolean }>
  | Readonly<{ status: "malformed"; beginCount: number; endCount: number }>;

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
  const begins = [...existing.matchAll(MANAGED_MANUAL_BEGIN_RE)];
  const ends = [...existing.matchAll(MANAGED_MANUAL_END_RE)];
  if (begins.length === 0 && ends.length === 0) {
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    return {
      status: "composed",
      result: `${existing}${separator}${managedBlock}`,
      replaced: false,
    };
  }
  if (begins.length !== 1 || ends.length !== 1 || ends[0]!.index! < begins[0]!.index!) {
    return {
      status: "malformed",
      beginCount: begins.length,
      endCount: ends.length,
    };
  }
  const begin = begins[0]!;
  const end = ends[0]!;
  const after = existing.slice(end.index! + end[0].length);
  const trailing = after.startsWith("\n") ? "" : "\n";
  return {
    status: "composed",
    result: `${existing.slice(0, begin.index)}${managedBlock.replace(/\n$/, "")}${trailing}${after}`,
    replaced: true,
  };
}
