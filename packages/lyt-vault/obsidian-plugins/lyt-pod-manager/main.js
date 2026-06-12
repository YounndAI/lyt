"use strict";
// v1.G.10 Lyt Pod Manager Obsidian plugin — pre-compiled main.js for
// Obsidian to load directly (Obsidian's plugin loader reads main.js).
// Authoritative source is main.ts in this folder; when editing main.ts
// run `npm install && npm run build` to refresh this file, OR keep the
// two in sync by hand (this file is small enough that hand-sync is
// practical for the v1.5 alpha-close phase).
//
// Module shape: CommonJS exporting a default Plugin subclass. Obsidian's
// loader does `require("./main.js").default` at plugin enable time.

Object.defineProperty(exports, "__esModule", { value: true });

const obsidian = require("obsidian");

const POD_MAP_MESH_NOTE_KIND = "pod-map-mesh-note";
const POD_MAP_VAULT_NOTE_KIND = "pod-map-vault-note";

const DEFAULT_SETTINGS = {
  enableMeshColoring: true,
  enableWritableBadges: true,
};

class LytPodManagerPlugin extends obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    this.meshHueCache = new Map();
    this.writableCache = new Map();
  }

  async onload() {
    await this.loadSettings();

    const isPodMap = await this.detectPodMapVault();
    if (!isPodMap) return;

    new obsidian.Notice("Lyt Pod Manager active — pod-map vault detected.");

    if (this.settings.enableWritableBadges) {
      this.registerWritableBadges();
    }
    if (this.settings.enableMeshColoring) {
      this.registerMeshColoring();
    }

    // FUTURE: registerHoverButton(vaultNode, "Add edge", () => spawnLytCli(...))
    // FUTURE: registerHoverButton(meshNode, "Subscribe", () => spawnLytCli(...))
    // FUTURE: addCommand({ id: "validate-mesh", name: "Lyt: validate this mesh" })
    // FUTURE: addCommand({ id: "repair-mesh", name: "Lyt: repair this mesh" })
  }

  onunload() {
    this.meshHueCache.clear();
    this.writableCache.clear();
    // release review fix: DOM cleanup on disable.
    const styleEl = document.getElementById("lyt-pod-manager-mesh-colors");
    if (styleEl !== null) styleEl.remove();
    const leaves = this.app.workspace.getLeavesOfType("file-explorer");
    for (const leaf of leaves) {
      const containerEl = leaf.view.containerEl;
      const items = containerEl.querySelectorAll(".tree-item-self");
      for (const el of items) {
        el.removeClass("lyt-pod-manager-readonly");
      }
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async detectPodMapVault() {
    try {
      const raw = await this.app.vault.adapter.read(".lyt/vault.yon");
      // release review fix: anchor the match to a @VAULT YON record.
      return (
        /@VAULT\s+[^\n]*\bkind\s*=\s*pod-map/i.test(raw) ||
        /^vault\.kind:\s*pod-map/im.test(raw)
      );
    } catch (e) {
      return false;
    }
  }

  registerWritableBadges() {
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        const files = this.app.vault.getMarkdownFiles();
        for (const f of files) {
          if (!f.path.startsWith("vaults/")) continue;
          const meta = this.app.metadataCache.getFileCache(f);
          const fm = meta && meta.frontmatter;
          if (!fm) continue;
          const kind = String(fm["vault.kind"] || "");
          if (kind !== POD_MAP_VAULT_NOTE_KIND) continue;
          const writableRaw = String(fm["vault.writable"] != null ? fm["vault.writable"] : "unknown");
          const v =
            writableRaw === "true"
              ? "true"
              : writableRaw === "false"
                ? "false"
                : "unknown";
          this.writableCache.set(f.path, v);
        }
        this.refreshFileExplorerBadges();
      })
    );
  }

  refreshFileExplorerBadges() {
    const leaves = this.app.workspace.getLeavesOfType("file-explorer");
    for (const leaf of leaves) {
      const containerEl = leaf.view.containerEl;
      const items = containerEl.querySelectorAll(".tree-item-self");
      for (const el of items) {
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

  registerMeshColoring() {
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        this.applyMeshColorVariables();
      })
    );
    this.applyMeshColorVariables();
  }

  applyMeshColorVariables() {
    const files = this.app.vault.getMarkdownFiles();
    const styleId = "lyt-pod-manager-mesh-colors";
    let styleEl = document.getElementById(styleId);
    if (styleEl === null) {
      styleEl = document.createElement("style");
      styleEl.id = styleId;
      document.head.appendChild(styleEl);
    }
    const rules = [];
    for (const f of files) {
      if (!f.path.startsWith("meshes/")) continue;
      const meta = this.app.metadataCache.getFileCache(f);
      const fm = meta && meta.frontmatter;
      if (!fm) continue;
      const kind = String(fm["vault.kind"] || "");
      if (kind !== POD_MAP_MESH_NOTE_KIND) continue;
      const meshName = String(fm["mesh-name"] || f.basename);
      const hue = this.hueForMesh(meshName);
      const safeBase = cssEscapeIdent(f.basename);
      rules.push(
        ".graph-view.color-fill[data-path-basename=\"" +
          safeBase +
          "\"] { --lyt-mesh-hue: " +
          hue +
          "; }"
      );
    }
    styleEl.textContent = rules.join("\n");
  }

  hueForMesh(meshName) {
    const cached = this.meshHueCache.get(meshName);
    if (cached !== undefined) return cached;
    let hash = 2166136261;
    for (let i = 0; i < meshName.length; i++) {
      hash ^= meshName.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const hue = (hash >>> 0) % 360;
    this.meshHueCache.set(meshName, hue);
    return hue;
  }
}

function cssEscapeIdent(s) {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

exports.default = LytPodManagerPlugin;
module.exports = LytPodManagerPlugin;
module.exports.default = LytPodManagerPlugin;
