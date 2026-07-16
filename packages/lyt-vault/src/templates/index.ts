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

import { renderTemplate } from "./render.js";

export type TemplateName = "empty" | "obsidian-default";

// Lyt is editor-neutral by default. Obsidian configuration remains available
// as an explicit `--template obsidian-default` opt-in.
export const DEFAULT_TEMPLATE: TemplateName = "empty";

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

// UNIT 2 — README body externalized to `templates/README.md`.
// Per-template variable manifest: { vaultName }.
//
// README frontmatter-exempt — GitHub landing renders raw YAML; single documented
// exception, handler decision 2026-07-02. Every OTHER Lyt-scaffolded file carries
// contract frontmatter with real dates (fg-scaffold-frontmatter), but README.md
// is the GitHub repo landing page: GitHub renders leading `--- … ---` as visible
// raw text above the H1 (unlike Obsidian, which hides it). So README ships with
// NO frontmatter. FTS-exclusion is handled by the isScaffoldNote BASENAME gate
// (util/indexable.ts), independent of any sentinel.
export function getReadmeContent(vaultName: string): string {
  return renderTemplate("README.md", { vaultName });
}

export function getVaultGitignore(): string {
  return [
    "# Lyt — derived state (rebuildable from Git canonical via `lyt vault rebuild-index`)",
    ".lyt/lyt.db",
    ".lyt/lyt.db-shm",
    ".lyt/lyt.db-wal",
    ".lyt/outbox.db",
    "",
    "# libSQL ledger caches (rebuilt from `.lyt/ledgers/*.yon` SoT",
    "# via `lyt vault rebuild-index --ledger <name>` or `lyt sync` post-pull).",
    "# Contents-glob (`dir/*`, NOT bare `dir/`): a bare `.lyt/indexes/`",
    "# rule excludes the directory itself, and Git CANNOT re-include a file",
    "# whose parent dir is excluded — so the `!.lyt/indexes/lanes.yon`",
    "# re-includes below would be dead. `dir/*` excludes only the CONTENTS",
    "# (the *.db / -shm / -wal caches) while leaving the directory walkable,",
    "# which lets the named YON SoT files below be re-included by Git.",
    ".lyt/indexes/*",
    "",
    "# Pattern LINKS (per-machine junctions → ~/lyt/patterns, or copy-",
    "# fallback dirs on no-admin). Lyt-owned machine-local state, rebuilt",
    "# per-machine by `lyt vault adopt`/`join`; NOT committed. Same posture",
    "# as the libSQL caches above.",
    ".lyt/patterns/",
    "",
    "# YON ledger SoT (audit + provenance) IS committed. No rule above",
    "# ignores `.lyt/ledgers/` (only specific paths — the db caches,",
    "# `.lyt/indexes/*`, `.lyt/patterns/` — are excluded); these explicit",
    "# re-includes keep the ledgers committed and future-proof the intent.",
    "!.lyt/ledgers/",
    "!.lyt/ledgers/**",
    "",
    "# YON lanes index SoT IS committed. The `.lyt/indexes/*`",
    "# contents-glob above gitignores the libSQL caches; this re-include",
    "# keeps the canonical lanes.yon visible to Git. The committed lanes.yon",
    "# is content-only — the machine-local `last_built` stamp is omitted from",
    "# the serialization (it lives in the libSQL cache), so the file is",
    "# byte-stable across rebuilds and never churns the tree cross-machine.",
    "!.lyt/indexes/lanes.yon",
    "",
    "# YON arcs index SoT IS committed (position-ordered",
    "# narrative arcs). Same posture as lanes.yon above (the machine-local",
    "# `last_touched` stamp is likewise omitted from the committed file).",
    "!.lyt/indexes/arcs.yon",
    "",
    "# agent-priming markdown files (lyt primer output) IS",
    "# committed by default. Small textual artifacts useful cross-",
    "# machine; no rule above ignores `.lyt/primers/`, so these explicit",
    "# re-includes are defensive — they keep the intent clear and survive",
    "# any future broadening of the `.lyt/` exclusion rules.",
    "!.lyt/primers/",
    "!.lyt/primers/**",
    "",
    "# Obsidian Canvas visualisations of federation + mesh",
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
