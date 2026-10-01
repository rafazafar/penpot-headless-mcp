import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { PenpotClient, PenpotError, optionsFromEnv } from "../src/penpot/client.js";

test("RPC uses JSON, a personal access token, explicit subpath, and no redirects", async () => {
  const c = new PenpotClient({ url: "https://example.test/penpot", token: "test-secret", fetch: async (url, init) => {
    assert.equal(String(url), "https://example.test/penpot/api/rpc/command/get-file");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Token test-secret");
    assert.equal(new Headers(init?.headers).get("accept"), "application/json");
    assert.deepEqual(JSON.parse(String(init?.body)), { id: "file" });
    return Response.json({ id: "file" });
  } });
  assert.deepEqual(await c.rpc("get-file", { id: "file" }), { id: "file" });
});

test("an uncertain write is not retried", async () => {
  let calls = 0;
  const c = new PenpotClient({ url: "https://example.test", token: "secret", fetch: async () => { calls++; throw Error("secret network error"); } });
  await assert.rejects(c.rpc("update-file", {}, true), (e: PenpotError) => e.outcome === "unknown" && !e.message.includes("secret"));
  assert.equal(calls, 1);
});

test("backend errors omit request traces and redact tokens", async () => {
  const c = new PenpotClient({ url: "https://example.test", token: "test-secret", fetch: async () =>
    Response.json({ code: "validation", hint: "bad test-secret", explain: "private request data", trace: "private trace" }, { status: 400 }) });
  await assert.rejects(c.rpc("get-file"), (e: PenpotError) => e.code === "validation" && e.outcome === "not_applied" &&
    !e.message.includes("test-secret") && !e.message.includes("private"));
});

test("malformed success and server errors do not claim a failed write was unapplied", async () => {
  for (const response of [new Response("bad gateway", { status: 502 }), Response.json({ code: "internal" }, { status: 500 })]) {
    const c = new PenpotClient({ url: "https://example.test", token: "secret", fetch: async () => response });
    await assert.rejects(c.rpc("update-file", {}, true), (e: PenpotError) => e.outcome === "unknown");
  }
});

test("request timeout covers an unresponsive backend", async () => {
  const http = createServer(() => {});
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address() as { port: number };
  try {
    const c = new PenpotClient({ url: `http://127.0.0.1:${address.port}`, token: "secret", timeoutMs: 100 });
    await assert.rejects(c.rpc("get-file"), (e: PenpotError) => e.code === "transport_error");
  } finally { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
});

test("configuration rejects absent tokens, invalid timeouts, and credential URLs", () => {
  assert.throws(() => optionsFromEnv({}), /PENPOT_URL/);
  assert.throws(() => optionsFromEnv({ PENPOT_URL: "https://example.test" }), /PENPOT_ACCESS_TOKEN/);
  assert.throws(() => optionsFromEnv({ PENPOT_URL: "https://example.test", PENPOT_ACCESS_TOKEN: "x", PENPOT_TIMEOUT_MS: "NaN" }), /TIMEOUT/);
  for (const url of ["file:///tmp/data", "https://user:pass@example.test", "https://example.test?token=x"]) {
    assert.throws(() => new PenpotClient({ url, token: "x" }));
  }
});
