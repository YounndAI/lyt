/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Lyt Pod Manager Obsidian plugin (TypeScript source).
//
// Activates on Obsidian startup. Detects whether the active vault is a
// Lyt pod-map vault (presence of `.lyt/vault.yon` with `kind=pod-map`).
// On detection:
//   (feature 1) mesh-boundary coloring — per-mesh hash → HSL hue;
//   (feature 2) write-permission badges — 🔒 prefix + file-explorer
//               badge for vault notes whose frontmatter declares
//               `vault.writable: false`.
//
// The default baseline ships NO management-op buttons (add-edge, subscribe,
// validate, repair). The extension points are documented as stubs at the
// bottom of this file so a future mgmt-ops feature lands purely additively.
//
// Degrade-to-baseline contract: the pod-map vault is a regular markdown
// vault with wikilinks. Obsidian's stock graph view renders it without this
// plugin. The plugin is enhancement only; uninstalling it does not break the
// pod-map.
//
// Build: `npm install && npm run build` from this folder. The pre-built
// `main.js` ships alongside this source for Obsidian to load directly
// (Obsidian plugin loader reads main.js, not main.ts). When editing
// main.ts, run the build before committing or Obsidian will silently
// load the stale main.js. The bundled main.js is what gets copied into
// `<pod-map-vault>/.obsidian/plugins/lyt-pod-manager/` by wizard P9.

import { Plugin, TFile, Notice } from "obsidian";

interface PodMapPluginSettings {
  enableMeshColoring: boolean;
  enableWritableBadges: boolean;
}

const DEFAULT_SETTINGS: PodMapPluginSettings = {
  enableMeshColoring: true,
  enableWritableBadges: true,
};

const POD_MAP_VAULT_KIND = "pod-map";
const POD_MAP_MESH_NOTE_KIND = "pod-map-mesh-note";
const POD_MAP_VAULT_NOTE_KIND = "pod-map-vault-note";

export default class LytPodManagerPlugin extends Plugin {
  settings: PodMapPluginSettings = DEFAULT_SETTINGS;
  // Mesh-name → cached HSL hue. Hash is deterministic per mesh name so
  // the same mesh gets the same color across sessions; runtime cache
  // avoids re-hashing on every graph render.
  private meshHueCache = new Map<string, number>();
  // Vault note path → writable verdict. Cached from frontmatter reads.
  private writableCache = new Map<string, "true" | "false" | "unknown">();

  async onload(): Promise<void> {
    await this.loadSettings();

    const isPodMap = await this.detectPodMapVault();
    if (!isPodMap) {
      // Not a pod-map vault — plugin stays loaded but inactive. No
      // event registrations, no badge logic, no Notice. Degrade-to-
      // baseline.
      return;
    }

    new Notice("Lyt Pod Manager active — pod-map vault detected.");

    if (this.settings.enableWritableBadges) {
      this.registerWritableBadges();
    }
    if (this.settings.enableMeshColoring) {
      this.registerMeshColoring();
    }

    // FUTURE mgmt-op extension points. Pure stubs; no behavior wired.
    // Document the shape so a future feature lands additively without
    // restructuring this file.
    //
    // FUTURE: this.registerHoverButton(vaultNode, "Add edge", () => spawnLytCli(["mesh","add-edge", ...]))
    // FUTURE: this.registerHoverButton(meshNode, "Subscribe", () => spawnLytCli(["mesh","subscribe", ...]))
    // FUTURE: this.addCommand({ id: "validate-mesh", name: "Lyt: validate this mesh", callback: () => ... })
    // FUTURE: this.addCommand({ id: "repair-mesh", name: "Lyt: repair this mesh", callback: () => ... })
  }

  onunload(): void {
    this.meshHueCache.clear();
    this.writableCache.clear();
    // release review fix: DOM cleanup on disable/uninstall.
    // Removes the singleton style element + strips the readonly badge
    // class from file-tree items so plugin disable leaves no visual
    // remnant. Mirrors the change in main.js.
    document.getElementById("lyt-pod-manager-mesh-colors")?.remove();
    const leaves = this.app.workspace.getLeavesOfType("file-explorer");
    for (const leaf of leaves) {
      const containerEl = leaf.view.containerEl;
      const items = containerEl.querySelectorAll<HTMLElement>(".tree-item-self");
      for (const el of items) {
        el.removeClass("lyt-pod-manager-readonly");
      }
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // Returns true when the active vault contains `.lyt/vault.yon` with
  // `kind=pod-map`. Read via adapter.read (not metadataCache; the file
  // sits under .lyt/ which Obsidian skips for the metadata cache by
  // default — dot-prefixed folders are ignored).
  private async detectPodMapVault(): Promise<boolean> {
    try {
      const raw = await this.app.vault.adapter.read(".lyt/vault.yon");
      // release review fix: anchor the match to a @VAULT YON record
      // line so a vault that incidentally mentions "kind=pod-map" in
      // a doc-string or comment does NOT spuriously activate the
      // plugin. Tolerate the frontmatter-style shape too (test
      // fixtures may use it).
      return (
        /@VAULT\s+[^\n]*\bkind\s*=\s*pod-map/i.test(raw) ||
        /^vault\.kind:\s*pod-map/im.test(raw)
      );
    } catch {
      return false;
    }
  }

  // Feature 2: write-permission badges. Hooks metadataCache resolved
  // event so that as soon as Obsidian's frontmatter parse completes for
  // a note, we cache its writable verdict for later badge rendering.
  // Async-safe — only reads cache, no synchronous heavy work.
  private registerWritableBadges(): void {
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        // Batch refresh all vault-note writable verdicts on full
        // resolve. Cheap: small N (pod size <= 50 vaults typically).
        const files = this.app.vault.getMarkdownFiles();
        for (const f of files) {
          if (!f.path.startsWith("vaults/")) continue;
          const meta = this.app.metadataCache.getFileCache(f);
          const fm = meta?.frontmatter as Record<string, unknown> | undefined;
          if (!fm) continue;
          const kind = String(fm["vault.kind"] ?? "");
          if (kind !== POD_MAP_VAULT_NOTE_KIND) continue;
          const writableRaw = String(fm["vault.writable"] ?? "unknown");
          const v: "true" | "false" | "unknown" =
            writableRaw === "true"
              ? "true"
              : writableRaw === "false"
                ? "false"
                : "unknown";
          this.writableCache.set(f.path, v);
        }
        this.refreshFileExplorerBadges();
      }),
    );
  }

  // Render 🔒 badges in the file explorer for vault notes whose
  // writable verdict is "false". DOM mutation is done via the public
  // workspace.getLeavesOfType("file-explorer") API; manual querySelector
  // calls are bounded to file-tree-item nodes (Obsidian-stable selector).
  private refreshFileExplorerBadges(): void {
    const leaves = this.app.workspace.getLeavesOfType("file-explorer");
    for (const leaf of leaves) {
      const containerEl = leaf.view.containerEl;
      const items = containerEl.querySelectorAll<HTMLElement>(".tree-item-self");
      for (const el of items) {
        // Reset prior badge state.
        el.removeClass("lyt-pod-manager-readonly");
        const dataPath = el.getAttribute("data-path");
        if (dataPath === null) continue;
        const verdict = this.writableCache.get(dataPath);
        if (verdict === "false") {
          el.addClass("lyt-pod-manager-readonly");
        }
      }
    }
  }

  // Feature 1: mesh-boundary coloring. Each mesh's notes share one HSL
  // hue derived from a string hash of the mesh name; cross-mesh
  // wikilinks render in a contrast color. The Obsidian Graph API does
  // not expose a stable typed setColor on plugin surface (1.4.x); we
  // inject CSS variables instead so the user's CSS snippets can pick
  // them up. This degrades cleanly when Obsidian's API changes.
  private registerMeshColoring(): void {
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        this.applyMeshColorVariables();
      }),
    );
    // Apply once on load so initial render picks up colors.
    this.applyMeshColorVariables();
  }

  private applyMeshColorVariables(): void {
    const files = this.app.vault.getMarkdownFiles();
    const styleId = "lyt-pod-manager-mesh-colors";
    let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;
    if (styleEl === null) {
      styleEl = document.createElement("style");
      styleEl.id = styleId;
      document.head.appendChild(styleEl);
    }
    const rules: string[] = [];
    for (const f of files) {
      if (!f.path.startsWith("meshes/")) continue;
      const meta = this.app.metadataCache.getFileCache(f);
      const fm = meta?.frontmatter as Record<string, unknown> | undefined;
      if (!fm) continue;
      const kind = String(fm["vault.kind"] ?? "");
      if (kind !== POD_MAP_MESH_NOTE_KIND) continue;
      const meshName = String(fm["mesh-name"] ?? f.basename);
      const hue = this.hueForMesh(meshName);
      const safeBase = cssEscapeIdent(f.basename);
      rules.push(
        `.graph-view.color-fill[data-path-basename="${safeBase}"] { --lyt-mesh-hue: ${hue}; }`,
      );
    }
    styleEl.textContent = rules.join("\n");
  }

  // Deterministic hash → HSL hue 0..360. Uses a small FNV-1a variant so
  // a future API change doesn't suddenly recolor the user's pod.
  private hueForMesh(meshName: string): number {
    const cached = this.meshHueCache.get(meshName);
    if (cached !== undefined) return cached;
    let hash = 2166136261;
    for (let i = 0; i < meshName.length; i++) {
      hash ^= meshName.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const hue = ((hash >>> 0) % 360);
    this.meshHueCache.set(meshName, hue);
    return hue;
  }
}

// CSS identifier escape — bounded to alphanumerics + hyphen + underscore
// (mesh-note basenames are slugged by the generator; this is defence
// in depth so a future generator change can't accidentally inject
// arbitrary CSS).
function cssEscapeIdent(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}
