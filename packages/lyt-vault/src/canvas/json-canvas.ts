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

// v1.D.5 — JSON Canvas builder primitive (default: hand-written, no
// library dep). Spec: https://jsoncanvas.org/spec/1.0/ (Obsidian Canvas
// .canvas format).
//
// Why hand-rolled: the spec is small (4 node types + 1 edge type, fewer
// than 30 lines of meaningful schema). Pinning an external library buys
// nothing and adds churn. If the spec evolves (post-1.0), refactor at
// that point.
//
// Canvas top-level: { nodes: [...], edges: [...] }
//
// Node types (per spec §3):
// - text: { id, type:"text", x, y, width, height, text, color? }
// - file: { id, type:"file", x, y, width, height, file, subpath?, color? }
// - link: { id, type:"link", x, y, width, height, url, color? }
// - group: { id, type:"group", x, y, width, height, label?, color? }
//
// Edge fields (per spec §4):
// - required: id, fromNode, toNode
// - optional: fromSide, toSide, fromEnd, toEnd, color, label
//
// Color (per spec §2.3): string — either preset "1".."6" (red, orange,
// yellow, green, cyan, purple) or hex "#RRGGBB". Lyt canvases use the
// preset palette for semantic meaning across federation + mesh canvases.
//
// Determinism (Lock 0.3): every builder helper emits keys in spec order
// (id → type → geometry → type-specific → color). `serializeCanvas`
// preserves the input array order — callers SORT nodes + edges before
// passing them in. JSON.stringify with 2-space indent is the canonical
// rendering.

export type JsonCanvasColor = string; // "1".."6" preset OR "#RRGGBB"

export type JsonCanvasNodeSide = "top" | "right" | "bottom" | "left";

export interface JsonCanvasTextNode {
  id: string;
  type: "text";
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color?: JsonCanvasColor;
}

export interface JsonCanvasFileNode {
  id: string;
  type: "file";
  x: number;
  y: number;
  width: number;
  height: number;
  file: string;
  color?: JsonCanvasColor;
}

export interface JsonCanvasLinkNode {
  id: string;
  type: "link";
  x: number;
  y: number;
  width: number;
  height: number;
  url: string;
  color?: JsonCanvasColor;
}

export interface JsonCanvasGroupNode {
  id: string;
  type: "group";
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  color?: JsonCanvasColor;
}

export type JsonCanvasNode =
  | JsonCanvasTextNode
  | JsonCanvasFileNode
  | JsonCanvasLinkNode
  | JsonCanvasGroupNode;

export interface JsonCanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: JsonCanvasNodeSide;
  toSide?: JsonCanvasNodeSide;
  color?: JsonCanvasColor;
  label?: string;
}

export interface JsonCanvas {
  nodes: JsonCanvasNode[];
  edges: JsonCanvasEdge[];
}

export interface NodeGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Builder helpers — each emits keys in spec order. Optional `color` is
// only written when defined so omitted-vs-undefined serialise identically.

export function textNode(
  id: string,
  geom: NodeGeometry,
  text: string,
  color?: JsonCanvasColor,
): JsonCanvasTextNode {
  const out: JsonCanvasTextNode = {
    id,
    type: "text",
    x: geom.x,
    y: geom.y,
    width: geom.width,
    height: geom.height,
    text,
  };
  if (color !== undefined) out.color = color;
  return out;
}

export function fileNode(
  id: string,
  geom: NodeGeometry,
  file: string,
  color?: JsonCanvasColor,
): JsonCanvasFileNode {
  const out: JsonCanvasFileNode = {
    id,
    type: "file",
    x: geom.x,
    y: geom.y,
    width: geom.width,
    height: geom.height,
    file,
  };
  if (color !== undefined) out.color = color;
  return out;
}

export function linkNode(
  id: string,
  geom: NodeGeometry,
  url: string,
  color?: JsonCanvasColor,
): JsonCanvasLinkNode {
  const out: JsonCanvasLinkNode = {
    id,
    type: "link",
    x: geom.x,
    y: geom.y,
    width: geom.width,
    height: geom.height,
    url,
  };
  if (color !== undefined) out.color = color;
  return out;
}

export function groupNode(
  id: string,
  geom: NodeGeometry,
  label?: string,
  color?: JsonCanvasColor,
): JsonCanvasGroupNode {
  const out: JsonCanvasGroupNode = {
    id,
    type: "group",
    x: geom.x,
    y: geom.y,
    width: geom.width,
    height: geom.height,
  };
  if (label !== undefined) out.label = label;
  if (color !== undefined) out.color = color;
  return out;
}

export interface EdgeOptions {
  fromSide?: JsonCanvasNodeSide;
  toSide?: JsonCanvasNodeSide;
  color?: JsonCanvasColor;
  label?: string;
}

export function edge(
  id: string,
  fromNode: string,
  toNode: string,
  opts: EdgeOptions = {},
): JsonCanvasEdge {
  const out: JsonCanvasEdge = { id, fromNode, toNode };
  if (opts.fromSide !== undefined) out.fromSide = opts.fromSide;
  if (opts.toSide !== undefined) out.toSide = opts.toSide;
  if (opts.color !== undefined) out.color = opts.color;
  if (opts.label !== undefined) out.label = opts.label;
  return out;
}

// Serialise to deterministic JSON. `JSON.stringify` honours insertion
// order on plain objects in V8 + every modern JS engine, so the spec-
// order constructed by the builder helpers above is preserved through
// the round-trip.
//
// Trailing newline is intentional: Obsidian writes `.canvas` files with
// a trailing newline; matching that convention avoids spurious diffs
// when a handler edits the canvas in Obsidian and then re-saves.
export function serializeCanvas(canvas: JsonCanvas): string {
  return JSON.stringify({ nodes: canvas.nodes, edges: canvas.edges }, null, 2) + "\n";
}
