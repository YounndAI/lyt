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

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByName, type VaultRow } from "../registry/repo.js";

export interface OpenFlowResult {
  vault: VaultRow;
  command: string;
  argv: readonly string[];
}

export async function openVaultFlow(name: string): Promise<OpenFlowResult> {
  const db = await openRegistry();
  let vault: VaultRow | null;
  try {
    vault = await getVaultByName(db, name);
  } finally {
    await closeRegistry(db);
  }
  if (!vault) {
    throw new Error(`No vault registered with name '${name}'. Try 'lyt vault list'.`);
  }
  if (!existsSync(vault.path)) {
    throw new Error(
      `Vault '${name}' is registered at ${vault.path} but that directory does not exist. ` +
        `Run 'lyt registry rebuild' to refresh, or 'lyt vault forget ${name}'.`,
    );
  }

  const { command, argv } = resolveOpenCommand(vault.path);
  const proc = spawn(command, argv, { detached: true, stdio: "ignore", shell: true });
  proc.unref();

  return { vault, command, argv };
}

function resolveOpenCommand(path: string): { command: string; argv: string[] } {
  const p = platform();
  if (p === "win32") return { command: "start", argv: ["", path] };
  if (p === "darwin") return { command: "open", argv: [path] };
  return { command: "xdg-open", argv: [path] };
}
