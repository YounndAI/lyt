---
name: lyt-create
description: >
  Create a new Lyt mesh or vault through the supported CLI and report its Receipt V1. Trigger when the Handler says "create a mesh", "create a vault", "start a local vault", or names a GitHub destination for a new mesh or vault. Existing directories route to /lyt-adopt; durable notes route to /lyt-capture. Creation checkpoints exact local files but never publishes or invents an alias.
visibility: public
skill-version: 1.0.0
requires-lyt: ">=0.20.0 <0.21.0"
contract-version: 1.0.0
lyt-version: 0.20.0
capabilities: [write]
runtimes: [claude, codex, agents]
requires_writable_vault: false
---

# /lyt-create

Create one new mesh or vault using Lyt's existing creation commands. This skill resolves intent, invokes the CLI, and explains its Receipt V1; it does not recreate destination policy, Git, GitHub, checkpoint, or publication logic.

## Route the request

- New mesh: `lyt mesh init <name> ... --json`.
- New vault: `lyt vault init <mesh>/<vault> ... --json`.
- Existing directory: stop and use `/lyt-adopt`.
- Durable note: stop and use `/lyt-capture`.
- Inspection only: use `/lyt-mesh-explore` or `/lyt-pod`.

If mesh versus vault is ambiguous, ask once. Never infer a GitHub owner from the mesh name.

## Resolve destination intent

- Explicit GitHub destination: pass `--target github:user/<owner>` or `--target github:org/<owner>`.
- Explicit local-only intent: pass `--local`.
- No explicit destination: let Lyt apply its authenticated default or local fallback and report the result. Do not substitute your own policy.
- A new vault snapshots its mesh destination unless the Handler explicitly supplies a vault override.

Creation is editor-neutral. Add `--template obsidian-default` only when the Handler explicitly asks for Obsidian.

## Consume the result

Use `--json`. Read the terminal Receipt V1 `status`, mutation counts, destination evidence, exact checkpoint evidence, and `next-sync` evidence. Read `next_action` only when it is non-null (successful creation receipts normally set it to null). Report what exists locally, whether creation published anything, and the exact scoped sync command from evidence. If the destination policy source is needed, inspect it afterward with read-only `lyt vault info <name> --json` or `lyt mesh info <name> --json`; Receipt V1 does not carry that source field. Offer sync when appropriate; never run it silently.

If the result is local-only, recommend configuring an online destination for safety, reliability, and redundancy. Never use raw Git or `gh`, never auto-create an alias, and never claim publication from a creation receipt.
