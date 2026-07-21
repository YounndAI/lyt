/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 * Licensed under the Apache License, Version 2.0.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

import type { Runtime } from "@younndai/lyt-skills";

import type { InstallProviderV1, InstallableProviderObjectV1 } from "./provider-inventory.js";
import { assertPathChainHasNoLinks } from "./reconcile-engine.js";
import {
  canonicalJson,
  digestCanonical,
  UPDATE_PLAN_PACKAGES,
  type TargetArtifactV1,
  type UpdatePackageName,
  type UpdatePlanV1,
} from "./update-plan.js";

const MAX_TARBALL_BYTES = 16 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
const MAX_INSTALLED_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10_000;
const SHA256 = /^[a-f0-9]{64}$/;
const PROVIDER_OWNERS = new Map<UpdatePackageName, "directory-link" | "marker-file">([
  ["@younndai/lyt-skills", "directory-link"],
  ["@younndai/lyt-vault", "marker-file"],
]);

type TarEntry = Readonly<{ path: string; bytes: Buffer }>;

export interface TargetProviderManifestV1 {
  readonly schema_id: "lyt.target-provider-manifest";
  readonly schema_version: Readonly<{ major: 1; minor: 0 }>;
  readonly package: UpdatePackageName;
  readonly version: string;
  readonly objects: readonly (
    | Readonly<{
        kind: "directory-link";
        runtime: Runtime;
        name: string;
        source_relative_path: string;
        expected_digest: string;
      }>
    | Readonly<{
        kind: "marker-file";
        runtime: Runtime;
        content: string;
        expected_digest: string;
        marker_begin: string;
        marker_end: string;
      }>
  )[];
}

export interface InspectedTargetArtifactV1 {
  readonly artifact: TargetArtifactV1;
  readonly provider_manifest: TargetProviderManifestV1 | null;
}

export interface InstalledStateAnchorV1 {
  readonly schema_id: "lyt.installed-state-anchor";
  readonly schema_version: Readonly<{ major: 1; minor: 0 }>;
  readonly plan_digest: string;
  readonly target_version: string;
  readonly package_payloads: readonly Readonly<{ package: UpdatePackageName; digest: string }>[];
  readonly provider_destinations: readonly Readonly<{ object_id: string; digest: string }>[];
  readonly anchor_digest: string;
}

export type InstalledStateAnchorReadV1 =
  | Readonly<{ status: "missing" | "invalid"; anchor: null }>
  | Readonly<{ status: "present"; anchor: InstalledStateAnchorV1 }>;

export type InstalledStateAnchorVerificationV1 = Readonly<{
  status: "missing" | "invalid" | "match" | "mismatch";
  mismatched_object_ids: readonly string[];
}>;

export type InstalledPackagePayloadStatusV1 =
  "match" | "missing" | "unreadable" | "unsafe" | "mismatch";

export interface InstalledPackagePayloadInspectionV1 {
  readonly package: UpdatePackageName;
  readonly root: string | null;
  readonly expected_digest: string;
  readonly observed_digest: string | null;
  readonly status: InstalledPackagePayloadStatusV1;
}

export function inspectTargetTarballBytes(args: {
  package: UpdatePackageName;
  version: string;
  integrity: string;
  tarballUrl: string;
  bytes: Uint8Array;
}): InspectedTargetArtifactV1 {
  const compressed = Buffer.from(args.bytes);
  if (compressed.byteLength === 0 || compressed.byteLength > MAX_TARBALL_BYTES) {
    throw new Error("update-target-tarball-size");
  }
  const actualSri = `sha512-${createHash("sha512").update(compressed).digest("base64")}`;
  if (actualSri !== args.integrity) throw new Error("update-target-tarball-sri-mismatch");
  const entries = parseTar(gunzipSync(compressed, { maxOutputLength: MAX_UNPACKED_BYTES }));
  const packageJson = entry(entries, "package/package.json");
  const identity = JSON.parse(packageJson.bytes.toString("utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (identity.name !== args.package || identity.version !== args.version) {
    throw new Error("update-target-tarball-identity-mismatch");
  }
  const files = entries
    .filter((item) => item.path.startsWith("package/") && item.path !== "package/")
    .map((item) => ({
      path: item.path.slice("package/".length),
      digest: createHash("sha256").update(item.bytes).digest("hex"),
      size: item.bytes.byteLength,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const providers = entries.filter(
    (item) => item.path === "package/dist/install-provider-manifest.json",
  );
  if (providers.length > 1) throw new Error("update-target-provider-manifest-duplicate");
  const provider = providers[0];
  const expectedKind = PROVIDER_OWNERS.get(args.package);
  if (expectedKind !== undefined && provider === undefined) {
    throw new Error("update-target-provider-manifest-missing");
  }
  if (expectedKind === undefined && provider !== undefined) {
    throw new Error("update-target-provider-manifest-unexpected-owner");
  }
  const providerManifest =
    provider === undefined
      ? null
      : parseTargetProviderManifest(
          JSON.parse(provider.bytes.toString("utf8")),
          args.package,
          args.version,
          files,
        );
  return Object.freeze({
    artifact: Object.freeze({
      package: args.package,
      version: args.version,
      integrity: args.integrity,
      tarball_url: args.tarballUrl,
      payload_digest: digestCanonical(files),
      files: Object.freeze(files.map((file) => Object.freeze(file))),
    }),
    provider_manifest: providerManifest,
  });
}

export function materializeTargetProviders(args: {
  manifests: readonly TargetProviderManifestV1[];
  extractedRoots: ReadonlyMap<UpdatePackageName, string>;
  homeDir: string;
  runtimes: readonly Runtime[];
}): readonly InstallProviderV1[] {
  assertProviderManifestSet(args.manifests);
  const manifests = new Map(args.manifests.map((manifest) => [manifest.package, manifest]));
  const runtimeSet = new Set(args.runtimes);
  return Object.freeze(
    UPDATE_PLAN_PACKAGES.map((packageName) => {
      const manifest = manifests.get(packageName);
      const objects: InstallableProviderObjectV1[] = [];
      for (const object of manifest?.objects ?? []) {
        if (!runtimeSet.has(object.runtime)) continue;
        if (object.kind === "directory-link") {
          const source = join(
            args.extractedRoots.get(packageName) ?? "missing-target-package",
            ...object.source_relative_path.split("/"),
          );
          objects.push(
            Object.freeze({
              object_id: `skill:${object.runtime}:${object.name}`,
              kind: "directory-link",
              provider_package: manifest!.package as "@younndai/lyt-skills",
              provider_version: manifest!.version,
              source_path: source,
              target_path: join(args.homeDir, `.${object.runtime}`, "skills", object.name),
              expected_digest: object.expected_digest,
              trusted_legacy_digests: Object.freeze([]),
            }),
          );
        } else {
          objects.push(
            Object.freeze({
              object_id: `manual:${object.runtime}`,
              kind: "marker-file",
              provider_package: manifest!.package as "@younndai/lyt-vault",
              provider_version: manifest!.version,
              target_path: runtimeManualPath(args.homeDir, object.runtime),
              content: object.content,
              expected_digest: object.expected_digest,
              marker_begin: object.marker_begin,
              marker_end: object.marker_end,
              trusted_legacy_digests: Object.freeze([]),
            }),
          );
        }
      }
      return Object.freeze({
        schema_id: "lyt.install-provider" as const,
        schema_version: Object.freeze({ major: 1 as const, minor: 0 as const }),
        package: packageName,
        version: manifest?.version ?? args.manifests[0]?.version ?? "0.0.0",
        objects: Object.freeze(objects),
      });
    }),
  );
}

export function providersFromUpdatePlan(
  plan: UpdatePlanV1,
  packageRoots: ReadonlyMap<UpdatePackageName, string>,
): readonly InstallProviderV1[] {
  return Object.freeze(
    UPDATE_PLAN_PACKAGES.map((packageName) => {
      const objects = plan.target_provider_objects
        .filter((object) => object.provider_package === packageName)
        .map((object): InstallableProviderObjectV1 =>
          object.kind === "directory-link"
            ? Object.freeze({
                object_id: object.object_id,
                kind: "directory-link",
                provider_package: object.provider_package as "@younndai/lyt-skills",
                provider_version: object.provider_version,
                source_path: join(
                  packageRoots.get(packageName) ?? "missing-target-package",
                  ...(object.source_relative_path ?? "missing").split("/"),
                ),
                target_path: object.target_path,
                expected_digest: object.expected_digest,
                trusted_legacy_digests: Object.freeze([]),
              })
            : Object.freeze({
                object_id: object.object_id,
                kind: "marker-file",
                provider_package: object.provider_package as "@younndai/lyt-vault",
                provider_version: object.provider_version,
                target_path: object.target_path,
                content: object.content ?? "",
                expected_digest: object.expected_digest,
                marker_begin: object.marker_begin ?? "",
                marker_end: object.marker_end ?? "",
                trusted_legacy_digests: Object.freeze([]),
              }),
        );
      return Object.freeze({
        schema_id: "lyt.install-provider" as const,
        schema_version: Object.freeze({ major: 1 as const, minor: 0 as const }),
        package: packageName,
        version: plan.target_version,
        objects: Object.freeze(objects),
      });
    }),
  );
}

export async function stageTargetArtifactsV1(
  plan: UpdatePlanV1,
  root: string,
  fetchBytes: (url: string) => Promise<Uint8Array> = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`update-target-fetch-${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  },
): Promise<readonly string[]> {
  const stage = resolve(root, "operations", plan.operation_id, "artifacts");
  assertPathChainHasNoLinks(stage, true);
  mkdirSync(stage, { recursive: true });
  const paths: string[] = [];
  for (const artifact of plan.target_artifacts) {
    const path = join(
      stage,
      `${artifact.package.slice("@younndai/".length)}-${artifact.version}.tgz`,
    );
    assertPathChainHasNoLinks(path, true);
    const bytes = existsSync(path)
      ? readFileSync(path)
      : Buffer.from(await fetchBytes(artifact.tarball_url));
    const inspected = inspectTargetTarballBytes({
      package: artifact.package,
      version: artifact.version,
      integrity: artifact.integrity,
      tarballUrl: artifact.tarball_url,
      bytes,
    });
    if (canonicalJson(inspected.artifact) !== canonicalJson(artifact)) {
      throw new Error("update-target-staged-payload-mismatch");
    }
    if (!existsSync(path)) {
      const partial = `${path}.${process.pid}.partial`;
      assertPathChainHasNoLinks(partial, true);
      try {
        writeFileSync(partial, bytes, { flag: "wx" });
        renameSync(partial, path);
      } finally {
        if (existsSync(partial)) unlinkSync(partial);
      }
    }
    paths.push(path);
  }
  return Object.freeze(paths);
}

export function verifyInstalledPayloadV1(root: string, artifact: TargetArtifactV1): boolean {
  try {
    const observed = listInstalledFiles(resolve(root));
    return canonicalJson(observed) === canonicalJson(artifact.files);
  } catch {
    return false;
  }
}

export function inspectInstalledPayloadRootV1(
  root: string,
  expectedDigest: string,
  packageName: UpdatePackageName,
): InstalledPackagePayloadInspectionV1 {
  const absolute = resolve(root);
  if (!SHA256.test(expectedDigest)) {
    return Object.freeze({
      package: packageName,
      root: absolute,
      expected_digest: expectedDigest,
      observed_digest: null,
      status: "unreadable",
    });
  }
  if (!existsSync(absolute)) {
    return Object.freeze({
      package: packageName,
      root: absolute,
      expected_digest: expectedDigest,
      observed_digest: null,
      status: "missing",
    });
  }
  try {
    const observed = digestCanonical(listInstalledFiles(absolute));
    return Object.freeze({
      package: packageName,
      root: absolute,
      expected_digest: expectedDigest,
      observed_digest: observed,
      status: observed === expectedDigest ? "match" : "mismatch",
    });
  } catch (error) {
    const message = String(error);
    const unsafe = message.includes("symlink") || message.includes("reparse");
    return Object.freeze({
      package: packageName,
      root: absolute,
      expected_digest: expectedDigest,
      observed_digest: null,
      status: unsafe ? "unsafe" : "unreadable",
    });
  }
}

export function inspectInstalledPackagePayloadsV1(
  anchor: InstalledStateAnchorV1,
  resolveRoot: (packageName: UpdatePackageName) => string | null = resolveInstalledPackageRoot,
): readonly InstalledPackagePayloadInspectionV1[] {
  const expected = new Map(anchor.package_payloads.map((entry) => [entry.package, entry.digest]));
  return Object.freeze(
    UPDATE_PLAN_PACKAGES.map((packageName) => {
      const digest = expected.get(packageName);
      if (digest === undefined) {
        return Object.freeze({
          package: packageName,
          root: null,
          expected_digest: "",
          observed_digest: null,
          status: "unreadable" as const,
        });
      }
      let root: string | null;
      try {
        root = resolveRoot(packageName);
      } catch {
        root = null;
        return Object.freeze({
          package: packageName,
          root,
          expected_digest: digest,
          observed_digest: null,
          status: "unreadable" as const,
        });
      }
      return root === null
        ? Object.freeze({
            package: packageName,
            root,
            expected_digest: digest,
            observed_digest: null,
            status: "missing" as const,
          })
        : inspectInstalledPayloadRootV1(root, digest, packageName);
    }),
  );
}

export function resolveInstalledPackageRoot(packageName: UpdatePackageName): string | null {
  const require = createRequire(import.meta.url);
  const manifest = (require.resolve.paths(packageName) ?? [])
    .map((base) => join(base, ...packageName.split("/"), "package.json"))
    .find((candidate) => existsSync(candidate));
  return manifest === undefined ? null : dirname(manifest);
}

export function installedStateAnchorPath(root: string): string {
  return join(resolve(root), "installed-state-anchor.json");
}

export function writeInstalledStateAnchorV1(
  plan: UpdatePlanV1,
  root: string,
): InstalledStateAnchorV1 {
  const path = installedStateAnchorPath(root);
  assertPathChainHasNoLinks(path, true);
  mkdirSync(dirname(path), { recursive: true });
  const payload = {
    schema_id: "lyt.installed-state-anchor",
    schema_version: Object.freeze({ major: 1, minor: 0 }),
    plan_digest: plan.plan_digest,
    target_version: plan.target_version,
    package_payloads: Object.freeze(
      plan.target_artifacts.map((artifact) =>
        Object.freeze({ package: artifact.package, digest: artifact.payload_digest }),
      ),
    ),
    provider_destinations: Object.freeze(
      plan.target_provider_objects.map((object) =>
        Object.freeze({ object_id: object.object_id, digest: object.expected_applied_digest }),
      ),
    ),
  } as const;
  const anchor: InstalledStateAnchorV1 = Object.freeze({
    ...payload,
    anchor_digest: digestCanonical(payload),
  });
  const temporary = `${path}.${process.pid}.partial`;
  assertPathChainHasNoLinks(temporary, true);
  try {
    writeFileSync(temporary, `${JSON.stringify(anchor, null, 2)}\n`, { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return anchor;
}

export function readInstalledStateAnchorV1(root: string): InstalledStateAnchorReadV1 {
  const path = installedStateAnchorPath(root);
  if (!existsSync(path)) return Object.freeze({ status: "missing", anchor: null });
  try {
    assertPathChainHasNoLinks(path, true);
    const value = JSON.parse(readFileSync(path, "utf8")) as InstalledStateAnchorV1;
    if (
      value.schema_id !== "lyt.installed-state-anchor" ||
      value.schema_version?.major !== 1 ||
      value.schema_version?.minor !== 0 ||
      JSON.stringify(Object.keys(value).sort()) !==
        JSON.stringify(
          [
            "anchor_digest",
            "package_payloads",
            "plan_digest",
            "provider_destinations",
            "schema_id",
            "schema_version",
            "target_version",
          ].sort(),
        ) ||
      !SHA256.test(value.plan_digest) ||
      !SHA256.test(value.anchor_digest) ||
      !Array.isArray(value.package_payloads) ||
      value.package_payloads.length !== 7 ||
      !Array.isArray(value.provider_destinations) ||
      value.package_payloads.some((entry) => !SHA256.test(entry.digest)) ||
      value.provider_destinations.some((entry) => !entry.object_id || !SHA256.test(entry.digest))
    )
      return Object.freeze({ status: "invalid", anchor: null });
    const { anchor_digest: anchorDigest, ...payload } = value;
    if (digestCanonical(payload) !== anchorDigest)
      return Object.freeze({ status: "invalid", anchor: null });
    return Object.freeze({ status: "present", anchor: Object.freeze(value) });
  } catch {
    return Object.freeze({ status: "invalid", anchor: null });
  }
}

export function verifyInstalledStateAnchorV1(
  root: string,
  observedProviderDigests: ReadonlyMap<string, string | null>,
): InstalledStateAnchorVerificationV1 {
  const read = readInstalledStateAnchorV1(root);
  if (read.status !== "present") {
    return Object.freeze({ status: read.status, mismatched_object_ids: Object.freeze([]) });
  }
  const mismatched = read.anchor.provider_destinations
    .filter((entry) => observedProviderDigests.get(entry.object_id) !== entry.digest)
    .map((entry) => entry.object_id)
    .sort();
  return Object.freeze({
    status: mismatched.length === 0 ? "match" : "mismatch",
    mismatched_object_ids: Object.freeze(mismatched),
  });
}

function listInstalledFiles(
  root: string,
): readonly { path: string; digest: string; size: number }[] {
  assertPathChainHasNoLinks(root, true);
  const files: { path: string; digest: string; size: number }[] = [];
  let totalBytes = 0;
  const walk = (dir: string, prefix: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (prefix.length === 0 && item.name === "node_modules") continue;
      const path = join(dir, item.name);
      const relative = prefix.length === 0 ? item.name : `${prefix}/${item.name}`;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("update-installed-payload-symlink");
      if (stat.isDirectory()) walk(path, relative);
      else if (stat.isFile()) {
        totalBytes += stat.size;
        if (totalBytes > MAX_INSTALLED_BYTES)
          throw new Error("update-installed-payload-byte-limit");
        files.push({
          path: relative,
          digest: createHash("sha256").update(readFileSync(path)).digest("hex"),
          size: stat.size,
        });
      }
      if (files.length > MAX_FILES) throw new Error("update-installed-payload-file-limit");
    }
  };
  walk(root, "");
  return Object.freeze(files);
}

function parseTargetProviderManifest(
  value: unknown,
  packageName: UpdatePackageName,
  version: string,
  files: readonly { path: string; digest: string; size: number }[],
): TargetProviderManifestV1 {
  const manifest = value as TargetProviderManifestV1;
  const expectedKind = PROVIDER_OWNERS.get(packageName);
  if (
    !manifest ||
    manifest.schema_id !== "lyt.target-provider-manifest" ||
    manifest.schema_version?.major !== 1 ||
    manifest.schema_version?.minor !== 0 ||
    manifest.package !== packageName ||
    manifest.version !== version ||
    !Array.isArray(manifest.objects) ||
    manifest.objects.length === 0 ||
    expectedKind === undefined ||
    JSON.stringify(Object.keys(manifest).sort()) !==
      JSON.stringify(["objects", "package", "schema_id", "schema_version", "version"].sort()) ||
    JSON.stringify(Object.keys(manifest.schema_version).sort()) !==
      JSON.stringify(["major", "minor"])
  ) {
    throw new Error("update-target-provider-manifest-invalid");
  }
  const objectIds = new Set<string>();
  const destinations = new Set<string>();
  for (const object of manifest.objects) {
    const objectId =
      object.kind === "directory-link"
        ? `skill:${object.runtime}:${object.name}`
        : `manual:${object.runtime}`;
    const destination =
      object.kind === "directory-link"
        ? `${object.runtime}/skills/${object.name}`
        : `${object.runtime}/manual`;
    if (
      object.kind !== expectedKind ||
      objectIds.has(objectId) ||
      destinations.has(destination) ||
      !["claude", "codex", "agents"].includes(object.runtime) ||
      !SHA256.test(object.expected_digest) ||
      (object.kind === "directory-link"
        ? !safeRelative(object.source_relative_path) ||
          !/^[a-z][a-z0-9-]*$/.test(object.name) ||
          object.source_relative_path !== `skills/${object.name}` ||
          JSON.stringify(Object.keys(object).sort()) !==
            JSON.stringify(
              ["expected_digest", "kind", "name", "runtime", "source_relative_path"].sort(),
            ) ||
          digestManifestSubtree(files, object.source_relative_path) !== object.expected_digest
        : object.kind !== "marker-file" ||
          typeof object.content !== "string" ||
          typeof object.marker_begin !== "string" ||
          typeof object.marker_end !== "string" ||
          object.marker_begin !== `<!-- lyt-manual v${version} BEGIN -->` ||
          object.marker_end !== `<!-- lyt-manual v${version} END -->` ||
          !object.content.includes(object.marker_begin) ||
          !object.content.includes(object.marker_end) ||
          JSON.stringify(Object.keys(object).sort()) !==
            JSON.stringify(
              [
                "content",
                "expected_digest",
                "kind",
                "marker_begin",
                "marker_end",
                "runtime",
              ].sort(),
            ) ||
          createHash("sha256").update(object.content).digest("hex") !== object.expected_digest)
    ) {
      throw new Error("update-target-provider-manifest-invalid");
    }
    objectIds.add(objectId);
    destinations.add(destination);
  }
  return Object.freeze(manifest);
}

function assertProviderManifestSet(manifests: readonly TargetProviderManifestV1[]): void {
  const packages = manifests.map((manifest) => manifest.package).sort();
  const expected = [...PROVIDER_OWNERS.keys()].sort();
  if (canonicalJson(packages) !== canonicalJson(expected)) {
    throw new Error("update-target-provider-manifest-set-invalid");
  }
  for (const manifest of manifests) {
    const expectedKind = PROVIDER_OWNERS.get(manifest.package);
    if (
      expectedKind === undefined ||
      manifest.objects.some((object) => object.kind !== expectedKind)
    ) {
      throw new Error("update-target-provider-manifest-owner-invalid");
    }
  }
}

function digestManifestSubtree(
  files: readonly { path: string; digest: string }[],
  root: string,
): string {
  const prefix = `${root.replace(/\/$/, "")}/`;
  const tree = new Map<string, string | Map<string, unknown>>();
  for (const file of files.filter((entry) => entry.path.startsWith(prefix))) {
    const parts = file.path.slice(prefix.length).split("/");
    let current = tree;
    for (const part of parts.slice(0, -1)) {
      const existing = current.get(part);
      if (typeof existing === "string") throw new Error("update-target-provider-manifest-invalid");
      if (existing instanceof Map) current = existing as Map<string, string | Map<string, unknown>>;
      else {
        const child = new Map<string, string | Map<string, unknown>>();
        current.set(part, child);
        current = child;
      }
    }
    const leaf = parts.at(-1);
    if (!leaf || current.has(leaf)) throw new Error("update-target-provider-manifest-invalid");
    current.set(leaf, file.digest);
  }
  if (tree.size === 0) throw new Error("update-target-provider-manifest-invalid");
  const digestTree = (node: Map<string, string | Map<string, unknown>>): string => {
    const hash = createHash("sha256");
    for (const name of [...node.keys()].sort()) {
      const child = node.get(name)!;
      hash.update(name, "utf8");
      hash.update("\0");
      hash.update(
        typeof child === "string"
          ? child
          : digestTree(child as Map<string, string | Map<string, unknown>>),
        "hex",
      );
    }
    return hash.digest("hex");
  };
  return digestTree(tree);
}

function parseTar(bytes: Buffer): readonly TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let overridePath: string | null = null;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = text(header.subarray(0, 100));
    const prefix = text(header.subarray(345, 500));
    const size = Number.parseInt(text(header.subarray(124, 136)).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_UNPACKED_BYTES)
      throw new Error("update-target-tar-invalid");
    const type = String.fromCharCode(header[156] ?? 0);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > bytes.length) throw new Error("update-target-tar-truncated");
    const body = bytes.subarray(bodyStart, bodyEnd);
    const rawPath = overridePath ?? (prefix ? `${prefix}/${name}` : name);
    overridePath = null;
    if (type === "x") overridePath = parsePaxPath(body);
    else if (type === "L") overridePath = text(body);
    else if (type === "0" || type === "\0" || type === "") {
      if (!safeRelative(rawPath)) throw new Error("update-target-tar-path");
      entries.push(Object.freeze({ path: rawPath, bytes: Buffer.from(body) }));
      if (entries.length > MAX_FILES) throw new Error("update-target-tar-file-limit");
    } else if (type !== "5") {
      throw new Error("update-target-tar-unsupported-entry");
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return Object.freeze(entries);
}

function parsePaxPath(bytes: Buffer): string | null {
  const match = /(?:^|\n)\d+ path=([^\n]+)\n/.exec(bytes.toString("utf8"));
  return match?.[1] ?? null;
}

function text(bytes: Uint8Array): string {
  const zero = bytes.indexOf(0);
  return Buffer.from(zero < 0 ? bytes : bytes.subarray(0, zero))
    .toString("utf8")
    .trim();
}

function entry(entries: readonly TarEntry[], path: string): TarEntry {
  const found = entries.find((candidate) => candidate.path === path);
  if (found === undefined) throw new Error("update-target-tar-required-entry-missing");
  return found;
}

function safeRelative(value: string): boolean {
  return (
    value.length > 0 &&
    value.length < 500 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function runtimeManualPath(home: string, runtime: Runtime): string {
  return join(home, `.${runtime}`, runtime === "claude" ? "CLAUDE.md" : "AGENTS.md");
}
