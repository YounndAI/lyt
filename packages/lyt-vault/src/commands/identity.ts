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

import {
  getIdentityCachePath,
  readIdentityCache,
  type CachedIdentity,
} from "../util/identity-cache.js";
import { getIdentity, refreshIdentity } from "../util/identity.js";

export function buildIdentityCommand(): Command {
  const cmd = new Command("identity").description(
    "Manage this machine's GitHub-handle cache at ~/lyt/machine.yon",
  );
  cmd.addCommand(buildShowCommand());
  cmd.addCommand(buildRefreshCommand());
  return cmd;
}

function buildShowCommand(): Command {
  return new Command("show")
    .description("Display the cached machine identity (first line: github:<handle>)")
    .option("--json", "Emit JSON instead of human-readable output")
    .action((opts: { json?: boolean }) => {
      // `show` does NOT auto-refresh; if cache is missing it falls back to
      // getIdentity() which will lazily refresh. This preserves the contract
      // that `show` is read-only when possible.
      const cached = readIdentityCache();
      const headLine = cached ? `${cached.provider}:${cached.handle}` : getIdentity();
      if (opts.json === true) {
        const payload = cached
          ? cachedToJson(cached)
          : { identity: headLine, cachePath: getIdentityCachePath(), source: "live" };
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      // eslint-disable-next-line no-console
      console.log(headLine);
      if (cached) {
        printCacheDetail(cached);
      } else {
        // eslint-disable-next-line no-console
        console.log(`  source:       live (no cache file — wrote ${getIdentityCachePath()})`);
      }
    });
}

function buildRefreshCommand(): Command {
  return new Command("refresh")
    .description("Re-pull from `gh api /user --jq .login` and overwrite the cache")
    .option("--json", "Emit JSON instead of human-readable output")
    .action((opts: { json?: boolean }) => {
      const headLine = refreshIdentity();
      const cached = readIdentityCache();
      if (opts.json === true) {
        const payload = cached
          ? cachedToJson(cached)
          : { identity: headLine, cachePath: getIdentityCachePath(), source: "live" };
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      // eslint-disable-next-line no-console
      console.log(headLine);
      if (cached) printCacheDetail(cached);
    });
}

function printCacheDetail(c: CachedIdentity): void {
  const iso = new Date(c.verifiedAtMs).toISOString();
  // eslint-disable-next-line no-console
  console.log(`  provider:     ${c.provider}`);
  // eslint-disable-next-line no-console
  console.log(`  handle:       ${c.handle}`);
  // eslint-disable-next-line no-console
  console.log(`  verified_at:  ${iso}`);
  // eslint-disable-next-line no-console
  console.log(`  source:       ${c.source}`);
  // eslint-disable-next-line no-console
  console.log(`  cache:        ${getIdentityCachePath()}`);
}

function cachedToJson(c: CachedIdentity): Record<string, unknown> {
  return {
    identity: `${c.provider}:${c.handle}`,
    provider: c.provider,
    handle: c.handle,
    verified_at: new Date(c.verifiedAtMs).toISOString(),
    source: c.source,
    cachePath: getIdentityCachePath(),
  };
}
