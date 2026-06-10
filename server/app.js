import { createServer } from "./server.js";

const server = createServer();
const port = Number(process.env.PORT) || 3102;
server.start(port);

let shuttingDown = false;
/** @param {string} signal */
async function shutdown(signal) {
  if (shuttingDown) {
    // Second signal — the user is impatient or stop() is wedged. Bail hard.
    console.warn(`Received ${signal} again, forcing exit`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`Shutting down (${signal})…`);
  // Safety net: never let a stuck connection block exit forever.
  const forceExit = setTimeout(() => {
    console.error("Shutdown timed out after 5s, forcing exit");
    process.exit(1);
  }, 5000);
  forceExit.unref();
  try {
    await server.stop();
  } catch (err) {
    console.error(
      `server stop error: ${/** @type {any} */ (err)?.message ?? err}`,
    );
  }
  clearTimeout(forceExit);
  console.log("Shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("unhandledRejection", (reason) => {
  const err = /** @type {any} */ (reason);
  console.error(
    `unhandledRejection: ${err?.stack ?? err?.message ?? String(err)}`,
  );
});
process.on("uncaughtException", (err) => {
  console.error(`uncaughtException: ${err.stack ?? err.message}`);
});
