import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Documents } from "../src/document/service.js";
import { PenpotClient, PenpotError } from "../src/penpot/client.js";

const fileId = randomUUID(), pageId = randomUUID();
const target = { fileId, pageId, expectedRevision: 0, expectedVersion: 0 };

function fixture(mode: "ok" | "unknown" | "read_failed" | "race" | "mismatch") {
  let written = false;
  const file = { id: fileId, name: "File", projectId: randomUUID(), revn: 0, vern: 0, features: [],
    data: { pages: [pageId], pagesIndex: { [pageId]: { id: pageId, name: "Before", objects: {} } } } };
  const client = new PenpotClient({ url: "https://example.test", token: "secret", fetch: async (url, init) => {
    if (String(url).endsWith("update-file")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.skipValidate, undefined);
      written = true;
      if (mode === "unknown") throw Error("Connection lost after commit");
      file.revn = mode === "race" ? 2 : 1;
      file.data.pagesIndex[pageId].name = mode === "mismatch" ? "Other writer" : "After";
      return Response.json([]);
    }
    if (written && mode === "read_failed") throw Error("Read failed");
    return Response.json(file);
  } });
  return new Documents(client);
}

test("accepted changes with a failed read-back remain marked applied", async () => {
  const result = await fixture("read_failed").renamePage(target, "After");
  assert.equal(result.status, "applied"); assert.equal(result.verification, "read_failed");
});

test("an uncertain write identifies the target for inspection", async () => {
  await assert.rejects(fixture("unknown").renamePage(target, "After"), (e: PenpotError) =>
    e.outcome === "unknown" && e.details?.fileId === fileId && e.details?.pageId === pageId);
});

test("a write race is reported even if the requested values are present", async () => {
  const result = await fixture("race").renamePage(target, "After");
  assert.equal(result.verification, "passed"); assert.equal(result.concurrentChangesDetected, true);
});

test("a read-back mismatch is not reported as verified", async () => {
  const result = await fixture("mismatch").renamePage(target, "After");
  assert.equal(result.status, "applied"); assert.equal(result.verification, "mismatch");
});
