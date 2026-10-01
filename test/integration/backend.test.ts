import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FEATURES, PenpotClient } from "../../src/penpot/client.js";

// Tests create isolated users and files in a disposable backend. No browser is launched.
const url = process.env.PENPOT_TEST_URL;
if (!url || new URL(url).hostname !== "127.0.0.1") throw new Error("Run npm run test:integration to start the disposable local backend.");
let token: string;
let client: Client;
let transport: StdioClientTransport;
let api: PenpotClient;
let projectId: string;
let fileId: string;
let pageId: string;
const boardId = randomUUID(), rectId = randomUUID(), textId = randomUUID(), ellipseId = randomUUID();

async function provision() {
  async function rpc(name: string, data: unknown, cookie?: string) {
    const response = await fetch(`${url}/api/rpc/command/${name}`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(data), signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json() as any;
    assert.equal(response.ok, true, `${name}: HTTP ${response.status}, code ${body.code}`);
    return { body, cookie: response.headers.getSetCookie().map(c => c.split(";")[0]).join("; ") };
  }
  const email = `headless-${randomUUID()}@example.test`, password = `Test-${randomUUID()}!`;
  const prep = await rpc("prepare-register-profile", { email, password, fullname: "Headless integration test" });
  await rpc("register-profile", { token: prep.body.token });
  const login = await rpc("login-with-password", { email, password });
  const access = await rpc("create-access-token", { name: "Disposable test" }, login.cookie);
  return { token: access.body.token as string, projectId: login.body.defaultProjectId as string };
}

async function connect(accessToken: string) {
  const pipe = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"],
    env: { PATH: process.env.PATH!, PENPOT_URL: url!, PENPOT_ACCESS_TOKEN: accessToken }, stderr: "pipe" });
  const mcp = new Client({ name: "browser-free-integration-test", version: "1" });
  await mcp.connect(pipe);
  return { mcp, pipe };
}

async function call(name: string, args: Record<string, unknown> = {}, expectError = false, mcp = client): Promise<any> {
  const result = await mcp.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const body = JSON.parse(content[0].text);
  assert.equal(result.isError === true, expectError, `${name}: ${JSON.stringify(body)}`);
  return body;
}

async function target() {
  const file = await call("get_file", { fileId });
  return { fileId, pageId, expectedRevision: file.revision, expectedVersion: file.version };
}

before(async () => {
  const account = await provision(); token = account.token; projectId = account.projectId;
  api = new PenpotClient({ url: url!, token });
  const connection = await connect(token); client = connection.mcp; transport = connection.pipe;
});
after(async () => { await client?.close(); await transport?.close(); });

test("MCP stdio discovery and token authentication work without a frontend", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 14);
  assert.ok(tools.every(t => !/execute_code|plugin|browser/.test(t.name)));
  const profile = await call("get_profile"); assert.ok(profile.id);
  const projects = await call("list_projects"); assert.ok(projects.some((p: any) => p.id === projectId));
  const teams = await call("list_teams"); assert.ok(teams.length);
});

test("create and inspect a file and pages", async () => {
  const file = await call("create_file", { projectId, name: "Browser-free integration" });
  fileId = file.id; pageId = file.pages[0].id;
  const files = await call("list_files", { projectId, limit: 1 });
  assert.equal(files.files[0].id, fileId);
  const newPage = await call("create_page", { ...await target(), pageId: undefined, name: "Second page" });
  assert.equal(newPage.verification, "passed");
  const renamed = await call("rename_page", { ...await target(), name: "Design" });
  assert.equal(renamed.verification, "passed");
});

test("create a board, rectangle, ellipse, and multilingual text in one transaction", async () => {
  const result = await call("create_shapes", { ...await target(), shapes: [
    { id: boardId, type: "frame", name: "Card", x: 100, y: 200, width: 320, height: 240 },
    { id: rectId, parentId: boardId, type: "rect", name: "Button", x: 120, y: 330, width: 200, height: 40, fill: "#EE648A", radius: 8 },
    { id: textId, parentId: boardId, type: "text", name: "Title", x: 120, y: 220, width: 250, height: 60, text: "Hello\n日本語", fill: "#112233" },
    { id: ellipseId, parentId: boardId, type: "circle", name: "Status", x: 380, y: 220, width: 20, height: 20 },
  ] });
  assert.equal(result.verification, "passed"); assert.equal(result.concurrentChangesDetected, false);
  const page = await call("get_page", { fileId, pageId, limit: 2 });
  assert.equal(page.total, 4); assert.equal(page.nextOffset, 2);
  const data = await call("get_shapes", { fileId, pageId, shapeIds: [boardId, rectId, textId] });
  assert.deepEqual(data.shapes[0].shapes, [rectId, textId, ellipseId]);
  assert.equal(data.shapes[1].frameId, boardId);
  assert.equal(data.shapes[1].r1, 8);
  assert.equal(data.shapes[2].content.children[0].children[1].children[0].text, "日本語");
  const assets = await call("get_assets", { fileId, kind: "components" }); assert.equal(assets.total, 0);
});

test("style, text, and geometry updates persist with consistent corners and span fills", async () => {
  const result = await call("update_shapes", { ...await target(), patches: [
    { id: rectId, name: "Save", x: 125, width: 220, fill: "#009900", radius: 12 },
    { id: textId, text: "Updated 日本語", fill: "#FF0000" },
  ] });
  assert.equal(result.verification, "passed");
  const data = await call("get_shapes", { fileId, pageId, shapeIds: [rectId, textId] });
  assert.equal(data.shapes[0].selrect.x2, 345); assert.equal(data.shapes[0].points[1].x, 345);
  assert.equal(data.shapes[1].content.children[0].children[0].children[0].fills[0].fillColor, "#FF0000");
  assert.equal(data.shapes[1].positionData, undefined);
});

test("stale revisions, restored versions, missing shapes, and duplicate IDs do not mutate", async () => {
  const current = await target();
  const stale = await call("update_shapes", { ...current, expectedRevision: 0, patches: [{ id: rectId, name: "Wrong" }] }, true);
  assert.equal(stale.code, "revision_conflict");
  const version = await call("update_shapes", { ...current, expectedVersion: 999, patches: [{ id: rectId, name: "Wrong" }] }, true);
  assert.equal(version.code, "revision_conflict");
  const missing = await call("update_shapes", { ...current, patches: [{ id: rectId, name: "Wrong" }, { id: randomUUID(), name: "Missing" }] }, true);
  assert.equal(missing.code, "shape_not_found");
  const duplicate = await call("create_shapes", { ...current, shapes: [{ id: rectId, type: "rect", name: "Duplicate", x: 0, y: 0, width: 1, height: 1 }] }, true);
  assert.equal(duplicate.code, "id_exists");
  assert.equal((await target()).expectedRevision, current.expectedRevision);
  const data = await call("get_shapes", { fileId, pageId, shapeIds: [rectId] }); assert.equal(data.shapes[0].name, "Save");
});

test("parallel writes with one revision cannot both pass the process preflight", async () => {
  const current = await target();
  const results = await Promise.all(["First", "Second"].map(name => client.callTool({ name: "update_shapes", arguments: {
    ...current, patches: [{ id: rectId, name }],
  } })));
  assert.equal(results.filter(r => r.isError).length, 1);
  assert.equal((await target()).expectedRevision, current.expectedRevision + 1);
});

test("backend validation rejects an invalid batch without a partial commit", async () => {
  const current = await target();
  await assert.rejects(api.rpc("update-file", { id: fileId, sessionId: randomUUID(), revn: current.expectedRevision,
    vern: current.expectedVersion, features: FEATURES,
    changes: [{ type: "mod-page", id: pageId, name: "Should not persist" }, { type: "invalid-change" }],
  }, true));
  assert.equal((await target()).expectedRevision, current.expectedRevision);
  assert.equal((await call("get_page", { fileId, pageId })).name, "Design");
});

test("data survives an MCP process restart", async () => {
  await client.close(); await transport.close();
  const connection = await connect(token); client = connection.mcp; transport = connection.pipe;
  const page = await call("get_page", { fileId, pageId }); assert.equal(page.total, 4);
  const data = await call("get_shapes", { fileId, pageId, shapeIds: [textId] });
  assert.equal(data.shapes[0].content.children[0].children[0].children[0].text, "Updated 日本語");
});

test("another user cannot read or write this file", async () => {
  const other = await provision(); const connection = await connect(other.token);
  try {
    const result = await call("get_file", { fileId }, true, connection.mcp);
    assert.ok(["object-not-found", "not-found", "restriction"].includes(result.code), JSON.stringify(result));
    const result2 = await call("update_shapes", { ...await target(), patches: [{ id: rectId, name: "Unauthorized" }] }, true, connection.mcp);
    assert.equal(result2.outcome, "not_applied");
  } finally { await connection.mcp.close(); await connection.pipe.close(); }
});

test("an invalid token cannot read a file", async () => {
  const connection = await connect("invalid-test-token");
  try {
    const result = await call("get_file", { fileId }, true, connection.mcp);
    assert.equal(result.outcome, "not_applied");
    assert.equal(JSON.stringify(result).includes("invalid-test-token"), false);
  } finally { await connection.mcp.close(); await connection.pipe.close(); }
});

test("delete a board and its descendants and protect the page root", async () => {
  const invalid = await call("delete_shapes", { ...await target(), shapeIds: ["00000000-0000-0000-0000-000000000000"] }, true);
  assert.equal(invalid.code, "root_edit");
  const result = await call("delete_shapes", { ...await target(), shapeIds: [boardId] });
  assert.equal(result.verification, "passed"); assert.equal(result.deletedShapeIds.length, 4);
  assert.equal((await call("get_page", { fileId, pageId })).total, 0);
});
