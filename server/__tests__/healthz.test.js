import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../server.js";

test("GET /healthz returns ok", async () => {
  const { app } = createServer();
  const res = await app.request("/healthz");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});
