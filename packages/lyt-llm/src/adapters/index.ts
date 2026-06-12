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

// Adapter barrel — re-export every concrete adapter + its config + the
// per-adapter error types. Callers (and the brief's gold-standard smoke test
// from block-B Commit 7) reach the adapters through the package root index
// for a single import statement.

export {
  createAiRelayAdapter,
  type AiRelayAdapterConfig,
  type AiRelayGenerateFn,
  type AiRelayEmbedFn,
} from "./ai-relay.js";

export {
  createOllamaAdapter,
  OllamaUnreachableError,
  OllamaHttpError,
  type OllamaAdapterConfig,
  type FetchLike,
} from "./ollama.js";

export {
  createHarnessAdapter,
  type HarnessAdapterConfig,
  type HarnessInvokeArgs,
  type HarnessInvokeResult,
  type HarnessInvokeFn,
} from "./harness.js";

export { createByokAdapter, type ByokAdapterConfig, type ByokClient } from "./byok.js";
