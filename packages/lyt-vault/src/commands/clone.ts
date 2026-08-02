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

import { Command } from "commander";

import { cloneVaultFlow, CloneTargetMeshNotFoundError } from "../flows/clone.js";
import { VaultHomeMeshNotRegisteredError } from "../flows/register.js";
import { VaultRelocationNotAuthorizedError } from "../registry/repo.js";

export function buildCloneCommand(): Command {
  const cmd = new Command("clone");
  cmd
    .description(
      "Git-clone a Lyt vault from a URL and register it. Pass --to-mesh <name> to assign the clone to a mesh. Whether the clone mints a fresh rid or preserves the source's is decided by the route taken and is reported in the output — do not assume a fresh rid.",
    )
    .argument("<url>", "Git URL of the vault repository")
    .option(
      "--name <name>",
      "Override the vault name (e.g., alex/main). Defaults to owner/repo extracted " +
        "from the URL.",
    )
    .option("--into <dir>", "Parent directory to clone into (defaults to ~/lyt/vaults)")
    .option(
      "--to-mesh <name>",
      "Assign the cloned vault to a registered mesh — generates a FRESH rid (NOT the source rid), writes @VAULT_HOME_MESH into the clone's vault.yon, and appends a @MESH_HOME row to the target mesh's mesh.yon. The source vault is untouched. Detaches the source origin by default (the new vault earns its own repo at first publish); pass --keep-origin to keep tracking the source as upstream.",
    )
    .option(
      "--keep-origin",
      "With --to-mesh: keep the source repo as origin (subscriber-style upstream tracking) instead of the default detach.",
    )
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (url: string, opts: CloneCliOpts) => {
      try {
        const result = await cloneVaultFlow({
          url,
          ...(opts.name !== undefined ? { name: opts.name } : {}),
          ...(opts.into !== undefined ? { parentDir: opts.into } : {}),
          ...(opts.toMesh !== undefined ? { toMesh: opts.toMesh } : {}),
          // F8/a review finding — detach is CLI intent for a standalone --to-mesh clone;
          // library callers (subscribe, adopt) default to keep.
          ...(opts.toMesh !== undefined && opts.keepOrigin !== true ? { detachOrigin: true } : {}),
          // Inc-2 Phase B / (S4) — a standalone `lyt vault clone <url>` (no
          // --to-mesh) of a FOREIGN vault auto-routes to the subscribe
          // (bucket-home) path instead of half-cloning then refusing with
          // VaultHomeMeshNotRegisteredError + orphaning a dir. A vault whose home
          // mesh IS one of the user's own meshes keeps the default clone.
          ...(opts.toMesh === undefined ? { routeForeignToBucket: true } : {}),
        });

        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify(
              {
                vault: {
                  rid: `vault:${result.ridHex}`,
                  rid_hex: result.ridHex,
                  name: result.name,
                  path: result.cloneTargetPath,
                },
                mesh_assignment: result.meshAssignment,
                origin_detached: result.originDetached,
              },
              null,
              2,
            ),
          );
          return;
        }

        // eslint-disable-next-line no-console
        console.log(`Cloned vault '${result.name}'`);
        // eslint-disable-next-line no-console
        console.log(`  path: ${result.cloneTargetPath}`);
        // eslint-disable-next-line no-console
        console.log(`  rid:  ${result.ridHex}`);
        if (result.meshAssignment !== null) {
          // A2 (0.20.17) — narrate the identity decision that ACTUALLY ran.
          //
          // This line previously printed "(fresh rid; source untouched)" gated
          // only on `meshAssignment !== null` — i.e. on whether a mesh was
          // assigned — while `freshRidApplied` sat unread in the very object
          // being printed. On the preserve-rid path both halves misled: the rid
          // is the source's, and although the source directory IS immediately
          // unmodified, the registry now resolves that identity to THIS clone,
          // so the source is no longer operationally protected by correct
          // identity resolution.
          const mesh = result.meshAssignment;
          // eslint-disable-next-line no-console
          console.log(
            `  mesh: assigned to '${mesh.meshName}' (${
              mesh.freshRidApplied ? "fresh rid minted" : "PRESERVED the source vault's rid"
            })`,
          );
          if (!mesh.freshRidApplied) {
            // eslint-disable-next-line no-console
            console.log(
              `  note: this clone kept the source vault's identity, so the registry now resolves ` +
                `that vault to THIS path.`,
            );
            // eslint-disable-next-line no-console
            console.log(
              `        The source directory is intact on disk but is no longer the registered ` +
                `vault — re-register it with 'lyt vault join <path>'.`,
            );
            if (result.originDetached !== true) {
              // eslint-disable-next-line no-console
              console.log(
                `        Its git origin still points at the SOURCE repository; check ` +
                  `'git remote -v' before any push from here.`,
              );
            }
          }
        }
        // F8 — a fresh-rid clone starts remote-less (its origin pointed at
        // the SOURCE vault's repo); first publish/sync creates its own.
        if (result.originDetached === true) {
          // eslint-disable-next-line no-console
          console.log(
            "  origin: detached from the source repo (new vault; `lyt sync` will publish its own)",
          );
        }
      } catch (err) {
        if (err instanceof CloneTargetMeshNotFoundError) {
          if (opts.json === true) {
            // eslint-disable-next-line no-console
            console.error(
              JSON.stringify(
                { error: err.errorCode, mesh_name: err.meshName, message: err.message },
                null,
                2,
              ),
            );
          } else {
            // eslint-disable-next-line no-console
            console.error(err.message);
          }
          process.exitCode = 2;
          return;
        }
        // the default-path clone of a vault whose home mesh isn't
        // registered locally refuses actionably (FK guarded at the register
        // chokepoint); same exit-2 contract as the --to-mesh refusal above.
        if (err instanceof VaultHomeMeshNotRegisteredError) {
          if (opts.json === true) {
            // eslint-disable-next-line no-console
            console.error(
              JSON.stringify(
                {
                  error: err.errorCode,
                  mesh_name: err.meshName,
                  vault_name: err.vaultName,
                  message: err.message,
                },
                null,
                2,
              ),
            );
          } else {
            // eslint-disable-next-line no-console
            console.error(err.message);
          }
          process.exitCode = 2;
          return;
        }
        // A1 (0.20.17) — the clone would have displaced an already-registered
        // vault's identity. Same actionable exit-2 contract as the refusals
        // above; without this arm the human message still reads correctly but
        // `--json` falls through to the generic parse-error receipt and the
        // product error code is lost to any consumer.
        if (err instanceof VaultRelocationNotAuthorizedError) {
          if (opts.json === true) {
            // eslint-disable-next-line no-console
            console.error(
              JSON.stringify(
                {
                  error: err.errorCode,
                  vault_name: err.vaultName,
                  rid_hex: err.ridHex,
                  registered_path: err.registeredPath,
                  incoming_path: err.incomingPath,
                  message: err.message,
                },
                null,
                2,
              ),
            );
          } else {
            // eslint-disable-next-line no-console
            console.error(err.message);
          }
          process.exitCode = 2;
          return;
        }
        throw err;
      }
    });
  return cmd;
}

interface CloneCliOpts {
  name?: string;
  into?: string;
  toMesh?: string;
  keepOrigin?: boolean;
  json?: boolean;
}
