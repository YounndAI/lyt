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

import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

export function getLytHome(): string {
  const override = process.env["LYT_HOME"];
  if (override && override.length > 0) {
    return resolve(override);
  }
  return join(homedir(), "lyt");
}

export function getDefaultVaultsRoot(): string {
  return join(getLytHome(), "vaults");
}

export function resolveVaultPath(name: string, pathOverride?: string): string {
  if (pathOverride && pathOverride.length > 0) {
    return resolve(pathOverride);
  }
  const root = getDefaultVaultsRoot();
  const target = resolve(join(root, name));
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Vault name '${name}' would escape vaults root ${root} (resolved to ${target}). ` +
        `Names must stay inside the vaults root — avoid '..', absolute paths, and empty/dot names.`,
    );
  }
  return target;
}

export function canonicalizeVaultPath(p: string): string {
  return resolve(p);
}

// Heuristic floor against catastrophic accidents (typo, env-var leak), NOT a
// security boundary against hostile input. A user who deliberately sets
// LYT_HOME=/some/path/lyt-bombs-away passes the basename regex and accepts the
// consequences. Real defense for hostile input is "don't run Lyt as a hostile user."
const LYT_HOME_BASENAME = /^(lyt|\.lyt|lyt-.+)$/i;

export function validateLytHome(home: string): void {
  const resolved = resolve(home);
  if (resolved === resolve("/")) {
    throw new Error(
      `Refusing destructive op against filesystem root (lyt home: ${resolved}). ` +
        `Set LYT_HOME to a path whose basename is "lyt", ".lyt", or "lyt-*".`,
    );
  }
  if (resolved === resolve(homedir())) {
    throw new Error(
      `Refusing destructive op against the user home directory (lyt home: ${resolved}). ` +
        `Set LYT_HOME to a path whose basename is "lyt", ".lyt", or "lyt-*".`,
    );
  }
  const base = basename(resolved);
  if (!LYT_HOME_BASENAME.test(base)) {
    throw new Error(
      `Refusing destructive op against non-lyt-shaped lyt home (lyt home: ${resolved}). ` +
        `Basename "${base}" does not match /^(lyt|\\.lyt|lyt-.+)$/i. ` +
        `Set LYT_HOME to a path whose basename is "lyt", ".lyt", or "lyt-*".`,
    );
  }
}
