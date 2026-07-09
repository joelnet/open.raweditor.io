import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SHARE_TARGET_CACHE,
  SHARE_TARGET_FAILED,
  SHARE_TARGET_FILE_URL,
  SHARE_TARGET_OK,
  SHARE_TARGET_PARAM,
  consumeSharedFile,
  initFileHandler,
  parseSharedFile,
} from "../launch.js";

const shareTargetSw = readFileSync(
  new URL("../../public/share-target-sw.js", import.meta.url),
  "utf8",
);

/** @param {Record<string, string>} headers */
function cached(headers, body = "raw bytes") {
  return new Response(new Blob([body]), { headers });
}

test("share target constants match the service worker's copy", () => {
  // The worker script is copied out of public/ rather than bundled, so it
  // redeclares these. Drift would silently break the share hand-off.
  assert.match(
    shareTargetSw,
    new RegExp(`SHARE_TARGET_CACHE = "${SHARE_TARGET_CACHE}"`),
  );
  assert.match(
    shareTargetSw,
    new RegExp(`SHARE_TARGET_FILE_URL = "${SHARE_TARGET_FILE_URL}"`),
  );
  assert.match(
    shareTargetSw,
    new RegExp(
      `SHARE_TARGET_LANDING = "/\\?${SHARE_TARGET_PARAM}=${SHARE_TARGET_OK}"`,
    ),
  );
  assert.match(
    shareTargetSw,
    new RegExp(
      `SHARE_TARGET_ERROR = "/\\?${SHARE_TARGET_PARAM}=${SHARE_TARGET_FAILED}"`,
    ),
  );
});

test("the worker redirects with 303 so a reload does not re-POST", () => {
  assert.match(shareTargetSw, /Response\.redirect\([\s\S]*?,\s*303/);
});

test("the worker evicts the previous share before it can fail", () => {
  // Ordering invariant, unreachable from node: if a POST that carries no file
  // (or throws) left an unconsumed share behind, the page would open it. No
  // service worker runtime here, so the source order is what gets pinned.
  const evict = shareTargetSw.indexOf("cache.delete(SHARE_TARGET_FILE_URL)");
  const parse = shareTargetSw.indexOf("event.request.formData()");
  const store = shareTargetSw.indexOf("cache.put(");

  assert.ok(evict > 0 && parse > 0 && store > 0);
  assert.ok(evict < parse, "evict the stale share before parsing the body");
  assert.ok(evict < store, "evict the stale share before storing the new one");
});

test("parseSharedFile restores the name, type, and bytes", async () => {
  const file = await parseSharedFile(
    cached({
      "content-type": "image/x-sony-arw",
      "x-share-name": "DSC01234.ARW",
    }),
  );

  assert.equal(file.name, "DSC01234.ARW");
  assert.equal(file.type, "image/x-sony-arw");
  assert.equal(await file.text(), "raw bytes");
});

test("parseSharedFile decodes a percent-escaped name", async () => {
  // Header values are latin-1, so the worker escapes the filename.
  const file = await parseSharedFile(
    cached({ "x-share-name": encodeURIComponent("På fjället.dng") }),
  );

  assert.equal(file.name, "På fjället.dng");
});

test("parseSharedFile falls back when the worker's name header is missing", async () => {
  const file = await parseSharedFile(cached({ "content-type": "" }));

  // Without an extension, intake turns it away rather than handing libraw a
  // file it cannot decode.
  assert.equal(file.name, "shared-file");
});

/**
 * Stand in for the landing page: a location carrying the worker's marker, and
 * a Cache holding whatever it parked there.
 * @param {{ search: string, entry?: Response, deleteFails?: boolean }} page
 */
async function onLandingPage({ search, entry, deleteFails = false }, body) {
  const store = new Map(entry ? [[SHARE_TARGET_FILE_URL, entry]] : []);
  /** @type {string[]} */
  const replaced = [];
  Object.assign(globalThis, {
    location: new URL(`https://open.raweditor.io/${search}`),
    history: {
      /** @param {unknown} _s @param {unknown} _t @param {string} url */
      replaceState: (_s, _t, url) => replaced.push(url),
    },
    caches: {
      open: async () => ({
        /** @param {string} k */
        match: async (k) => store.get(k),
        /** @param {string} k */
        delete: async (k) => {
          if (deleteFails) throw new Error("cache is wedged");
          return store.delete(k);
        },
      }),
    },
  });
  try {
    return await body({ store, replaced });
  } finally {
    for (const k of ["location", "history", "caches"]) {
      delete (/** @type {any} */ (globalThis)[k]);
    }
  }
}

/** @param {Record<string, string>} headers */
const sharedDng = (headers = { "x-share-name": "a.dng" }) => cached(headers);

test("consumeSharedFile ignores an ordinary visit", async () => {
  await onLandingPage({ search: "" }, async ({ replaced }) => {
    assert.equal(await consumeSharedFile(), null);
    assert.deepEqual(replaced, []); // nothing to clean off the URL
  });
});

test("consumeSharedFile hands back the shared file and drains the cache", async () => {
  await onLandingPage(
    { search: `?${SHARE_TARGET_PARAM}=${SHARE_TARGET_OK}`, entry: sharedDng() },
    async ({ store, replaced }) => {
      const file = await consumeSharedFile();

      assert.equal(file?.name, "a.dng");
      assert.equal(store.size, 0); // one-shot
      assert.deepEqual(replaced, ["/"]); // marker stripped
    },
  );
});

test("consumeSharedFile still opens the file when the cache will not evict it", async () => {
  // The file is already in hand; a wedged cache must not sink the open.
  await onLandingPage(
    {
      search: `?${SHARE_TARGET_PARAM}=${SHARE_TARGET_OK}`,
      entry: sharedDng(),
      deleteFails: true,
    },
    async () => assert.equal((await consumeSharedFile())?.name, "a.dng"),
  );
});

test("consumeSharedFile reports a share the worker could not store", async () => {
  await onLandingPage(
    { search: `?${SHARE_TARGET_PARAM}=${SHARE_TARGET_FAILED}` },
    async ({ replaced }) => {
      // Never a silent drop into an empty editor.
      await assert.rejects(consumeSharedFile(), /could not hand it over/);
      assert.deepEqual(replaced, ["/"]);
    },
  );
});

test("consumeSharedFile treats a stale landing URL as an empty visit", async () => {
  // The worker only ever sends the success marker after a successful put, so
  // an empty cache here means the share was already consumed.
  await onLandingPage(
    { search: `?${SHARE_TARGET_PARAM}=${SHARE_TARGET_OK}` },
    async () => assert.equal(await consumeSharedFile(), null),
  );
});

test("consumeSharedFile keeps other query parameters", async () => {
  await onLandingPage(
    { search: `?open=a.dng&${SHARE_TARGET_PARAM}=${SHARE_TARGET_OK}#z` },
    async ({ replaced }) => {
      await consumeSharedFile();
      assert.deepEqual(replaced, ["/?open=a.dng#z"]);
    },
  );
});

/** @param {() => void} body */
function withLaunchQueue(body) {
  /** @type {((params: unknown) => void) | null} */
  let consumer = null;
  Object.assign(globalThis, {
    launchQueue: {
      /** @param {(params: unknown) => void} c */
      setConsumer: (c) => (consumer = c),
    },
  });
  try {
    body();
    return consumer;
  } finally {
    delete (/** @type {any} */ (globalThis).launchQueue);
  }
}

test("initFileHandler is inert where launchQueue is not implemented", () => {
  assert.equal(/** @type {any} */ (globalThis).launchQueue, undefined);
  assert.doesNotThrow(() =>
    initFileHandler({
      onFile: () => assert.fail("no file should arrive"),
      onError: () => assert.fail("no error should arrive"),
    }),
  );
});

test("initFileHandler opens the first handle of a launch", async () => {
  const shared = new File(["bytes"], "a.dng");
  /** @type {File[]} */
  const opened = [];

  const consumer = withLaunchQueue(() =>
    initFileHandler({ onFile: (f) => opened.push(f), onError: () => {} }),
  );
  consumer?.({
    files: [
      { getFile: async () => shared },
      // A multi-select launch: this editor shows one image at a time.
      { getFile: async () => new File(["bytes"], "b.dng") },
    ],
  });
  await Promise.resolve();

  assert.deepEqual(
    opened.map((f) => f.name),
    ["a.dng"],
  );
});

test("initFileHandler tolerates an icon launch, which carries no files", () => {
  const consumer = withLaunchQueue(() =>
    initFileHandler({
      onFile: () => assert.fail("no file should arrive"),
      onError: () => assert.fail("no error should arrive"),
    }),
  );

  assert.doesNotThrow(() => consumer?.({}));
  assert.doesNotThrow(() => consumer?.({ files: [] }));
});

test("initFileHandler reports a handle that will not open", async () => {
  const failure = new Error("permission denied");
  /** @type {unknown[]} */
  const errors = [];

  const consumer = withLaunchQueue(() =>
    initFileHandler({
      onFile: () => assert.fail("no file should arrive"),
      onError: (err) => errors.push(err),
    }),
  );
  consumer?.({ files: [{ getFile: () => Promise.reject(failure) }] });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(errors, [failure]);
});
