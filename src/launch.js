// Two ways the operating system can hand a RAW file to an *installed* app,
// neither of which goes through the dropzone:
//
//   File Handling  — "Open with…" or double-clicking a .ARW on the desktop.
//                    Chromium navigates to the manifest's file_handlers action
//                    and queues the file handles on window.launchQueue.
//   Share Target   — the Android share sheet. The platform POSTs the file to
//                    the manifest's share_target action; the service worker
//                    catches that POST, caches the file, and redirects here.
//
// Both are declared in vite.config.js. Browsers that implement neither simply
// ignore the manifest members, and both entry points below no-op.

/** Duplicated in public/share-target-sw.js, which cannot import them. */
export const SHARE_TARGET_CACHE = "share-target";
export const SHARE_TARGET_FILE_URL = "/__shared-file";
export const SHARE_TARGET_PARAM = "share-target";
/** The worker's verdict on the share, carried in the marker's value. */
export const SHARE_TARGET_OK = "1";
export const SHARE_TARGET_FAILED = "error";

/** Chromium-only; not in lib.dom.
 * @typedef {{ files?: readonly { getFile: () => Promise<File> }[] }} LaunchParams
 * @typedef {{ setConsumer: (c: (params: LaunchParams) => void) => void }} LaunchQueue
 */

/**
 * Reassemble the File the service worker parked in the cache. Only the name
 * survives the platform's multipart encoding — the original mtime does not —
 * so it rides along in a header and `lastModified` falls back to "now", as it
 * would for any freshly constructed File. Nothing depends on it: saved edits
 * key off a hash of the file's bytes.
 * @param {Response} res
 * @returns {Promise<File>}
 */
export async function parseSharedFile(res) {
  const blob = await res.blob();
  const name = res.headers.get("x-share-name");
  // A nameless file loses its extension and so gets turned away by intake,
  // which beats handing libraw something it cannot decode.
  return new File([blob], name ? decodeURIComponent(name) : "shared-file", {
    type: res.headers.get("content-type") ?? "",
  });
}

/** Strip the marker so a reload does not look like a fresh share. */
function clearShareMarker() {
  const url = new URL(location.href);
  url.searchParams.delete(SHARE_TARGET_PARAM);
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

/**
 * Take the file this launch was started with, if it was a share. Returns null
 * on an ordinary visit, and throws if the worker reported that it could not
 * hold on to the file — a share must never fail quietly into an empty editor.
 * @returns {Promise<File | null>}
 */
export async function consumeSharedFile() {
  const verdict = new URLSearchParams(location.search).get(SHARE_TARGET_PARAM);
  if (verdict === null) return null; // an ordinary visit
  clearShareMarker();
  if (verdict === SHARE_TARGET_FAILED || !("caches" in globalThis)) {
    // The worker sends this when nothing usable arrived and when it could not
    // hold what did, so the wording has to cover both.
    throw new Error("the browser could not hand it over (it may be too large)");
  }

  const cache = await caches.open(SHARE_TARGET_CACHE);
  const res = await cache.match(SHARE_TARGET_FILE_URL);
  // The worker said it stored one, so an empty cache means this is a revisit
  // to a stale landing URL rather than a lost share. Open the editor empty.
  if (!res) return null;

  const file = await parseSharedFile(res);
  // One-shot: a reload must not reopen the same image. Best-effort — the file
  // is already in hand, and the next share evicts the entry regardless, so a
  // failed eviction must not sink an open that has already succeeded.
  await cache.delete(SHARE_TARGET_FILE_URL).catch(() => {});
  return file;
}

/**
 * Receive files from a desktop "Open with…". The consumer also fires on a
 * plain icon launch, with no files attached.
 * @param {{ onFile: (file: File) => void, onError: (err: unknown) => void }} handlers
 */
export function initFileHandler({ onFile, onError }) {
  // window.launchQueue, reached through globalThis so this stays testable.
  const queue = /** @type {LaunchQueue | undefined} */ (
    /** @type {any} */ (globalThis).launchQueue
  );
  if (!queue) return;

  queue.setConsumer((params) => {
    // Selecting several files opens one window per file on some platforms and
    // one window with several handles on others; this editor shows one image.
    const [handle] = params.files ?? [];
    if (!handle) return;
    handle.getFile().then(onFile, onError);
  });
}
