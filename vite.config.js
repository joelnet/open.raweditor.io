import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { VitePWA } from "vite-plugin-pwa";
import pkg from "./package.json" with { type: "json" };

// libraw-wasm is a pthreads build: it allocates shared WebAssembly.Memory,
// which browsers only permit on cross-origin-isolated pages.
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// SharedArrayBuffer additionally requires a secure context. localhost
// qualifies over plain http, but access from other devices (e.g. a phone
// on the LAN) needs https — `npm run dev:https` sets HTTPS=1 to serve a
// self-signed cert. Accept the browser warning once on the device.
const useHttps = !!process.env.HTTPS;

// The RAW formats libraw-wasm is wired up for. None have an IANA
// registration; these `image/x-*` names are the ones Chromium and Android's
// MIME table use. The extensions are declared alongside them because
// platforms disagree about which of the two they match a file on.
const RAW_TYPES = {
  "image/x-sony-arw": [".arw"],
  "image/x-fuji-raf": [".raf"],
  "image/x-adobe-dng": [".dng"],
};

export default defineConfig({
  // libraw-wasm resolves its worker and .wasm via import.meta.url; esbuild
  // pre-bundling would inline the module and break that resolution.
  optimizeDeps: { exclude: ["libraw-wasm"] },
  worker: { format: "es" },
  build: { target: "es2022" },
  plugins: [
    {
      name: "raw-editor-version",
      transformIndexHtml(html) {
        return html.replaceAll("%APP_VERSION%", `v${pkg.version}`);
      },
    },
    ...(useHttps ? [basicSsl()] : []),
    VitePWA({
      // "prompt": a new service worker installs but waits until the user
      // accepts the in-app update notice (see src/pwa.js), instead of
      // silently swapping assets out from under a session.
      registerType: "prompt",
      injectRegister: false,
      manifest: {
        name: "Open Raw Editor",
        short_name: "Open RAW",
        description: "In-browser RAW photo editor",
        start_url: "/",
        display: "standalone",
        background_color: "#10141f",
        theme_color: "#141927",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icons/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
        // Desktop "Open with…" / double-click on a RAW file, once the app is
        // installed. Chromium hands the handles to window.launchQueue; other
        // browsers ignore the member. See src/launch.js.
        //
        // Deliberately no `launch_handler`: its only appealing mode,
        // "focus-existing", suppresses the launch navigation, and the share
        // target below *is* a navigation (a POST), so opting in would drop
        // shared files. The default lets Chromium navigate the existing
        // window, which the launchQueue consumer handles either way.
        file_handlers: [{ action: "/", accept: RAW_TYPES }],
        // Android share sheet. Files can only be shared into a PWA over a
        // multipart POST, which static hosting cannot answer — the service
        // worker intercepts it instead (public/share-target-sw.js).
        share_target: {
          action: "/share-target",
          method: "POST",
          enctype: "multipart/form-data",
          params: {
            files: [
              {
                name: "file",
                accept: [
                  ...Object.keys(RAW_TYPES),
                  ...Object.values(RAW_TYPES).flat(),
                ],
              },
            ],
          },
        },
      },
      workbox: {
        // Prepended to the generated worker, ahead of Workbox's own router,
        // so its fetch listener sees the share-target POST first. The version
        // query defeats the HTTP cache: a worker's imported scripts are
        // fetched through it by default (updateViaCache: "imports"), so a
        // long-lived cache entry could otherwise pin an old copy.
        importScripts: [`/share-target-sw.js?v=${pkg.version}`],
        globPatterns: ["**/*.{html,js,css,wasm}"],
        // No skipWaiting — the page sends SKIP_WAITING when the user opts
        // in. clientsClaim lets the new worker take over the open page so
        // the post-update reload fires.
        clientsClaim: true,
        // libraw wasm is ~1.4MB; Workbox silently skips files over its 2MB
        // default, which would break offline without warning if it grows.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
  server: { host: true, allowedHosts: ["micro"], headers: isolationHeaders },
  preview: { host: true, allowedHosts: ["micro"], headers: isolationHeaders },
});
