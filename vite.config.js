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
        return html.replace("%APP_VERSION%", `v${pkg.version}`);
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
      },
      workbox: {
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
