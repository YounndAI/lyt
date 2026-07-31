/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const LYT_IGNORE_FILENAME = ".lytignore";

export type IgnoreMatcher = (vaultRelativePath: string) => boolean;

export interface LytIgnorePattern {
  line: number;
  source: string;
  negated: boolean;
  directoryOnly: boolean;
  regex: RegExp;
}

export interface LytIgnorePolicy {
  exists: boolean;
  path: string;
  bytes: Buffer;
  sha256: string;
  patterns: readonly LytIgnorePattern[];
  matcher: IgnoreMatcher;
}

export class LytIgnorePolicyError extends Error {
  readonly line: number | null;
  readonly pattern: string | null;

  constructor(message: string, line: number | null = null, pattern: string | null = null) {
    super(message);
    this.name = "LytIgnorePolicyError";
    this.line = line;
    this.pattern = pattern;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function escapeRegex(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

function globBodyToRegex(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        while (pattern[i + 1] === "*") i += 1;
        if (pattern[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(char);
    }
  }
  return out;
}

function compilePattern(sourceLine: string, line: number): LytIgnorePattern | null {
  if (sourceLine.length === 0 || /^\s*$/.test(sourceLine)) return null;
  if (/^(<<<<<<<|=======|>>>>>>>)(?:\s|$)/.test(sourceLine)) {
    throw new LytIgnorePolicyError(
      `.lytignore contains an unresolved policy conflict at line ${line}: ${sourceLine}`,
      line,
      sourceLine,
    );
  }

  let source = sourceLine;
  if (source.startsWith("\\#") || source.startsWith("\\!")) source = source.slice(1);
  else if (source.startsWith("#")) return null;

  let negated = false;
  if (source.startsWith("!")) {
    negated = true;
    source = source.slice(1);
  }
  if (source.length === 0) {
    throw new LytIgnorePolicyError(
      `.lytignore has an empty pattern at line ${line}.`,
      line,
      sourceLine,
    );
  }
  if (source.includes("\0") || /(^|\/)\.\.(?:\/|$)/.test(source) || /^[A-Za-z]:/.test(source)) {
    throw new LytIgnorePolicyError(
      `.lytignore pattern at line ${line} is not vault-relative: ${sourceLine}`,
      line,
      sourceLine,
    );
  }
  if (source.includes("\\")) {
    throw new LytIgnorePolicyError(
      `.lytignore pattern at line ${line} must use forward slashes: ${sourceLine}`,
      line,
      sourceLine,
    );
  }

  const anchored = source.startsWith("/");
  if (anchored) source = source.slice(1);
  const directoryOnly = source.endsWith("/");
  if (directoryOnly) source = source.slice(0, -1);
  if (source.length === 0) {
    throw new LytIgnorePolicyError(
      `.lytignore pattern at line ${line} cannot target the vault root.`,
      line,
      sourceLine,
    );
  }

  const containsSlash = source.includes("/");
  const body = globBodyToRegex(source);
  const prefix = anchored || containsSlash ? "^" : "(?:^|.*/)";
  const suffix = directoryOnly ? "(?:/.*)?$" : "(?:$|/.*$)";
  return {
    line,
    source: sourceLine,
    negated,
    directoryOnly,
    regex: new RegExp(`${prefix}${body}${suffix}`),
  };
}

export function parseLytIgnore(bytes: Uint8Array, path: string): LytIgnorePolicy {
  const buffer = Buffer.from(bytes);
  const raw = buffer.toString("utf8");
  if (raw.includes("\u0000")) {
    throw new LytIgnorePolicyError(".lytignore contains a NUL byte and cannot be parsed.");
  }
  const patterns = raw
    .split(/\r?\n/)
    .map((line, index) => compilePattern(line, index + 1))
    .filter((pattern): pattern is LytIgnorePattern => pattern !== null);
  const matcher: IgnoreMatcher = (input) => {
    const relPath = input.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
    let ignored = false;
    for (const pattern of patterns) {
      if (pattern.regex.test(relPath)) ignored = !pattern.negated;
    }
    return ignored;
  };
  return {
    exists: true,
    path,
    bytes: buffer,
    sha256: sha256(buffer),
    patterns,
    matcher,
  };
}

export function loadLytIgnorePolicy(vaultRoot: string): LytIgnorePolicy {
  const path = join(vaultRoot, LYT_IGNORE_FILENAME);
  if (!existsSync(path)) {
    const bytes = Buffer.alloc(0);
    return {
      exists: false,
      path,
      bytes,
      sha256: sha256(bytes),
      patterns: [],
      matcher: () => false,
    };
  }
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new LytIgnorePolicyError(
      `.lytignore could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new LytIgnorePolicyError(".lytignore must be a regular file and may not be a reparse point.");
  }
  try {
    return parseLytIgnore(readFileSync(path), path);
  } catch (error) {
    if (error instanceof LytIgnorePolicyError) throw error;
    throw new LytIgnorePolicyError(
      `.lytignore could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
