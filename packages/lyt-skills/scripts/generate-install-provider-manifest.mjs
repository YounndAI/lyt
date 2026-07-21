/* Copyright 2026 MARLINK TRADING SRL (YounndAI). Licensed under Apache-2.0. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const skillsRoot = fileURLToPath(new URL("skills/", root));
const digestTree = (path) => {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error("provider manifest refuses symlinks");
  if (stat.isFile()) return createHash("sha256").update(readFileSync(path)).digest("hex");
  const hash = createHash("sha256");
  for (const name of readdirSync(path).sort()) {
    hash
      .update(name)
      .update("\0")
      .update(digestTree(join(path, name)), "hex");
  }
  return hash.digest("hex");
};
const objects = [];
for (const runtime of ["agents", "claude", "codex"]) {
  for (const name of readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()) {
    objects.push({
      kind: "directory-link",
      runtime,
      name,
      source_relative_path: `skills/${name}`,
      expected_digest: digestTree(fileURLToPath(new URL(`skills/${name}/`, root))),
    });
  }
}
writeFileSync(
  new URL("dist/install-provider-manifest.json", root),
  `${JSON.stringify({ schema_id: "lyt.target-provider-manifest", schema_version: { major: 1, minor: 0 }, package: packageJson.name, version: packageJson.version, objects }, null, 2)}\n`,
);
