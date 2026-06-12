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

// Pattern YON parser — handles pattern.yon files with @PATTERN + @VERB records.
// Used by lyt pattern verbs/run/list to introspect installed patterns.

export interface PatternRecord {
  id: string;
  name: string;
  version: string;
}

export interface VerbRecord {
  id: string;
  template: string;
  pathGlob: string;
}

export interface ParsedPattern {
  pattern: PatternRecord | null;
  verbs: VerbRecord[];
}

export function parsePatternYon(content: string): ParsedPattern {
  return {
    pattern: parsePatternRec(content),
    verbs: parseVerbRecs(content),
  };
}

function parsePatternRec(content: string): PatternRecord | null {
  const m = content.match(/^@PATTERN\s+(.+)$/m);
  if (!m) return null;
  const body = m[1]!;
  const id = readQuoted(body, "id") ?? readBare(body, "id");
  const name = readQuoted(body, "name") ?? readBare(body, "name");
  const version = readQuoted(body, "version") ?? readBare(body, "version");
  if (id === null || name === null || version === null) return null;
  return { id, name, version };
}

function parseVerbRecs(content: string): VerbRecord[] {
  const re = /^@VERB\s+(.+)$/gm;
  const out: VerbRecord[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const body = m[1]!;
    const id = readQuoted(body, "id") ?? readBare(body, "id");
    const template = readQuoted(body, "template") ?? readBare(body, "template");
    const pathGlob = readQuoted(body, "path-glob") ?? readBare(body, "path-glob");
    if (id === null || template === null || pathGlob === null) continue;
    out.push({ id, template, pathGlob });
  }
  return out;
}

function readQuoted(body: string, key: string): string | null {
  const re = new RegExp(`(?:^|\\|)\\s*${escapeRegex(key)}="((?:\\\\.|[^"\\\\])*)"`);
  const m = body.match(re);
  if (!m) return null;
  return unescape(m[1]!);
}

function readBare(body: string, key: string): string | null {
  const re = new RegExp(`(?:^|\\|)\\s*${escapeRegex(key)}=([^\\s|"]+)`);
  const m = body.match(re);
  if (!m) return null;
  return m[1]!;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unescape(s: string): string {
  return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
