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

import { formatRepoDescription, mergeTopics } from "./github-defaults.js";

export interface RepoCreateArgs {
  owner: string;
  name: string;
  description: string;
  topics: readonly string[];
}

export interface RepoEditArgs {
  owner: string;
  name: string;
  description: string;
  topics: readonly string[];
}

export function buildRepoCreateArgs(
  owner: string,
  name: string,
  userDescription: string | undefined | null,
  extraTopics: readonly string[] | undefined | null,
): RepoCreateArgs {
  return {
    owner,
    name,
    description: formatRepoDescription(userDescription),
    topics: mergeTopics(extraTopics),
  };
}

export function buildRepoEditArgs(
  owner: string,
  name: string,
  userDescription: string | undefined | null,
  extraTopics: readonly string[] | undefined | null,
): RepoEditArgs {
  return {
    owner,
    name,
    description: formatRepoDescription(userDescription),
    topics: mergeTopics(extraTopics),
  };
}

export function ghRepoCreateCommand(args: RepoCreateArgs): string {
  const topicFlags = args.topics.map((t) => `--add-topic ${shellQuote(t)}`).join(" ");
  return `gh repo create ${shellQuote(`${args.owner}/${args.name}`)} --description ${shellQuote(args.description)} ${topicFlags}`.trim();
}

export function ghRepoEditCommand(args: RepoEditArgs): string {
  const topicFlags = args.topics.map((t) => `--add-topic ${shellQuote(t)}`).join(" ");
  return `gh repo edit ${shellQuote(`${args.owner}/${args.name}`)} --description ${shellQuote(args.description)} ${topicFlags}`.trim();
}

function shellQuote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}
