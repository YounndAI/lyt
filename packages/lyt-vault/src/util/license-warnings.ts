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

import type { DetectedLicense, LicenseBucket } from "./license-detect.js";

// v1.B.6 — license-aware federation warning helper per the ratified default. Used by
// publishMeshFlow (informational surface) and (v1.C.2) mesh-subscribe.
// Compares publisher's LICENSE bucket against subscriber's federation
// LICENSE bucket; warns on copyleft-into-permissive AND
// permissive-into-copyleft mismatch.
//
// Full SPDX-aware comparison deferred to v1.5+ per DQ-new-20; v1.B.6
// ships heuristic-only (bucket-on-bucket).
//
// `unknown` buckets never trigger warnings — surfacing a warning for an
// unparseable LICENSE would be noise more than signal. Publishers
// surface unknowns via `lyt vault info --json licensePosture.license` for
// human eyeballs.

export type LicenseWarningKind = "copyleft-into-permissive" | "permissive-into-copyleft";

export interface LicenseFederationWarning {
  warning: boolean;
  kind: LicenseWarningKind | null;
  publisherLicense: string | null;
  publisherBucket: LicenseBucket;
  subscriberLicense: string | null;
  subscriberBucket: LicenseBucket;
  message: string;
}

export function checkFederationLicenseCompatibility(
  publisher: DetectedLicense,
  subscriber: DetectedLicense,
): LicenseFederationWarning {
  const base = {
    publisherLicense: publisher.id,
    publisherBucket: publisher.bucket,
    subscriberLicense: subscriber.id,
    subscriberBucket: subscriber.bucket,
  };

  if (publisher.bucket === "unknown" || subscriber.bucket === "unknown") {
    return {
      ...base,
      warning: false,
      kind: null,
      message: "license bucket(s) unknown — no automated comparison performed",
    };
  }

  if (publisher.bucket === "copyleft" && subscriber.bucket === "permissive") {
    return {
      ...base,
      warning: true,
      kind: "copyleft-into-permissive",
      message: `Federating copyleft (${publisher.id ?? "?"}) content into a permissive (${subscriber.id ?? "?"}) federation may impose share-alike obligations on derivative works. Review before subscribing.`,
    };
  }

  if (publisher.bucket === "permissive" && subscriber.bucket === "copyleft") {
    return {
      ...base,
      warning: true,
      kind: "permissive-into-copyleft",
      message: `Federating permissive (${publisher.id ?? "?"}) content into a copyleft (${subscriber.id ?? "?"}) federation is generally fine, but downstream redistribution may relicense the permissive content under the copyleft terms. Document attribution carefully.`,
    };
  }

  return {
    ...base,
    warning: false,
    kind: null,
    message: "license buckets compatible — no warning",
  };
}
