# ${vaultName}

<!-- LYT_README_BEGIN -->

> A **Lyt** vault — *Link Your Think*. Federated markdown knowledge you own, with AI agents as first-class operators.

This folder is a [Lyt](https://linkyourthink.com) vault: a Git-native store of plain markdown that can join a **mesh** of other vaults across people and organizations. The canonical bytes are your notes, versioned in Git; derived state — the search index and optional embeddings — lives under `.lyt/` and is fully rebuildable. Nothing is locked in, and you can leave at any time with your markdown intact.

**Lyt is AI-first by design.** Every vault and mesh speaks [YON](https://yon.younndai.com) — structured records any agent reads directly — and the same operations run from the CLI or through an AI harness. Mint vaults you own, weave meshes you share, forge Your Pod.

Lyt only ever **adds** its own files — the `.lyt/` folder, and this README if you didn't already have one — and edits only the regions it marks (this `LYT_README_BEGIN`/`LYT_README_END` block and Lyt-managed frontmatter). **Your existing notes are never modified**, and every change Lyt makes is a plain-text diff in Git you can review. Edit freely outside the markers.

---

- **Website** — [linkyourthink.com](https://linkyourthink.com)
- **Install** — `npm install -g @younndai/lyt` &nbsp;·&nbsp; [npm](https://www.npmjs.com/package/@younndai/lyt)
- **Source** — [github.com/YounndAI/lyt](https://github.com/YounndAI/lyt) &nbsp;·&nbsp; Apache-2.0
- Built by [YounndAI](https://younndai.com)

<!-- LYT_README_END -->
