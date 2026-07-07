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

// Increment 1 · Phase A.3 — `lyt undo [--preview]`.
//
// Reverses the most-recent undoable op (single-step) recorded in the pod-level
// op-log by a mechanical-first verb (today: `lyt capture`). `--preview` turns the
// silent LIFO guess into a confirmable fact ("this will remove the note you
// saved") with zero mutation. Every message is plain-language — a `none`
// (already-pushed) or a nothing-to-undo state is stated in words, never a git
// noun. CLI-only for now; joins the CLI↔MCP parity manifest when the Phase-B MCP
// undo tool lands.

import { Command } from "commander";

import { closeOpLog, openOpLog, previewUndo, undoLast, type UndoOutcome } from "@younndai/lyt-vault";

interface UndoCliOpts {
  preview?: boolean;
  json?: boolean;
}

export function buildUndoCommand(): Command {
  return new Command("undo")
    .description(
      "Undo the last thing you did (single-step). Reverses a `lyt capture` cleanly; refuses honestly (in plain language) when the last action can't be undone.",
    )
    .option("--preview", "Show what undo WOULD do, without doing it")
    .option("--json", "Emit JSON")
    .action(async (opts: UndoCliOpts) => {
      const db = await openOpLog();
      let outcome: UndoOutcome;
      try {
        outcome = opts.preview === true ? await previewUndo({ opLogDb: db }) : await undoLast({ opLogDb: db });
      } finally {
        await closeOpLog(db);
      }

      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ ...outcome, preview: opts.preview === true }, null, 2));
        return;
      }
      // eslint-disable-next-line no-console
      console.log(outcome.message);
      // A non-preview run that undid nothing because there was nothing/it can't be
      // undone is not an error (the message explains) — exit 0. Preview is always
      // informational.
    });
}
