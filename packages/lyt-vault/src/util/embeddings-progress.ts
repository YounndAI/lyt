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

// Phase E Unit 2 — the embeddings-build progress SURFACE (human stdout
// only). Pure formatters for the TUI spinner phase labels + the two progress
// lines (model download, embed loop). NO I/O here: the caller (the reindex CLI
// spinner) decides whether to print, and suppresses ALL of this under --json
// and on a non-TTY (machine-consumed output stays byte-stable). Pure so the
// label/line shapes are unit-testable without a terminal.
//
// Phase labels (plan C6, "no 'probe'"): the one-time local model fetch + build
// moves fetch → index → ready, or terminates at offline-deferred / timed-out.

// The honest lifecycle of a consented embeddings build. "probe" is intentionally
// absent (dropped in Phase A — there is no network probe on this path).
export type EmbeddingsBuildPhase =
  // Downloading the one-time local model from GCS (only when absent + consented).
  | "fetch"
  // Embedding the corpus into the dense-vector cache (the model is loaded).
  | "index"
  // Done — vectors written, semantic search live.
  | "ready"
  // The model wasn't cached and couldn't be fetched (offline / fetch failed) —
  // degraded cleanly to lexical; the build is deferred to a later online run.
  | "offline-deferred"
  // The fetch/init hit the hard stall ceiling and was abandoned → lexical.
  | "timed-out";

// The human-readable gerund/label shown beside the spinner for each phase. Kept
// short + honest (matches the spinner's gerund convention). The CLI passes the
// terminal phases (ready/offline-deferred/timed-out) as a final printed line,
// not a spinner frame.
const PHASE_LABELS: Record<EmbeddingsBuildPhase, string> = {
  fetch: "fetching the one-time local model",
  index: "building the semantic index",
  ready: "semantic index ready",
  "offline-deferred": "semantic deferred (offline) — search works (lexical)",
  "timed-out": "semantic deferred (model fetch timed out) — search works (lexical)",
};

export function embeddingsPhaseLabel(phase: EmbeddingsBuildPhase): string {
  return PHASE_LABELS[phase];
}

// Format a model-download progress line. Byte-progress when totalBytes > 0
// (server sent content-length): "fetching the one-time local model — <done>/<total>
// MB (<pct>%)". HEARTBEAT when totalBytes <= 0 (content-length omitted): we can't
// show a percentage, so we show the bytes pulled so far + a heartbeat marker so
// the line still advances honestly: "fetching the one-time local model — <done> MB…".
// (Examples use <placeholders>, NOT literal sizes — the figures here are LIVE
// measured transfer, emitted at runtime by mib(); a literal "<N> MB" in the
// doc would (rightly) trip the F-F.1 no-model-size-claims guard, which is about
// static SIZE CLAIMS, not this dynamic readout. Keep examples non-numeric.)
export function formatDownloadProgress(bytesDone: number, totalBytes: number): string {
  const done = Math.max(0, bytesDone);
  if (totalBytes > 0) {
    const total = Math.max(done, totalBytes);
    const pct = Math.min(100, Math.floor((done / total) * 100));
    return `${PHASE_LABELS.fetch} — ${mib(done)}/${mib(total)} MB (${pct}%)`;
  }
  // Heartbeat: no total → advancing byte count + an ellipsis (the spinner frame
  // itself supplies the animation; this keeps the byte tally moving).
  return `${PHASE_LABELS.fetch} — ${mib(done)} MB…`;
}

// Format the embed-loop progress line: "building the semantic index — 6/7".
export function formatEmbedProgress(done: number, total: number): string {
  const d = Math.max(0, Math.min(done, total));
  return `${PHASE_LABELS.index} — ${d}/${total}`;
}

// Bytes → MiB, one decimal place (no trailing-zero churn beyond that).
function mib(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
