import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// libraw-wasm is a pthreads build: it allocates shared WebAssembly.Memory,
// which browsers only permit on cross-origin-isolated pages.
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// SharedArrayBuffer additionally requires a secure context. localhost
// qualifies over plain http, but access from other devices (e.g. a phone
// on the LAN) needs https — `npm run dev:phone` sets HTTPS=1 to serve a
// self-signed cert. Accept the browser warning once on the device.
const useHttps = !!process.env.HTTPS;

export default defineConfig({
  // libraw-wasm resolves its worker and .wasm via import.meta.url; esbuild
  // pre-bundling would inline the module and break that resolution.
  optimizeDeps: { exclude: ["libraw-wasm"] },
  worker: { format: "es" },
  build: { target: "es2022" },
  plugins: useHttps ? [basicSsl()] : [],
  server: { host: true, headers: isolationHeaders },
  preview: { host: true, headers: isolationHeaders },
});
