// Web Share Target receiver, prepended to the generated Workbox worker via
// `workbox.importScripts` in vite.config.js.
//
// Sharing a file into a PWA is specified as a multipart POST to the manifest's
// share_target action. Cloudflare static assets only answer GET, so nothing
// but a service worker can take that POST — this listener does, parks the file
// in a Cache, and bounces the launch to the app, which picks it back up (see
// src/launch.js).
//
// importScripts() lands at the top of sw.js, so this fetch listener is
// registered before Workbox's router and gets first refusal on every request.
// It must therefore stay narrow: anything that is not the share POST falls
// through without calling respondWith(), leaving Workbox's routes intact.
//
// The five constants below are duplicated from src/launch.js — this file is
// copied verbatim out of public/ rather than bundled, so it cannot import
// them. src/__tests__/launch.test.js fails if the two copies drift.
const SHARE_TARGET_ACTION = "/share-target";
const SHARE_TARGET_CACHE = "share-target";
const SHARE_TARGET_FILE_URL = "/__shared-file";
const SHARE_TARGET_LANDING = "/?share-target=1";
const SHARE_TARGET_ERROR = "/?share-target=error";

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "POST" || url.pathname !== SHARE_TARGET_ACTION) {
    return;
  }

  event.respondWith(
    (async () => {
      let stored = false;
      try {
        const cache = await caches.open(SHARE_TARGET_CACHE);
        // Evict a share the app never came back for, before anything below
        // can fail: landing on the success URL with a previous share still
        // sitting in the cache would open the wrong image. This is also what
        // keeps the cache to at most one orphaned file — Workbox's
        // cleanupOutdatedCaches() only ever touches its own precaches.
        await cache.delete(SHARE_TARGET_FILE_URL);

        const form = await event.request.formData();
        // A share sheet may hand over several files; this is a one-image
        // editor, so only the first is kept.
        const file = form.getAll("file").find((v) => v instanceof File);
        if (file) {
          await cache.put(
            SHARE_TARGET_FILE_URL,
            // The name is all that is worth carrying across: multipart
            // encoding already threw the file's mtime away, so `file` here
            // reports the time this POST was parsed.
            new Response(file, {
              headers: {
                "content-type": file.type || "application/octet-stream",
                // Header values are latin-1; RAW filenames are not.
                "x-share-name": encodeURIComponent(file.name),
              },
            }),
          );
          stored = true;
        }
      } catch (err) {
        // Quota, a malformed body, ... Land on the app either way, never on a
        // browser error page.
        console.error("share target failed:", err);
      }
      // Only the worker knows whether the file survived, so it says so in the
      // marker rather than leaving the page to infer it from an empty cache.
      // 303, so reloading the landing page does not re-POST the share.
      return Response.redirect(
        new URL(
          stored ? SHARE_TARGET_LANDING : SHARE_TARGET_ERROR,
          self.location.origin,
        ).href,
        303,
      );
    })(),
  );
});
