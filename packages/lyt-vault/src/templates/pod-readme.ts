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

// Phase C (UNIT 5) — pod-repo brand-grade README.
//
// The pod repo (`{handle}/lyt-pod`) anchors which meshes a handler participates
// in; its canonical content is `pod.yon` (the derived federation manifest). The
// README is brand-grade orientation copy with NO Figment seed — it is a managed
// document, not user content. It carries the scaffold-generation version stamp
// (a generation marker on a generated doc; NOT a user Figment body — SC9 keeps
// stamps out of user-authored files only).
//
// Managed-block bounded by LYT_POD_README_BEGIN / LYT_POD_README_END so a
// future regen can refresh the brand block while preserving any handler prose
// outside it. Written INIT-ONCE at federation forge (write-if-absent); doctor
// only warns if missing (surface-don't-act), mirroring the vault README posture.

export const POD_README_MANAGED_BEGIN = "<!-- LYT_POD_README_BEGIN -->";
export const POD_README_MANAGED_END = "<!-- LYT_POD_README_END -->";

export interface PodReadmeInput {
  /** The pod handle (GitHub owner), e.g. "alex". */
  handle: string;
  /** Scaffold-generation version stamp (AGENTS_MD_TEMPLATE_VERSION). */
  templateVersion: number;
}

/** Render the brand-grade pod-repo README with its managed block. */
export function renderPodReadme(input: PodReadmeInput): string {
  return (
    `# Lyt Pod — \`${input.handle}\`\n\n` +
    `${POD_README_MANAGED_BEGIN}\n\n` +
    `> The pod repo for \`${input.handle}\` — the anchor of your **Lyt** federation ` +
    `(scaffold v${input.templateVersion}).\n\n` +
    `Your **pod** is your set of Lyt vaults (each its own Git repo of Obsidian-flavoured ` +
    `markdown), grouped into **meshes**. This repo holds \`pod.yon\` — the derived ` +
    `manifest of which meshes and vaults make up your pod. You own the markdown; Lyt is ` +
    `the federation layer over it.\n\n` +
    `## What lives here\n\n` +
    `- \`pod.yon\` — the derived federation manifest (meshes + home vaults). Regenerated ` +
    `by Lyt; do not hand-edit.\n` +
    `- \`identity.yon\` — your pod identity, used to recover the pod on a fresh machine.\n` +
    `- \`ledger/\` — the pod-level sync ledger.\n\n` +
    `## Working with your pod\n\n` +
    `- \`lyt vault list\` / \`lyt mesh list\` — enumerate your pod.\n` +
    `- \`lyt sync\` — pull and push the pod and its vaults.\n` +
    `- \`lyt doctor\` — diagnose pod health.\n\n` +
    `Lyt edits only the regions it marks — frontmatter and the ` +
    `\`LYT_POD_README_BEGIN\`/\`LYT_POD_README_END\` managed block. Your prose is ` +
    `never touched, and every change Lyt makes is a plain-text diff in Git you can ` +
    `review. Edit freely outside the markers.\n\n` +
    `See [linkyourthink.com](https://linkyourthink.com).\n\n` +
    `${POD_README_MANAGED_END}\n`
  );
}
