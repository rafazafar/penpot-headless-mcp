import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Documents, type FileData } from "../src/document/service.js";
import { ROOT_ID, geometry } from "../src/document/shapes.js";
import { PenpotClient, PenpotError, type ObjectData } from "../src/penpot/client.js";

function fixture() {
  const fileId = randomUUID(), pageId = randomUUID();
  const group = randomUUID(), nested = randomUUID(), child = randomUUID(), sibling = randomUUID(), plain = randomUUID();
  const shape = (id: string, type: string, parentId: string, shapes?: string[]): ObjectData => ({
    id, type, parentId, frameId: ROOT_ID, ...geometry(0, 0, 100, 50), ...(shapes ? { shapes } : {}),
  });
  const objects = {
    [ROOT_ID]: shape(ROOT_ID, "frame", ROOT_ID, [group, plain]),
    [group]: shape(group, "group", ROOT_ID, [nested, sibling]),
    [nested]: shape(nested, "group", group, [child]),
    [child]: shape(child, "rect", nested),
    [sibling]: shape(sibling, "rect", group),
    [plain]: shape(plain, "rect", ROOT_ID),
  };
  const file: FileData = { id: fileId, name: "File", projectId: randomUUID(), revn: 0, vern: 0, features: [],
    data: { pages: [pageId], pagesIndex: { [pageId]: { id: pageId, name: "Page", objects } } } };
  const commands: string[] = [];
  const client = new PenpotClient({ url: "https://example.test", token: "secret", fetch: async (url, init) => {
    const command = new URL(String(url)).pathname.split("/").at(-1)!;
    commands.push(command);
    if (command === "update-file") {
      for (const change of JSON.parse(String(init?.body)).changes) {
        assert.equal(change.type, "del-obj");
        const parent = objects[String(objects[change.id].parentId)];
        parent.shapes = (parent.shapes as string[]).filter(id => id !== change.id);
        delete objects[change.id];
      }
      file.revn++;
      return Response.json([]);
    }
    assert.equal(command, "get-file");
    return Response.json(file);
  } });
  return { documents: new Documents(client), target: { fileId, pageId, expectedRevision: 0, expectedVersion: 0 },
    group, nested, child, sibling, plain, objects, commands };
}

test("deleting grouped children rejects the whole batch before a write", async () => {
  for (const select of [(f: ReturnType<typeof fixture>) => [f.child],
    (f: ReturnType<typeof fixture>) => [f.nested],
    (f: ReturnType<typeof fixture>) => [f.nested, f.sibling],
    (f: ReturnType<typeof fixture>) => [f.plain, f.sibling]]) {
    const f = fixture(), before = structuredClone(f.objects);
    await assert.rejects(f.documents.deleteShapes(f.target, select(f)),
      (error: PenpotError) => error.code === "unsupported_geometry" && error.outcome === "not_applied");
    assert.deepEqual(f.commands, ["get-file"]);
    assert.deepEqual(f.objects, before);
  }
});

test("whole groups and direct frame children can still be deleted", async () => {
  for (const select of [(f: ReturnType<typeof fixture>) => [f.group],
    (f: ReturnType<typeof fixture>) => [f.child, f.group],
    (f: ReturnType<typeof fixture>) => [f.group, f.child],
    (f: ReturnType<typeof fixture>) => [f.plain]]) {
    const f = fixture(), ids = select(f);
    const result = await f.documents.deleteShapes(f.target, ids);
    assert.equal(result.status, "applied");
    assert.equal(result.verification, "passed");
    for (const id of ids) assert.equal(f.objects[id], undefined);
    assert.deepEqual(f.commands, ["get-file", "update-file", "get-file"]);
  }
});
