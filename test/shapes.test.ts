import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertEditable, makeShape, patchShape, ROOT_ID, shapeInput, shapePatch } from "../src/document/shapes.js";
import type { ObjectData } from "../src/penpot/client.js";

const root = { id: ROOT_ID, type: "frame", frameId: ROOT_ID };
const rectangle = () => makeShape({ type: "rect", name: "Rect", x: 10, y: 20, width: 40, height: 60 }, root);

test("moving and resizing keeps geometry bounds and corners consistent", () => {
  const shape = rectangle();
  const patch = patchShape(shape, { id: String(shape.id), x: -30, width: 90 });
  assert.deepEqual(patch.selrect, { x: -30, y: 20, width: 90, height: 60, x1: -30, y1: 20, x2: 60, y2: 80 });
  assert.deepEqual(patch.points, [{ x: -30, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 80 }, { x: -30, y: 80 }]);
});

test("text content and span fills change together", () => {
  const shape = makeShape({ type: "text", name: "Title", text: "Old", x: 0, y: 0, width: 100, height: 50, fill: "#112233" }, root);
  const patch = patchShape(shape, { id: String(shape.id), text: "First\n日本語", fill: "#FF0000" });
  const content = patch.content as any;
  assert.equal(content.children[0].children[1].children[0].text, "日本語");
  assert.deepEqual(content.children[0].children[0].children[0].fills, [{ fillColor: "#FF0000", fillOpacity: 1 }]);
  assert.equal(content.children[0].children[0].children[0].fontId, "sourcesanspro");
});

test("component and layout restrictions include ancestors", () => {
  const parent = { ...rectangle(), id: randomUUID(), type: "frame", componentId: randomUUID() };
  const child = { ...rectangle(), parentId: parent.id };
  assert.throws(() => assertEditable(child, { [ROOT_ID]: root, [String(parent.id)]: parent }), /component/i);
  const layout = { ...parent, componentId: undefined, layout: "flex" } as unknown as ObjectData;
  assert.throws(() => assertEditable(child, { [ROOT_ID]: root, [String(parent.id)]: layout }), /layout/i);
});

test("text fonts require both family and ID or use the default pair", () => {
  const input = { type: "text", name: "Title", text: "Hello", x: 0, y: 0, width: 100, height: 50 };
  for (const font of [{ fontFamily: "Inter" }, { fontId: "inter" }]) {
    assert.equal(shapeInput.safeParse({ ...input, ...font }).success, false);
  }
  for (const font of [{}, { fontFamily: "Inter", fontId: "inter" }]) {
    const shape = makeShape(shapeInput.parse({ ...input, ...font }), root);
    const content = shape.content as any;
    const paragraph = content.children[0].children[0];
    for (const node of [paragraph, paragraph.children[0]]) {
      assert.equal(node.fontFamily, font.fontFamily ?? "sourcesanspro");
      assert.equal(node.fontId, font.fontId ?? "sourcesanspro");
    }
  }
});

test("geometry changes reject rotated shapes and populated frames", () => {
  const shape = rectangle(), patch = { id: String(shape.id), width: 50 };
  assert.throws(() => patchShape({ ...shape, rotation: 90 }, patch), /unrotated/);
  assert.throws(() => patchShape({ ...shape, type: "frame", shapes: [randomUUID()] }, patch), /populated/);
});

test("schemas reject unsupported fields and invalid geometry", () => {
  assert.equal(shapeInput.safeParse({ type: "rect", name: "x", x: 0, y: 0, width: -1, height: 1 }).success, false);
  assert.equal(shapePatch.safeParse({ id: randomUUID(), frameId: randomUUID() }).success, false);
  assert.equal(shapeInput.safeParse({ type: "path", name: "x", x: 0, y: 0, width: 1, height: 1 }).success, false);
});
