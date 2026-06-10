import { Hono } from "hono";
import { compress } from "hono/compress";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

export function createServer() {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  // libraw-wasm needs cross-origin isolation (shared WebAssembly.Memory).
  app.use(async (c, next) => {
    await next();
    c.header("Cross-Origin-Opener-Policy", "same-origin");
    c.header("Cross-Origin-Embedder-Policy", "require-corp");
  });

  // The built frontend; compress matters for the ~1.4MB libraw wasm asset.
  app.use(compress());
  app.use("/*", serveStatic({ root: "./dist" }));

  /** @type {import("node:http").Server | null} */
  let httpServer = null;

  /** @param {number} port */
  function start(port) {
    const hostname = process.env.HOST || "0.0.0.0";
    const s = serve({ fetch: app.fetch, port, hostname }, (info) => {
      console.log(`Listening on http://${info.address}:${info.port}`);
    });
    httpServer = /** @type {any} */ (s);
    return s;
  }

  /** @returns {Promise<void>} */
  function stop() {
    if (!httpServer) return Promise.resolve();
    const s = httpServer;
    httpServer = null;
    return new Promise((resolve, reject) => {
      s.close((/** @type {any} */ err) => {
        if (err) reject(err);
        else resolve();
      });
      // close() alone waits for keep-alive sockets to go idle; destroy live
      // connections so shutdown completes promptly.
      /** @type {any} */ (s).closeAllConnections?.();
    });
  }

  return { app, start, stop };
}
