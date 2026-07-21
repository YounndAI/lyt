/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { Command } from "commander";

import { setVaultDestinationFlow } from "../flows/vault-destination.js";

export function buildDestinationCommand(): Command {
  return new Command("destination")
    .description("Set an explicit local or GitHub destination for one existing owned vault")
    .argument("<name>", "Qualified vault address")
    .option("--local", "Persist a local-only vault override")
    .option("--target <github-target>", "github:user/<owner> or github:org/<owner>")
    .option("--json", "Emit machine-readable JSON")
    .action(async (name: string, opts: { local?: boolean; target?: string; json?: boolean }) => {
      try {
        const result = await setVaultDestinationFlow({
          name,
          ...(opts.local === undefined ? {} : { local: opts.local }),
          ...(opts.target === undefined ? {} : { target: opts.target }),
        });
        // eslint-disable-next-line no-console
        console.log(
          opts.json
            ? JSON.stringify(result, null, 2)
            : `Destination set for ${result.vault}: ${result.destination.kind}${
                result.destination.target === null ? "" : ` ${result.destination.target}`
              }`,
        );
      } catch (error) {
        const summary = error instanceof Error ? error.message : "Vault destination update failed.";
        if (opts.json) {
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify({
              operation: "vault-destination",
              status: "refused",
              mutations: { local: 0, remote: 0 },
              error: { code: "vault-destination-refused", summary },
            }),
          );
        } else {
          // eslint-disable-next-line no-console
          console.error(`lyt vault destination: ${summary}`);
        }
        process.exitCode = 2;
      }
    });
}
