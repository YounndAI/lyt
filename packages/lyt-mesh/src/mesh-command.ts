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

import { buildCloneAllCommand } from "./commands/clone-all.js";
import { buildMeshInitCommand } from "./commands/mesh-init.js";
import { buildSourceCommand } from "./commands/source.js";
import { buildStatusCommand } from "./commands/status.js";
import { buildValidateCommand } from "./commands/validate.js";

export function buildMeshSubcommand(): Command {
  const mesh = new Command("mesh").description(
    "Multi-org clone-all, vault source management, mesh validate/status, manifest-driven init",
  );
  mesh.addCommand(buildCloneAllCommand());
  mesh.addCommand(buildSourceCommand());
  mesh.addCommand(buildValidateCommand());
  mesh.addCommand(buildStatusCommand());
  mesh.addCommand(buildMeshInitCommand());
  return mesh;
}
