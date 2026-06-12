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

export type TemplateName = "empty" | "obsidian-default";

export const DEFAULT_TEMPLATE: TemplateName = "obsidian-default";

export interface ObsidianScaffold {
  workspaceJson: string;
  corePluginsJson: string;
  communityPluginsJson: string;
  appJson: string;
}

const baseAppJson = JSON.stringify(
  {
    promptDelete: false,
    alwaysUpdateLinks: true,
    useMarkdownLinks: false,
    newLinkFormat: "shortest",
    attachmentFolderPath: "attachments",
  },
  null,
  2,
);

const baseWorkspaceJson = JSON.stringify(
  {
    main: {
      id: "lyt-root",
      type: "split",
      children: [
        {
          id: "lyt-leaf-empty",
          type: "tabs",
          children: [{ id: "lyt-empty", type: "leaf", state: { type: "empty", state: {} } }],
        },
      ],
      direction: "vertical",
    },
    left: { id: "lyt-left", type: "split", children: [], direction: "horizontal", width: 280 },
    right: { id: "lyt-right", type: "split", children: [], direction: "horizontal", width: 280 },
    active: "lyt-empty",
    lastOpenFiles: [],
  },
  null,
  2,
);

const emptyCorePlugins = JSON.stringify(
  [
    "file-explorer",
    "global-search",
    "switcher",
    "graph",
    "backlink",
    "page-preview",
    "command-palette",
    "outline",
    "word-count",
  ],
  null,
  2,
);

const emptyCommunityPlugins = JSON.stringify([], null, 2);

const obsidianDefaultCommunityPlugins = JSON.stringify(
  ["obsidian-git", "templater-obsidian", "dataview"],
  null,
  2,
);

export function getObsidianScaffold(template: TemplateName): ObsidianScaffold {
  if (template === "obsidian-default") {
    return {
      workspaceJson: baseWorkspaceJson,
      corePluginsJson: emptyCorePlugins,
      communityPluginsJson: obsidianDefaultCommunityPlugins,
      appJson: baseAppJson,
    };
  }
  return {
    workspaceJson: baseWorkspaceJson,
    corePluginsJson: emptyCorePlugins,
    communityPluginsJson: emptyCommunityPlugins,
    appJson: baseAppJson,
  };
}

export function getReadmeContent(vaultName: string): string {
  return [
    `# ${vaultName}`,
    ``,
    `> A Lyt vault — federated markdown knowledge with AI agent integration.`,
    ``,
    `This vault is part of a Lyt mesh. The canonical bytes live in Git;`,
    `derived state (search index, embeddings) lives in \`.lyt/indexes/\` and is rebuildable.`,
    ``,
    `See [linkyourthink.com](https://linkyourthink.com).`,
    ``,
  ].join("\n");
}

export function getVaultGitignore(): string {
  return [
    "# Lyt — derived state (rebuildable from Git canonical via `lyt vault rebuild-index`)",
    ".lyt/lyt.db",
    ".lyt/lyt.db-shm",
    ".lyt/lyt.db-wal",
    ".lyt/outbox.db",
    "",
    "# v1.A.2 — libSQL ledger caches (rebuilt from `.lyt/ledgers/*.yon` SoT",
    "# via `lyt vault rebuild-index --ledger <name>` or `lyt sync` post-pull).",
    ".lyt/indexes/",
    "",
    "# v1.A.2 — YON ledger SoT (audit + provenance) IS committed; ensure",
    "# no parent `.lyt/` rule silently ignores them.",
    "!.lyt/ledgers/",
    "!.lyt/ledgers/**",
    "",
    "# v1.D.1a — YON lanes index SoT IS committed. The `.lyt/indexes/`",
    "# rule above gitignores the libSQL caches; this re-include keeps the",
    "# canonical lanes.yon visible to Git.",
    "!.lyt/indexes/lanes.yon",
    "",
    "# v1.D.2a — YON arcs index SoT IS committed (position-ordered",
    "# narrative arcs). Same posture as lanes.yon above.",
    "!.lyt/indexes/arcs.yon",
    "",
    "# v1.D.4 — agent-priming markdown files (lyt primer output) IS",
    "# committed by default. Small textual artifacts useful cross-",
    "# machine; the parent `.lyt/` rule above would gitignore them",
    "# without this re-include.",
    "!.lyt/primers/",
    "!.lyt/primers/**",
    "",
    "# v1.D.5 — Obsidian Canvas visualisations of federation + mesh",
    "# graphs (lyt federation canvas / lyt mesh canvas output) IS",
    "# committed by default. Same posture as primers above.",
    "!.lyt/canvases/",
    "!.lyt/canvases/**",
    "",
    "# Obsidian — local workspace state (not committed)",
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
    "",
    "# OS / editor",
    ".DS_Store",
    "Thumbs.db",
    "",
  ].join("\n");
}
