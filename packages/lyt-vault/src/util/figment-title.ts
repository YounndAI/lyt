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

// Phase D — title-aware lexical indexing. The Figment contract emits `title`
// as a top-level scalar in the leading frontmatter block. Parse only that exact
// key, unquote the contract's JSON/YAML-compatible quoted form, normalize line
// whitespace, and fail closed to an empty title on malformed input.
export function parseFigmentTitle(raw: string): string {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return "";
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "---") break;
    const match = /^title:\s*(.*)$/.exec(line);
    if (match === null) continue;
    const value = match[1]!.trim();
    if (value.length === 0 || value === "null" || value === "~") return "";
    if (value.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(value);
        return typeof parsed === "string" ? parsed.replace(/\s+/g, " ").trim() : "";
      } catch {
        return "";
      }
    }
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      return value.slice(1, -1).replace(/''/g, "'").replace(/\s+/g, " ").trim();
    }
    if (/^[\[{]/.test(value)) return "";
    return value.replace(/\s+/g, " ").trim();
  }
  return "";
}
