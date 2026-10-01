import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { FEATURES, PenpotClient, PenpotError, type Json, type ObjectData } from "../penpot/client.js";
import { assertEditable, makeShape, patchShape, ROOT_ID, type ShapeInput, type ShapePatch } from "./shapes.js";

export interface Page { id: string; name: string; objects: Record<string, ObjectData> }
export interface FileData {
  id: string; name: string; projectId: string; revn: number; vern: number; features: string[];
  data: { pages: string[]; pagesIndex: Record<string, Page>; [key: string]: unknown };
}
export interface WriteTarget { fileId: string; expectedRevision: number; expectedVersion: number }
export interface PageTarget extends WriteTarget { pageId: string }

export function fileSummary(file: FileData) {
  return { id: file.id, name: file.name, projectId: file.projectId, revision: file.revn, version: file.vern,
    features: file.features, pages: file.data.pages.map(id => {
      const page = file.data.pagesIndex[id];
      return { id, name: page.name, shapeCount: Object.keys(page.objects).length - 1 };
    }) };
}

function getPage(file: FileData, id: string): Page {
  const page = file.data.pagesIndex[id];
  if (!page) throw new PenpotError("page_not_found", "The page is not in this file.");
  return page;
}

function getShape(page: Page, id: string): ObjectData {
  const shape = page.objects[id];
  if (!shape) throw new PenpotError("shape_not_found", `Shape ${id} is not in this page.`);
  return shape;
}

export class Documents {
  private queues = new Map<string, Promise<unknown>>();
  constructor(readonly client: PenpotClient) {}

  async getFile(fileId: string): Promise<FileData> {
    const file = await this.client.rpc<FileData>("get-file", { id: fileId, features: FEATURES });
    if (!file?.data?.pagesIndex || !Array.isArray(file.data.pages) || !Number.isInteger(file.revn) || !Number.isInteger(file.vern)) {
      throw new PenpotError("unsupported_file_format", "The file response does not match the supported Penpot format.");
    }
    return file;
  }

  async getPage(fileId: string, pageId: string, offset = 0, limit = 100) {
    const file = await this.getFile(fileId);
    const page = getPage(file, pageId);
    const shapes = Object.values(page.objects).filter(s => s.id !== ROOT_ID);
    return { fileId, pageId, name: page.name, revision: file.revn, version: file.vern,
      total: shapes.length, nextOffset: offset + limit < shapes.length ? offset + limit : null,
      shapes: shapes.slice(offset, offset + limit).map(s => ({ id: s.id, name: s.name, type: s.type,
        parentId: s.parentId, frameId: s.frameId, x: s.x, y: s.y, width: s.width, height: s.height,
        children: s.shapes ?? [], componentId: s.componentId ?? null, layout: s.layout ?? null })) };
  }

  async getShapes(fileId: string, pageId: string, ids: string[]) {
    const file = await this.getFile(fileId);
    const page = getPage(file, pageId);
    return { fileId, pageId, revision: file.revn, version: file.vern, shapes: ids.map(id => getShape(page, id)) };
  }

  async createFile(projectId: string, name: string) {
    const result = await this.client.rpc<FileData>("create-file", { projectId, name, features: FEATURES }, true);
    return fileSummary(result);
  }

  private async write(target: WriteTarget, prepare: (file: FileData) => {
    changes: ObjectData[]; result: ObjectData; verify: (file: FileData) => boolean;
  }) {
    // Serialize writes within this process. Penpot does not provide strict compare-and-swap;
    // the revision preflight cannot exclude a writer in another process racing our request.
    const previous = this.queues.get(target.fileId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const before = await this.getFile(target.fileId);
      if (before.revn !== target.expectedRevision || before.vern !== target.expectedVersion) {
        throw new PenpotError("revision_conflict", `Read the file again. Current revision/version: ${before.revn}/${before.vern}; requested: ${target.expectedRevision}/${target.expectedVersion}.`);
      }
      const { changes, result, verify } = prepare(before);
      if (!changes.length) throw new PenpotError("empty_change", "No changes were supplied.");
      try {
        await this.client.rpc("update-file", {
          id: target.fileId, sessionId: randomUUID(), revn: before.revn, vern: before.vern,
          features: FEATURES, changes,
        }, true);
      } catch (error) {
        if (error instanceof PenpotError) error.details = { ...result, fileId: target.fileId };
        throw error;
      }
      let after: FileData;
      try { after = await this.getFile(target.fileId); }
      catch {
        return { ...result, fileId: target.fileId, status: "applied", verification: "read_failed",
          message: "Penpot accepted the write. Read the file to verify it before any retry." };
      }
      return { ...result, fileId: target.fileId, status: "applied", revision: after.revn, version: after.vern,
        verification: verify(after) ? "passed" : "mismatch",
        concurrentChangesDetected: after.revn !== before.revn + 1 || after.vern !== before.vern };
    });
    this.queues.set(target.fileId, operation);
    try { return await operation; }
    finally { if (this.queues.get(target.fileId) === operation) this.queues.delete(target.fileId); }
  }

  async createPage(target: WriteTarget, name: string, id: string = randomUUID()) {
    return this.write(target, file => {
      if (file.data.pagesIndex[id]) throw new PenpotError("id_exists", "This page ID already exists. Read the page before retrying.");
      return { changes: [{ type: "add-page", id, name }], result: { pageId: id },
        verify: f => f.data.pagesIndex[id]?.name === name };
    });
  }

  async renamePage(target: PageTarget, name: string) {
    return this.write(target, file => {
      getPage(file, target.pageId);
      return { changes: [{ type: "mod-page", id: target.pageId, name }], result: { pageId: target.pageId },
        verify: f => f.data.pagesIndex[target.pageId]?.name === name };
    });
  }

  async createShapes(target: PageTarget, inputs: ShapeInput[]) {
    return this.write(target, file => {
      const page = getPage(file, target.pageId);
      const objects = { ...page.objects };
      const shapes = inputs.map(input => {
        const parent = objects[input.parentId ?? ROOT_ID];
        if (!parent || parent.type !== "frame") throw new PenpotError("invalid_parent", "New shapes require the page root or a frame parent.");
        assertEditable(parent, objects);
        const shape = makeShape(input, parent);
        if (objects[String(shape.id)]) throw new PenpotError("id_exists", `Shape ${shape.id} already exists. Read it before retrying.`);
        objects[String(shape.id)] = shape;
        return shape;
      });
      return { changes: shapes.map(obj => ({ type: "add-obj", id: obj.id, pageId: target.pageId,
        parentId: obj.parentId, frameId: obj.frameId, obj })),
        result: { shapeIds: shapes.map(s => s.id), pageId: target.pageId },
        verify: f => shapes.every(s => {
          const actual = f.data.pagesIndex[target.pageId]?.objects[String(s.id)];
          const parent = f.data.pagesIndex[target.pageId]?.objects[String(s.parentId)];
          return !!actual && Object.entries(s).filter(([key]) => key !== "shapes")
            .every(([key, value]) => isDeepStrictEqual(actual[key], value)) &&
            Array.isArray(parent?.shapes) && parent.shapes.includes(s.id);
        }) };
    });
  }

  async updateShapes(target: PageTarget, patches: ShapePatch[]) {
    return this.write(target, file => {
      const page = getPage(file, target.pageId);
      if (new Set(patches.map(p => p.id)).size !== patches.length) throw new PenpotError("duplicate_id", "Each shape can occur only once in a batch.");
      const updates = patches.map(patch => {
        if (patch.id === ROOT_ID) throw new PenpotError("root_edit", "The page root cannot be edited.");
        const shape = getShape(page, patch.id);
        assertEditable(shape, page.objects);
        if ([patch.x, patch.y, patch.width, patch.height].some(v => v !== undefined) &&
            page.objects[String(shape.parentId)]?.type !== "frame") {
          throw new PenpotError("unsupported_geometry", "Geometry updates inside groups require group bounds calculation.");
        }
        const attrs = patchShape(shape, patch);
        if (!Object.keys(attrs).length) throw new PenpotError("empty_change", "Each patch must change at least one property.");
        return { id: patch.id, attrs };
      });
      return { changes: updates.map(u => ({ type: "mod-obj", id: u.id, pageId: target.pageId,
        operations: [{ type: "assign", value: u.attrs }] })),
        result: { shapeIds: updates.map(u => u.id), pageId: target.pageId },
        verify: f => updates.every(u => Object.entries(u.attrs).every(([k, v]) => {
          const actual = f.data.pagesIndex[target.pageId]?.objects[u.id];
          return !!actual && (v === null ? actual[k] == null : isDeepStrictEqual(actual[k], v));
        })) };
    });
  }

  async deleteShapes(target: PageTarget, ids: string[]) {
    return this.write(target, file => {
      const page = getPage(file, target.pageId);
      const removing = new Set(ids);
      const collect = (id: string) => {
        if (id === ROOT_ID) throw new PenpotError("root_edit", "The page root cannot be deleted.");
        const shape = getShape(page, id);
        assertEditable(shape, page.objects);
        for (const child of (shape.shapes ?? []) as string[]) if (!removing.has(child)) { removing.add(child); collect(child); }
      };
      ids.forEach(collect);
      for (const id of removing) {
        const parentId = String(page.objects[id].parentId);
        if (!removing.has(parentId) && page.objects[parentId]?.type !== "frame") {
          throw new PenpotError("unsupported_geometry", "Deleting children from a surviving group requires group bounds calculation.");
        }
      }
      // Delete descendants first. This also makes the outcome independent of backend cascade details.
      const ordered: string[] = [];
      const visited = new Set<string>();
      const visit = (id: string) => {
        if (visited.has(id)) return;
        visited.add(id);
        for (const child of (page.objects[id]?.shapes ?? []) as string[]) if (removing.has(child)) visit(child);
        ordered.push(id);
      };
      ids.forEach(visit);
      return { changes: ordered.map(id => ({ type: "del-obj", pageId: target.pageId, id })),
        result: { deletedShapeIds: ordered, pageId: target.pageId },
        verify: f => ordered.every(id => !f.data.pagesIndex[target.pageId]?.objects[id]) };
    });
  }

  async getAssets(fileId: string, kind: string, offset = 0, limit = 100) {
    const file = await this.getFile(fileId);
    const value = file.data[kind];
    const entries = value && typeof value === "object" ? Object.entries(value) : [];
    return { fileId, revision: file.revn, version: file.vern, kind, total: entries.length,
      nextOffset: offset + limit < entries.length ? offset + limit : null,
      entries: Object.fromEntries(entries.slice(offset, offset + limit)) as Json };
  }
}
