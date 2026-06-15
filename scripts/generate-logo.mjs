#!/usr/bin/env bun
// Regenerate assets/logo.png from the app's own color-grading wheel.
//
// Renders drawWheel() from src/ui/grading.js in headless chromium at a
// devicePixelRatio chosen so the 148px detail wheel lands at the same
// proportions as the original 196px hand screenshot, on a transparent
// background — i.e. the screenshot-with-puck-hidden process, but
// pixel-exact at 1024×1024. Needs `npm run dev` serving :5173.
//
//   bun scripts/generate-logo.mjs && npm run icons

import { rmSync } from "node:fs";

const DEV = "http://localhost:5173";
const CDP_PORT = 9333;
// fresh profile every run: a leftover service worker from a previous
// session can silently serve stale code on localhost ports
const PROFILE = `${process.env.HOME}/.cache/raw-editor-logo-chromium`;
const OUT = new URL("../assets/logo.png", import.meta.url).pathname;

// Framing reference: the original logo was a 196px screenshot of the
// 148px wheel (circle at 76% of canvas, on the panel background).
const SIZE = 1024;
const WHEEL_CSS = 148;
const REF_CANVAS = 196;

try {
  await fetch(DEV);
} catch {
  console.error(`dev server not reachable at ${DEV} — run \`npm run dev\``);
  process.exit(1);
}

rmSync(PROFILE, { recursive: true, force: true });
const chrome = Bun.spawn(
  [
    "chromium-browser",
    "--headless=new",
    "--no-sandbox",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    "about:blank",
  ],
  { stdout: "ignore", stderr: "ignore" },
);

try {
  let wsUrl;
  for (let i = 0; i < 50 && !wsUrl; i++) {
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      ).json();
      wsUrl = targets.find((t) => t.type === "page")?.webSocketDebuggerUrl;
    } catch {
      // CDP endpoint not up yet
    }
    // always wait between polls: the endpoint can answer before chromium has
    // created the page target, and busy-looping would burn all retries instantly
    if (!wsUrl) await Bun.sleep(200);
  }
  if (!wsUrl) throw new Error("no CDP page target");

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = ++msgId;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const { result, error } = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (error || result.exceptionDetails) {
      throw new Error(JSON.stringify(error ?? result.exceptionDetails));
    }
    return result.result.value;
  };

  await send("Page.enable");
  await send("Page.navigate", { url: DEV + "/" });

  // wait for the app page (and its stylesheet, for --panel) to be live
  for (let i = 0; i < 50; i++) {
    const ready = await evaluate(
      `location.origin === ${JSON.stringify(DEV)} &&
       document.readyState === "complete" &&
       getComputedStyle(document.documentElement).getPropertyValue("--panel").trim() !== ""`,
    ).catch(() => false);
    if (ready) break;
    await Bun.sleep(200);
  }

  const dataUrl = await evaluate(`(async () => {
    let src = await (await fetch("/src/ui/grading.js")).text();
    // a blob: module can't resolve relative OR root-absolute specifiers
    // (its base URL isn't hierarchical) — make them fully absolute
    const o = location.origin;
    src = src
      .replace(/from\\s+(["'])\\.\\.\\//g, "from $1" + o + "/src/")
      .replace(/from\\s+(["'])\\.\\//g, "from $1" + o + "/src/ui/")
      .replace(/from\\s+(["'])\\//g, "from $1" + o + "/");
    src += "\\nexport { drawWheel };";
    const mod = await import(
      URL.createObjectURL(new Blob([src], { type: "text/javascript" }))
    );

    Object.defineProperty(window, "devicePixelRatio", {
      value: ${SIZE} / ${REF_CANVAS},
      configurable: true,
    });
    const wheel = document.createElement("canvas");
    mod.drawWheel(wheel, ${WHEEL_CSS});

    const out = document.createElement("canvas");
    out.width = out.height = ${SIZE};
    const ctx = out.getContext("2d");
    // leave the canvas transparent; drawWheel renders only the circle
    ctx.drawImage(
      wheel,
      Math.round((${SIZE} - wheel.width) / 2),
      Math.round((${SIZE} - wheel.height) / 2),
    );
    return out.toDataURL("image/png");
  })()`);

  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  await Bun.write(OUT, Buffer.from(base64, "base64"));
  console.log(`${OUT} (${SIZE}x${SIZE})`);
} finally {
  chrome.kill();
  rmSync(PROFILE, { recursive: true, force: true });
}
