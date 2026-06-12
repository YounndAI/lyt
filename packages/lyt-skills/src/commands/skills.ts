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

import { buildSkillsInstallSubcommand } from "./skills-install.js";
import { buildSkillsListSubcommand } from "./skills-list.js";

export function buildSkillsCommand(): Command {
  const cmd = new Command("skills");
  cmd.description("Manage Lyt harness skills across Claude Code / Codex / .agents runtimes");
  cmd.addCommand(buildSkillsInstallSubcommand());
  cmd.addCommand(buildSkillsListSubcommand());
  return cmd;
}
