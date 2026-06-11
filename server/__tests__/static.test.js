import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "../server.js";

// Cache-header tests serve real files from dist/, so they need a build.
const distDir = fileURLToPath(new URL("../../dist", import.meta.url));
const hasDist = existsSync(`${distDir}/index.html`);

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

test("stable URLs revalidate (no-cache)", { skip: !hasDist }, async () => {
  const { app } = createServer();
  for (const path of ["/", "/sw.js"]) {
    const res = await app.request(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("cache-control"), "no-cache", path);
  }
});

test("hashed assets are immutable", { skip: !hasDist }, async () => {
  const { app } = createServer();
  const [asset] = readdirSync(`${distDir}/assets`);
  assert.ok(asset, "dist/assets is empty");
  const res = await app.request(`/assets/${asset}`);
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
});
