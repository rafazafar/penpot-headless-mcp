import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type ObjectData, PenpotError } from "../penpot/client.js";

export const ROOT_ID = "00000000-0000-0000-0000-000000000000";
export const uuid = z.string().uuid();
const coordinate = z.number().finite().min(-1e7).max(1e7);
const dimension = z.number().finite().min(0.01).max(1e7);
export const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const shapeInput = z.object({
  id: uuid.optional(),
  type: z.enum(["rect", "circle", "frame", "text"]),
  name: z.string().min(1).max(250),
  x: coordinate, y: coordinate, width: dimension, height: dimension,
  parentId: uuid.optional(),
  fill: color.optional(),
  opacity: z.number().min(0).max(1).optional(),
  radius: z.number().min(0).max(1e6).optional(),
  text: z.string().max(100_000).optional(),
  fontFamily: z.string().max(200).optional().describe("Supply fontFamily and fontId together, or omit both for the default font."),
  fontId: z.string().max(200).optional().describe("Supply with fontFamily to select the same font."),
  fontSize: z.number().min(1).max(1000).optional(),
}).strict().refine(input => (input.fontFamily === undefined) === (input.fontId === undefined), {
  message: "Supply fontFamily and fontId together, or omit both for the default font.",
});
export type ShapeInput = z.infer<typeof shapeInput>;

export const shapePatch = z.object({
  id: uuid,
  name: z.string().min(1).max(250).optional(),
  x: coordinate.optional(), y: coordinate.optional(),
  width: dimension.optional(), height: dimension.optional(),
  fill: color.optional(), opacity: z.number().min(0).max(1).optional(),
  radius: z.number().min(0).max(1e6).optional(),
  hidden: z.boolean().optional(), blocked: z.boolean().optional(),
  text: z.string().max(100_000).optional(),
}).strict();
export type ShapePatch = z.infer<typeof shapePatch>;

export function geometry(x: number, y: number, width: number, height: number): ObjectData {
  return { x, y, width, height,
    selrect: { x, y, width, height, x1: x, y1: y, x2: x + width, y2: y + height },
    points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }],
  };
}

function textContent(input: ShapeInput): ObjectData {
  const attrs: ObjectData = {
    "fontFamily": input.fontFamily ?? "sourcesanspro",
    "fontId": input.fontId ?? "sourcesanspro",
    "fontSize": String(input.fontSize ?? 16), "fontWeight": "400", "fontStyle": "normal",
    "fontVariantId": "regular", "textDecoration": "none", "textTransform": "none",
    fills: [{ "fillColor": input.fill ?? "#000000", "fillOpacity": 1 }],
  };
  return { type: "root", children: [{ type: "paragraph-set", children:
    (input.text ?? "").split("\n").map(text => ({ type: "paragraph", ...attrs,
      "textAlign": "left", "lineHeight": "1.2", children: [{ ...attrs, text }] })) }] };
}

export function makeShape(input: ShapeInput, parent: ObjectData): ObjectData {
  const parentId = String(parent.id);
  const frameId = parent.type === "frame" ? parentId : String(parent["frameId"]);
  const matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const shape: ObjectData = {
    id: input.id ?? randomUUID(), type: input.type, name: input.name,
    "parentId": parentId, "frameId": frameId,
    ...geometry(input.x, input.y, input.width, input.height),
    transform: matrix, "transformInverse": matrix, rotation: 0,
    fills: [{ "fillColor": input.fill ?? (input.type === "frame" ? "#FFFFFF" : "#B1B2B5"), "fillOpacity": 1 }],
    strokes: [], opacity: input.opacity ?? 1,
    r1: input.radius ?? 0, r2: input.radius ?? 0, r3: input.radius ?? 0, r4: input.radius ?? 0,
    "proportionLock": false,
  };
  if (input.type === "frame") Object.assign(shape, { shapes: [], "hideFillOnExport": false });
  if (input.type === "text") Object.assign(shape, { content: textContent(input), "growType": "fixed" });
  return shape;
}

export function assertEditable(shape: ObjectData, objects: Record<string, ObjectData>): void {
  let current: ObjectData | undefined = shape;
  const seen = new Set<string>();
  while (current && current.id !== ROOT_ID) {
    const id = String(current.id);
    if (seen.has(id)) throw new PenpotError("invalid_tree", "The shape parent chain contains a cycle.");
    seen.add(id);
    if (current["componentId"] || current["shapeRef"] || current["mainInstance"] || current["componentRoot"]) {
      throw new PenpotError("unsupported_component_edit", "Editing component instances requires component synchronization and is not supported yet.");
    }
    if (current.layout) throw new PenpotError("unsupported_layout_edit", "Editing automatic layouts requires layout calculation and is not supported yet.");
    current = objects[String(current["parentId"])];
  }
}

export function patchShape(shape: ObjectData, patch: ShapePatch): ObjectData {
  const attrs: ObjectData = {};
  const changesTextLayout = patch.text !== undefined || [patch.x, patch.y, patch.width, patch.height].some(v => v !== undefined);
  if (shape.type === "text" && changesTextLayout && shape.growType !== "fixed") {
    throw new PenpotError("unsupported_text_sizing", "Automatic text sizing requires font measurement. Use fixed-size text.");
  }
  for (const key of ["name", "opacity", "hidden", "blocked"] as const) {
    if (patch[key] !== undefined) attrs[key] = patch[key]!;
  }
  if (patch.fill !== undefined) attrs.fills = [{ "fillColor": patch.fill, "fillOpacity": 1 }];
  if (patch.radius !== undefined) for (const key of ["r1", "r2", "r3", "r4"]) attrs[key] = patch.radius;
  if ([patch.x, patch.y, patch.width, patch.height].some(v => v !== undefined)) {
    const t = shape.transform as ObjectData | undefined;
    if (shape.rotation || (t && [t.a !== 1, t.b !== 0, t.c !== 0, t.d !== 1, t.e !== 0, t.f !== 0].some(Boolean)) ||
        !["rect", "circle", "text", "frame"].includes(String(shape.type))) {
      throw new PenpotError("unsupported_geometry", "Geometry updates require an unrotated rectangle, ellipse, text, or empty frame.");
    }
    if (Array.isArray(shape.shapes) && shape.shapes.length) {
      throw new PenpotError("unsupported_geometry", "Moving or resizing a populated container requires child geometry updates.");
    }
    Object.assign(attrs, geometry(patch.x ?? Number(shape.x), patch.y ?? Number(shape.y),
      patch.width ?? Number(shape.width), patch.height ?? Number(shape.height)));
  }
  if (patch.text !== undefined) {
    if (shape.type !== "text") throw new PenpotError("invalid_shape_type", "Only text shapes have text content.");
    // Keep the first paragraph and span styles. Replacing text intentionally removes mixed styles.
    const old = shape.content as ObjectData;
    const set = (old?.children as ObjectData[] | undefined)?.[0];
    const paragraph = (set?.children as ObjectData[] | undefined)?.[0] ?? {};
    const span = (paragraph.children as ObjectData[] | undefined)?.[0] ?? {};
    attrs.content = { ...old, type: "root", children: [{ ...set, type: "paragraph-set",
      children: patch.text.split("\n").map(text => ({ ...paragraph, type: "paragraph", children: [{ ...span, text }] })) }] };
  }
  if (shape.type === "text" && patch.fill !== undefined) {
    const fill = [{ fillColor: patch.fill, fillOpacity: 1 }];
    const recolor = (node: ObjectData): ObjectData => ({ ...node,
      ...(node.fills || typeof node.text === "string" ? { fills: fill } : {}),
      ...(Array.isArray(node.children) ? { children: (node.children as ObjectData[]).map(recolor) } : {}),
    });
    attrs.content = recolor((attrs.content ?? shape.content) as ObjectData);
  }
  if (shape.type === "text" && (changesTextLayout || patch.fill !== undefined)) {
    // Cached glyph positions refer to the old text, bounds, and fills. Null removes the attribute.
    attrs.positionData = null;
  }
  return attrs;
}
