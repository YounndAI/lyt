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
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

import { listAvailableTopics, loadTopicMarkdown } from "../help/loader.js";

interface VerbGroup {
  name: string;
  verbs: { verb: string; summary: string }[];
}

const VERB_GROUPS: VerbGroup[] = [
  {
    name: "vault",
    verbs: [
      {
        verb: "lyt vault init <mesh>/<name>",
        summary:
          "Create a vault (create-if-missing: makes the mesh if absent, stops if the vault exists; --mesh, --push-to)",
      },
      {
        verb: "lyt vault adopt <path>",
        summary: "Upgrade an existing Obsidian vault to Lyt-aware (additive)",
      },
      {
        verb: "lyt vault join <path>",
        summary: "Register an already-Lyt-aware vault (e.g., one you git-cloned manually)",
      },
      { verb: "lyt vault clone <url>", summary: "Clone a Lyt vault from a Git URL and register" },
      {
        verb: "lyt vault list",
        summary:
          "Show every registered vault (★ marks roots; tombstones included unless --no-tombstones)",
      },
      {
        verb: "lyt vault info <name>",
        summary: "Show vault metadata (path, edges, memscope, status)",
      },
      { verb: "lyt vault open <name>", summary: "Launch the configured editor with this vault" },
      {
        verb: "lyt vault forget <name>",
        summary: "Remove from registry; files untouched (--tombstone leaves a closed-path sign)",
      },
      { verb: "lyt vault disconnect <name>", summary: "Stop syncing; local copy preserved" },
      {
        verb: "lyt vault delete <name>",
        summary: "Remove .lyt/ derived state; .md files untouched; tombstone by default",
      },
      {
        verb: "lyt vault verify",
        summary:
          "Walk registry, stat each path, flag missing rows (auto-promotes to tombstone at N fails)",
      },
      {
        verb: "lyt vault reconnect <name> --path <new>",
        summary: "Heal a missing/disconnected vault by repointing the registry row",
      },
      {
        verb: "lyt vault rebuild-index <name> [--force] [--json]",
        summary:
          "Drop + rebuild the per-vault libSQL from the markdown YON source-of-truth",
      },
      {
        verb: "lyt vault add-edge <name> --peer <rid> --edge share_with|parent",
        summary: "Declare a mesh edge from this vault to a peer",
      },
      {
        verb: "lyt vault regen-context <name>",
        summary: "Rewrite .lyt/mesh-context.md from the current edge state (idempotent)",
      },
      {
        verb: "lyt vault sync-metadata --vault|--vaults [--apply]",
        summary:
          "Sync vault.yon metadata (description + topics) to GitHub. Dry-run by default; --apply to write.",
      },
      {
        verb: "lyt vault freeze <name> [--until <duration>]",
        summary: "Lock a vault against mutations + sync; auto-expires (default 24h)",
      },
      {
        verb: "lyt vault unfreeze <name>",
        summary: "Release a frozen vault (idempotent on non-frozen)",
      },
      {
        verb: "lyt vault snapshot <name> [--label <text>]",
        summary: "Create a local git-branch snapshot (lyt-snapshot/<ts>[-<label>]; not pushed)",
      },
      {
        verb: "lyt vault restore <name> --from-snapshot <label>",
        summary: "Restore working tree from a snapshot branch (commits onto default branch)",
      },
      {
        verb: "lyt vault list-snapshots <name>",
        summary: "Enumerate this vault's snapshot branches",
      },
    ],
  },
  {
    name: "addressing",
    verbs: [
      {
        verb: "lyt alias <name> <target>",
        summary:
          "Bind a pod-local name to a vault (alias → rid; survives rename + move). --list, --remove",
      },
    ],
  },
  {
    name: "mesh",
    verbs: [
      {
        verb: "lyt mesh clone-all",
        summary: "Walk every configured VaultSource and clone every accessible vault",
      },
      {
        verb: "lyt mesh source add|list|remove",
        summary: "Manage the multi-org VaultSource list (host + owner + scope per source)",
      },
      {
        verb: "lyt mesh status",
        summary: "Render the mesh graph (text / json / dot) with sync state per vault",
      },
      {
        verb: "lyt mesh validate",
        summary: "Report unreciprocated share_with edges and parent_vault target gaps",
      },
      {
        verb: "lyt mesh init --from <manifest>",
        summary:
          "Stand up an entire mesh (vaults + edges + push) from a YON manifest in one command",
      },
    ],
  },
  {
    name: "sync",
    verbs: [
      {
        verb: "lyt sync",
        summary:
          "Reconcile every registered active vault with its remote (fetch / commit / push / pull --rebase)",
      },
      {
        verb: "lyt sync --watch",
        summary:
          "Background watcher (chokidar; debounced commit + incremental FTS reconcile; event-driven; foreground in v1)",
      },
      {
        verb: "lyt sync --check [--json]",
        summary:
          "Per-vault freshness reporting (clean / dirty / ahead / behind / diverged / no-upstream / frozen)",
      },
      {
        verb: "lyt sync --resolve-mesh-context",
        summary:
          "On .lyt/mesh-context.md conflict during pull, auto-checkout-theirs + regen-context + continue (off by default)",
      },
    ],
  },
  {
    name: "registry",
    verbs: [
      {
        verb: "lyt registry rebuild",
        summary: "Rebuild ~/lyt/registry.db by re-scanning known paths",
      },
      {
        verb: "lyt registry reset --yes",
        summary: "Wipe ~/lyt/registry.db + ~/lyt/known-paths.txt + all dirs under ~/lyt/vaults/",
      },
    ],
  },
  {
    name: "identity",
    verbs: [
      {
        verb: "lyt identity show",
        summary: "Print the cached GitHub handle (first line: github:<handle>)",
      },
      {
        verb: "lyt identity refresh",
        summary: "Re-pull from `gh api /user --jq .login` and overwrite the cache (30-day TTL)",
      },
    ],
  },
  {
    name: "audit",
    verbs: [
      {
        verb: "lyt audit export --since <date> [--until <date>] [--vault <name>] [--output <path>] [--json]",
        summary:
          "Render per-vault audit_log window as markdown (handler-shareable via git)",
      },
    ],
  },
  {
    name: "friction",
    verbs: [
      {
        verb: "lyt friction note <desc> [--category <c>]",
        summary:
          "Record a sync-friction incident (categories: sync.failed | sync.conflict | propagation.gap | discovery.gap)",
      },
      {
        verb: "lyt friction report [--window 28d] [--exclude-false-positive]",
        summary:
          "Count unresolved sync.friction.* incidents in window; warns at Tier A threshold (≥3)",
      },
      {
        verb: "lyt friction resolve <id> [--note <text>]",
        summary: "Mark a friction row resolved + emit sync.friction.fix.shipped",
      },
      {
        verb: "lyt friction false-positive <id> --note <text>",
        summary:
          "Flag a friction row as false-positive (exclude from `report --exclude-false-positive`)",
      },
    ],
  },
  {
    name: "provenance",
    verbs: [
      {
        verb: "lyt provenance trace <file|rid> [--vault <name>] [--json]",
        summary:
          "Render the chronological chain of @STAMP records from per-vault provenance",
      },
    ],
  },
  {
    name: "machine",
    verbs: [
      {
        verb: "lyt machine role enable <role>",
        summary:
          "Add a per-machine role (client | automator-runner | mesh-syncer | llm-host)",
      },
      {
        verb: "lyt machine role disable <role>",
        summary: "Remove a per-machine role (handler may opt out of any default)",
      },
      {
        verb: "lyt machine config region <region>",
        summary:
          'Handler-declared region (e.g. "EU", "US", "APAC") — read by memscope.data_residency at automator dispatch',
      },
      {
        verb: "lyt machine status [--json]",
        summary: "Print machine identity + active roles + region",
      },
    ],
  },
  {
    name: "federation",
    verbs: [
      {
        verb: "lyt federation init [--handle <h>] [--public|--private] [--no-push]",
        summary:
          "Forge Your Pod — create {handle}/lyt-pod (default --private per DQ-7a-extended) + scaffold pod.yon",
      },
      {
        verb: "lyt federation list [--json]",
        summary: "List meshes in Your Pod — reads cached ~/lyt/pod/pod.yon",
      },
      {
        verb: "lyt federation rebuild [--push] [--json]",
        summary:
          "Rebuild pod.yon deterministically from the registry (idempotent modulo last_synced_at)",
      },
    ],
  },
  {
    name: "housekeep",
    verbs: [
      {
        verb: "lyt housekeep [--vault <name>] [--ledger <name>] [--rotate-now] [--dry-run] [--json]",
        summary:
          "Month-boundary rotation for per-vault YON ledgers (audit, provenance). Idempotent; default scope = every active vault × every known ledger.",
      },
    ],
  },
  {
    name: "doctor",
    verbs: [
      {
        verb: "lyt doctor",
        summary:
          "Diagnostic check: binaries, ~/lyt/ shape, registry, gh auth, network, machine roles, settings.json, frozen near-expiry",
      },
      { verb: "lyt doctor --json", summary: "Emit structured JSON output for scripts" },
      {
        verb: "lyt doctor --quiet",
        summary: "Exit-code only (0 = all green, 1 = any fail, 2 = warnings only)",
      },
    ],
  },
  {
    name: "pattern",
    verbs: [
      { verb: "lyt pattern list", summary: "Show installed patterns under ~/lyt/patterns/" },
      {
        verb: "lyt pattern install <pkg|dir>",
        summary: "Install a pattern to ~/lyt/patterns/<name>/",
      },
      {
        verb: "lyt pattern link <name> --vault <v>",
        summary: "Symlink the pattern into a vault's Patterns/ directory",
      },
      {
        verb: "lyt pattern run <pattern> <verb>",
        summary: "Run a pattern verb (fills the template + writes the resolved path)",
      },
      { verb: "lyt pattern verbs <name>", summary: "List verbs in a pattern" },
      {
        verb: "lyt pattern fork|unlink|uninstall",
        summary: "Customize, unlink from a vault, or remove a pattern",
      },
    ],
  },
  {
    name: "mcp",
    verbs: [
      {
        verb: "lyt mcp serve",
        summary:
          "Start the Lyt MCP server (exposes vault + mesh + registry operations to MCP clients)",
      },
    ],
  },
  {
    name: "help",
    verbs: [
      { verb: "lyt help", summary: "This screen — verb groups overview" },
      { verb: "lyt help <topic>", summary: "Render a topic's markdown to the terminal" },
      {
        verb: "lyt help --markdown <topic>",
        summary: "Emit a topic's raw markdown (for piping into Obsidian)",
      },
    ],
  },
];

export function buildHelpCommand(): Command {
  const cmd = new Command("help");
  cmd
    .description(
      "Lyt CLI help. Run with no args for a verb-group overview; pass a topic name to read a deep-dive.",
    )
    .argument("[topic]", "Topic name (one of: " + listAvailableTopics().join(", ") + ")")
    .option("--markdown", "Emit raw markdown instead of terminal-rendered output")
    .action(async (topic: string | undefined, opts: HelpCliOpts) => {
      if (!topic) {
        printVerbGroupOverview();
        return;
      }
      const md = loadTopicMarkdown(topic);
      if (md === null) {
        const available = listAvailableTopics();
        // eslint-disable-next-line no-console
        console.error(`lyt help: no such topic '${topic}'.`);
        // eslint-disable-next-line no-console
        console.error(`Available topics: ${available.join(", ")}`);
        process.exit(1);
      }
      if (opts.markdown === true) {
        process.stdout.write(md);
        return;
      }
      const rendered = renderMarkdown(md);
      process.stdout.write(rendered);
    });
  return cmd;
}

interface HelpCliOpts {
  markdown?: boolean;
}

function printVerbGroupOverview(): void {
  // eslint-disable-next-line no-console
  console.log("Lyt — federated markdown-vault mesh CLI");
  // eslint-disable-next-line no-console
  console.log("");
  for (const group of VERB_GROUPS) {
    // eslint-disable-next-line no-console
    console.log(`${group.name}:`);
    for (const v of group.verbs) {
      const pad = " ".repeat(Math.max(2, 48 - v.verb.length));
      // eslint-disable-next-line no-console
      console.log(`  ${v.verb}${pad}${v.summary}`);
    }
    // eslint-disable-next-line no-console
    console.log("");
  }
  const topics = listAvailableTopics();
  if (topics.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`Topics (run 'lyt help <topic>'): ${topics.join(", ")}`);
  }
}

function renderMarkdown(md: string): string {
  // marked-terminal v7 returns a Renderer instance the marked extension expects.
  // Use marked.use({ renderer: ... }) shape.
  marked.use(markedTerminal() as unknown as Parameters<typeof marked.use>[0]);
  const out = marked.parse(md, { async: false });
  return typeof out === "string" ? out : String(out);
}
