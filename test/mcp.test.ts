import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.js";
import { PenpotClient } from "../src/penpot/client.js";

test("read-only mode removes every write tool from discovery", async () => {
  let requests = 0;
  const server = createServer(new PenpotClient({ url: "https://example.test", token: "secret", fetch: async () => {
    requests++; return Response.json({ id: "00000000-0000-0000-0000-000000000000" });
  } }), true);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 8);
    assert.ok(tools.every(t => t.annotations?.readOnlyHint === true));
    assert.ok(!tools.some(t => t.name === "create_shapes"));
    const result = await client.callTool({ name: "get_profile", arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(requests, 1);
    const absent = await client.callTool({ name: "create_shapes", arguments: {} });
    assert.equal(absent.isError, true);
    assert.equal(requests, 1);
  } finally { await client.close(); await server.close(); }
});

test("invalid tool input is rejected before an HTTP request", async () => {
  let requests = 0;
  const server = createServer(new PenpotClient({ url: "https://example.test", token: "secret", fetch: async () => {
    requests++; return Response.json({});
  } }));
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const result = await client.callTool({ name: "get_file", arguments: { fileId: "not-a-uuid" } });
    assert.equal(result.isError, true);
    assert.equal(requests, 0);
    for (const font of [{ fontFamily: "Inter" }, { fontId: "inter" }]) {
      const invalidFont = await client.callTool({ name: "create_shapes", arguments: {
        fileId: randomUUID(), pageId: randomUUID(), expectedRevision: 0, expectedVersion: 0,
        shapes: [{ type: "text", name: "Title", text: "Hello", x: 0, y: 0, width: 100, height: 50, ...font }],
      } });
      assert.equal(invalidFont.isError, true);
      assert.equal(requests, 0);
    }
    for (const type of ["rect", "circle", "frame"]) {
      for (const fields of [{ text: "Hello" }, { text: "" }, { fontFamily: "Inter", fontId: "inter" }, { fontSize: 16 }]) {
        const invalidText = await client.callTool({ name: "create_shapes", arguments: {
          fileId: randomUUID(), pageId: randomUUID(), expectedRevision: 0, expectedVersion: 0,
          shapes: [{ type, name: "Shape", x: 0, y: 0, width: 100, height: 50, ...fields }],
        } });
        assert.equal(invalidText.isError, true);
        assert.equal(requests, 0);
      }
    }
  } finally { await client.close(); await server.close(); }
});
