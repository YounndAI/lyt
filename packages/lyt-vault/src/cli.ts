#!/usr/bin/env node
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

import { createRequire } from "node:module";

import { Command } from "commander";

import { registerVaultVerbs } from "./register-verbs.js";
import { makeCreationCommandReceipt } from "./op/creation-command-receipt.js";
import { newUuidv7Bytes, uuid7BytesToDashedString } from "./util/uuid7.js";

const program = new Command();

program
  .name("lyt")
  .description("Lyt — federated markdown-vault mesh CLI")
  .version((createRequire(import.meta.url)("../package.json") as { version: string }).version);

registerVaultVerbs(program);

program.exitOverride();
program.parseAsync(process.argv).catch((err: unknown) => {
  if (typeof err === "object" && err !== null && "exitCode" in err && err.exitCode === 0) {
    process.exitCode = 0;
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`lyt: ${message}`);
  const operationId = uuid7BytesToDashedString(newUuidv7Bytes());
  const attemptId = uuid7BytesToDashedString(newUuidv7Bytes());
  const receipt = makeCreationCommandReceipt({
    operation: "cli-parse",
    operationId,
    attemptId,
    startedAt: new Date().toISOString(),
    logicalKey: { command: "lyt-vault", outcome: "parser-refusal" },
    status: "refused",
    error: {
      code: "invalid-cli-arguments",
      summary: "Lyt command arguments were refused.",
      retryable: false,
    },
    next: { code: "correct-cli-arguments", summary: "Correct the command arguments and retry." },
    exitCode: 2,
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exitCode = 2;
});
