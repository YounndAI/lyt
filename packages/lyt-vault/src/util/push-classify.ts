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

// hardening pass / C1 (Cohort-1 fix-pass release review) — the ONE shared classifier for a
// failed `git push`. A push failure is TERMINAL (a re-run can never succeed)
// ONLY when its stderr carries a genuine PERMISSION / AUTH co-signal. A terminal
// failure is dropped from the resumable outbox (markOutboxDone) and surfaces one
// actionable line instead of the raw `fatal: unable to access …`. Everything
// else stays NON-terminal (retry-safe).
//
// C1 OVER-MATCH FIX (release review): the prior classifier matched a bare `\b403\b`
// and a bare `access rights`. Both are FALSE POSITIVES on transient failures —
// the outbox has NO retry cap, so the terminal branch is the ONLY drop path, and
// a false-positive terminal classification PERMANENTLY drops a retryable op:
// - bare `403` also fires on GitHub SECONDARY RATE-LIMITING over HTTPS push
// ("The requested URL returned error: 403" with retry-after) — transient.
// - bare `access rights` is the tail of git's generic SSH connection-failure
// message ("Please make sure you have the correct access rights and the
// repository exists.") emitted on timeout/DNS/host-down too — transient.
// So we REQUIRE a real permission/auth token. The asymmetry deliberately favors
// a RETRIED op over a DROPPED one: when uncertain, NON-terminal.
//
// SEE ALSO (this is the single copy — both push paths import it):
// - packages/lyt-mesh/src/flows/sync.ts (the `lyt sync` push attempt)
// - packages/lyt-vault/src/flows/federation/reconcile-publish.ts (the publish push)
// A unit/parity test lives at packages/lyt-vault/tests/util/push-classify.test.ts.

// Genuine permission / auth co-signals. Each is emitted ONLY when GitHub (or the
// transport) has actually rejected the credential or the user's push rights —
// none of these fire on a rate-limit blip or a connection failure.
const PERMISSION_TOKEN =
  /remote: Permission to .+ denied|Permission denied \(publickey\)|could not read Username|could not read Password|Authentication failed|fatal: Authentication failed|remote: Permission|remote: Write access to repository not granted/i;

// True when a `git push` stderr proves a TERMINAL permission/auth denial — the
// only case where a re-run can never succeed. Default (no permission token) is
// NON-terminal so a transient 403 rate-limit / SSH timeout is retried, never
// silently dropped from the capless outbox.
export function isPermissionDeniedPush(stderr: string): boolean {
  if (typeof stderr !== "string" || stderr.length === 0) return false;
  return PERMISSION_TOKEN.test(stderr);
}
