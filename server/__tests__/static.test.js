import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../server.js";

test("static middleware does not shadow /healthz", async () => {
  const { app } = createServer();
  const res = await app.request("/healthz");
  assert.equal(res.status, 200);
});

test("unknown path returns 404", async () => {
  const { app } = createServer();
  const res = await app.request("/no-such-file.xyz");
  assert.equal(res.status, 404);
});
