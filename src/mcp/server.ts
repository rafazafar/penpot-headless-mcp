import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Documents, fileSummary } from "../document/service.js";
import { shapeInput, shapePatch, uuid } from "../document/shapes.js";
import { PenpotClient, PenpotError, type ObjectData } from "../penpot/client.js";

const pagination = {
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(200).default(100),
};
const fileId = uuid.describe("Explicit Penpot file UUID. No browser selection is used.");
const pageId = uuid.describe("Page UUID from get_file.");
const writeTarget = {
  fileId,
  expectedRevision: z.number().int().min(0).describe("revision from the most recent file or page read"),
  expectedVersion: z.number().int().min(0).describe("version from the most recent file or page read"),
};

export function createServer(client: PenpotClient, readOnly = false): McpServer {
  const documents = new Documents(client);
  const server = new McpServer({ name: "penpot-headless-mcp", version: "0.1.0" }, {
    instructions: [
      "This server reads and edits Penpot through backend HTTP requests. No browser or plugin is used.",
      "Start with list_projects, list_files, get_file, and get_page. All targets use explicit UUIDs.",
      "Get current revision and version before every write. A successful write returns the new revision and a read-back verification result.",
      "If a write reports outcome unknown, read the file before any retry. Writes are never retried automatically.",
      "Concurrent writers are not protected by an atomic compare-and-swap. Avoid simultaneous edits to the same file.",
      "Supported writes: pages and basic rectangles, ellipses, fixed-size text, and frames in manual layouts.",
      "Coordinates are absolute page coordinates. Batch creation can use a preceding frame's explicit UUID as parentId.",
      "Component synchronization, automatic layout, text measurement, and image rendering are not implemented. Do not promise those results.",
      "Text needs explicit width and height. Text replacement keeps the first span style and removes mixed formatting.",
    ].join("\n"),
  });

  function tool<S extends z.ZodRawShape>(name: string, description: string, schema: S,
    read: boolean, action: (args: z.output<z.ZodObject<S>>) => Promise<unknown>, destructive = false) {
    if (readOnly && !read) return;
    const inputSchema = z.object(schema).strict();
    server.registerTool<z.ZodRawShape, typeof inputSchema>(name, {
      description, inputSchema,
      annotations: { readOnlyHint: read, destructiveHint: destructive, idempotentHint: read, openWorldHint: true },
    }, async args => {
      try {
        const result = await action(args as z.output<z.ZodObject<S>>);
        const text = JSON.stringify(result);
        if (Buffer.byteLength(text) > 1_000_000) {
          return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({
            code: "result_too_large", message: "Use a smaller limit or request fewer shapes.",
          }) }] };
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        const detail = error instanceof PenpotError
          ? { code: error.code, message: error.message, outcome: error.outcome, details: error.details }
          : { code: "operation_failed", message: "The operation failed. Check the input and server configuration.", outcome: read ? "not_applied" : "unknown" };
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(detail) }] };
      }
    });
  }

  tool("get_profile", "Check the personal access token and return the authenticated profile.", {}, true, async () => {
    const profile = await client.rpc<ObjectData>("get-profile");
    if (profile.id === "00000000-0000-0000-0000-000000000000") {
      throw new PenpotError("authentication_required", "The token did not authenticate a Penpot user.");
    }
    return { id: profile.id, fullname: profile.fullname, defaultTeamId: profile.defaultTeamId, defaultProjectId: profile.defaultProjectId };
  });
  tool("list_teams", "List teams available to the authenticated user.", {}, true, () => client.rpc("get-teams"));
  tool("list_projects", "List accessible projects, optionally in one team.", { teamId: uuid.optional() }, true,
    args => args.teamId ? client.rpc("get-projects", { teamId: args.teamId }) : client.rpc("get-all-projects"));
  tool("list_files", "List file IDs and names in a project.", { projectId: uuid, ...pagination }, true, async args => {
    const files = await client.rpc<ObjectData[]>("get-project-files", { projectId: args.projectId });
    return { total: files.length, nextOffset: args.offset + args.limit < files.length ? args.offset + args.limit : null,
      files: files.slice(args.offset, args.offset + args.limit).map(f => ({ id: f.id, name: f.name, projectId: f.projectId,
        modifiedAt: f.modifiedAt, revision: f.revn, version: f.vern })) };
  });
  tool("get_file", "Read file metadata, revision, version, page IDs, and shape counts.", { fileId }, true,
    async args => fileSummary(await documents.getFile(args.fileId)));
  tool("get_page", "Read a page and a paginated list of shape summaries.", { fileId, pageId, ...pagination }, true,
    args => documents.getPage(args.fileId, args.pageId, args.offset, args.limit));
  tool("get_shapes", "Read complete shape data for up to 50 IDs, including text, styles, and geometry.",
    { fileId, pageId, shapeIds: z.array(uuid).min(1).max(50) }, true,
    args => documents.getShapes(args.fileId, args.pageId, args.shapeIds));
  tool("get_assets", "Read local components, colors, typography, media, or design token data. Does not resolve external libraries.",
    { fileId, kind: z.enum(["components", "colors", "typographies", "media", "tokensLib"]), ...pagination }, true,
    args => documents.getAssets(args.fileId, args.kind, args.offset, args.limit));
  tool("create_file", "Create a file with an initial page in an existing project.",
    { projectId: uuid, name: z.string().min(1).max(250) }, false,
    args => documents.createFile(args.projectId, args.name));
  tool("create_page", "Create an empty page in a file. Supply an ID to detect duplicate retries.",
    { ...writeTarget, name: z.string().min(1).max(250), id: uuid.optional() }, false,
    args => documents.createPage(args, args.name, args.id));
  tool("rename_page", "Rename an existing page.", { ...writeTarget, pageId, name: z.string().min(1).max(250) }, false,
    args => documents.renamePage(args, args.name));
  tool("create_shapes", "Create rectangles, ellipses, fixed-size text, or frames in one transaction. Use absolute page coordinates. Parents must be frames in manual layouts. Text is not measured or rendered.",
    { ...writeTarget, pageId, shapes: z.array(shapeInput).min(1).max(100) }, false,
    args => documents.createShapes(args, args.shapes));
  tool("update_shapes", "Update names, styles, text, or simple unrotated geometry in one transaction. Component instances and automatic layouts are rejected. Read shapes first.",
    { ...writeTarget, pageId, patches: z.array(shapePatch).min(1).max(100) }, false,
    args => documents.updateShapes(args, args.patches));
  tool("delete_shapes", "Delete shapes and their descendants. Component instances, automatic layouts, and child deletions that leave a surviving group are rejected.",
    { ...writeTarget, pageId, shapeIds: z.array(uuid).min(1).max(100) }, false,
    args => documents.deleteShapes(args, args.shapeIds), true);
  return server;
}
