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

// Centralised brand-voice strings per the LYT design doc `lyt-brand-voice.md.`
//
// §5 anti-pattern guard: *"Don't say 'minting' in one status message and
// 'creating' in the next."* One source for every whimsical verb keeps the
// product's voice coherent as new packages (mesh, mcp, bridge, rag) extend
// the surface.
//
// Rule of thumb (from §5):
// - CLI flags + arg names → plain ("init", "list", "rebuild")
// - Status messages emitted MID-action → whimsical (this module)
// - Logs / telemetry / audit events → plain ("event=federation.created")
// - Errors → plain ("Failed to create federation repo: ...")
//
// LOCKED verbs (Alex 2026-05-29): forge, mint, weave, divine, trace,
// crystallize. Recommended (un-locked): tend, graft, tune in, unfurl,
// survey, peek, etc. Whimsical strings use the ellipsis character (…),
// not "...", matching the canonical examples in lyt-brand-voice.md §2.

export const VOICE = Object.freeze({
  // §2 — federation init. The "Pod" user-facing name maps to the
  // technical "Federation" concept (CLI verb stays `lyt federation init`).
  forgingYourPod: "Forging Your Pod…",
  // §2 — federation init after detected-state self-heal branch.
  forgingFromDetectedState: "Forging Your Pod from detected state…",
  // §1 example — federation list human-mode header.
  yourPodSpansMeshes: (n: number): string => `Your Pod spans ${n} mesh${n === 1 ? "" : "es"}:`,
  // §2 — federation rebuild.
  rebuildingPod: "Rebuilding Your Pod from registry…",
  // Verbs LOCKED in lyt-brand-voice.md §2 + §8 (mint for vault, weave for
  // mesh) but NOT yet wired into call sites — those land at the vault/mesh
  // init refactor phases (v1.B.1 / v1.B.3 in the master plan). Per
  // project's pre-release clean-slate posture they get added here at the
  // same commit as their first caller, not speculatively.
} as const);
