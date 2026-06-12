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

import {
  publishMeshFlow,
  PublishMeshNotFoundError,
  PublishMeshStrictFailureError,
} from "../flows/mesh-publish.js";

// v1.B.6 — `lyt mesh publish <mesh> [--description <text>] [--no-set-topic]
// [--no-license-check] [--no-hygiene] [--strict] [--json]`. Meta-verb that
// composes four sub-actions per lyt-public-mesh §2.1.

interface PublishCliOpts {
  description?: string;
  setTopic?: boolean;
  licenseCheck?: boolean;
  hygiene?: boolean;
  strict?: boolean;
  json?: boolean;
}

export function buildMeshPublishSubcommand(): Command {
  return new Command("publish")
    .description(
      "v1.B.6: publish a mesh as a public-mesh — sets GH topic lyt-public on the main vault repo, validates LICENSE presence, runs public_mesh_hygiene scan, emits canonical discovery URL.",
    )
    .argument("<mesh>", "Mesh name (must be registered locally)")
    .option(
      "--description <text>",
      "Publisher-declared description of the mesh — required on first publish (provisions @MESH_PUBLIC). Subsequent publishes preserve existing @MESH_PUBLIC metadata.",
    )
    .option("--no-set-topic", "Skip the gh repo edit --add-topic lyt-public step")
    .option("--no-license-check", "Skip the LICENSE-file presence check")
    .option("--no-hygiene", "Skip the public_mesh_hygiene scan")
    .option("--strict", "Convert warnings to hard failures (exit 1 on any sub-action warn/fail)")
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (meshName: string, opts: PublishCliOpts) => {
      try {
        const result = await publishMeshFlow({
          meshName,
          ...(opts.description !== undefined ? { description: opts.description } : {}),
          noSetTopic: opts.setTopic === false,
          noLicenseCheck: opts.licenseCheck === false,
          noHygiene: opts.hygiene === false,
          strict: opts.strict === true,
        });

        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify(
              {
                mesh: {
                  name: result.meshName,
                  rid_hex: result.meshRidHex,
                  push_target: result.pushTarget,
                },
                discovery_url: result.discoveryUrl,
                sub_actions: result.subActions,
                license_posture: result.licensePosture,
                hygiene_findings: result.hygieneFindings.map((f) => ({
                  id: f.id,
                  status: f.status,
                  message: f.message,
                })),
                duration_ms: result.durationMs,
              },
              null,
              2,
            ),
          );
          return;
        }

        // Human-readable output.
        // eslint-disable-next-line no-console
        console.log(`Published mesh '${result.meshName}' (mesh:${result.meshRidHex})`);
        for (const sa of result.subActions) {
          const marker =
            sa.status === "ok"
              ? "✓"
              : sa.status === "skipped"
                ? "↷"
                : sa.status === "warn"
                  ? "⚠"
                  : "✗";
          // eslint-disable-next-line no-console
          console.log(`  ${marker} ${sa.action}: ${sa.message}`);
        }
        if (result.discoveryUrl !== null) {
          // eslint-disable-next-line no-console
          console.log(`  Share: ${result.discoveryUrl}`);
        }
      } catch (err) {
        const status = mapErrorToExitCode(err);
        const body = errorToJsonBody(err);
        emitError(opts.json === true, body);
        process.exitCode = status ?? 1;
      }
    });
}

function mapErrorToExitCode(err: unknown): number | null {
  if (err instanceof PublishMeshNotFoundError) return 2;
  if (err instanceof PublishMeshStrictFailureError) return 1;
  return null;
}

function errorToJsonBody(err: unknown): Record<string, unknown> {
  if (err instanceof PublishMeshNotFoundError) {
    return { error: err.errorCode, mesh_name: err.meshName, message: err.message };
  }
  if (err instanceof PublishMeshStrictFailureError) {
    return { error: err.errorCode, reasons: err.reasons, message: err.message };
  }
  return { error: "unknown", message: err instanceof Error ? err.message : String(err) };
}

function emitError(json: boolean, body: Record<string, unknown>): void {
  if (json) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(body, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.error(`lyt mesh publish: ${String(body["message"] ?? body["error"])}`);
  }
}
