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

import { deleteVaultFlow, type DeleteFlowResult } from "./delete.js";

// `vault abandon` — the anti-lock-in "leave cleanly" verb, the inverse of
// `adopt`. It is a THIN ALIAS over `deleteVaultFlow(name, { noTombstone: true })`:
// that removes ONLY LYT's local `.lyt/` adoption state and deregisters the
// registry row — the user's markdown files and their GitHub repo are NEVER
// touched, and the remote is never contacted. Abandon adds nothing but the
// safety-naming refusal gate; ALL registry/disk/manifest work lives in
// `deleteVaultFlow` and is NOT duplicated here.
//
// The verb is agent-HIL-gated for message parity with share/unshare/invites:
// every invocation a handler did not explicitly confirm is refused. The CLI
// wires `confirmed` from `--yes`. The trailing "handlerGated enforcement
// pending — see Phase C" clause keeps the refusal message aligned with the
// other gated verbs so the MCP fail-closed test can key on it.

export interface AbandonVaultOpts {
  confirmed: boolean;
}

// The abandon result is delete's result, re-shaped with an explicit
// `status: "abandoned"` tag so callers see the anti-lock-in framing while the
// underlying fields stay identical to the delegated delete.
export interface AbandonFlowResult extends DeleteFlowResult {
  status: "abandoned";
}

export async function abandonVaultFlow(
  name: string,
  opts: AbandonVaultOpts,
): Promise<AbandonFlowResult> {
  if (!opts.confirmed) {
    throw new Error(
      `Refusing to abandon '${name}' without explicit confirmation. CLI: pass --yes. ` +
        `This removes only LYT's local .lyt/ adoption — your markdown files and your ` +
        `GitHub repo are untouched. Agent/MCP: this mutation is handler-gated; ` +
        `confirmation is required and MCP dispatch is now gated (default-deny unless the ` +
        `server was launched with out-of-band handler approval). This flow-layer refusal ` +
        `is retained as defense-in-depth beneath that gate.`,
    );
  }
  const result = await deleteVaultFlow(name, { noTombstone: true });
  return { ...result, status: "abandoned" };
}
