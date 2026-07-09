# Open Raw Editor

A RAW photo editor that runs entirely in the browser. Drop a RAW file,
adjust it with familiar sliders on a live WebGL preview, and export a
full-resolution PNG, JPG, or 16-bit TIFF. Files never leave your machine:
decoding, editing, and export all happen client-side.

## Features

- **RAW decoding** via [libraw-wasm](https://www.npmjs.com/package/libraw-wasm)
  (LibRaw compiled to WebAssembly, pthreads build) in a worker
- **Live preview** on a WebGL2 canvas; every slider is a shader uniform, so
  edits render at full frame rate on a 16-bit linear-light texture
- **White balance**: temp / tint, with auto (gray-world + near-gray refinement)
- **Tone**: exposure, contrast, highlights, shadows, whites, blacks, with auto
- **Color**: vibrance (inverse-saturation weighted, velvia-style) and
  saturation (chroma scale around Rec.709 luma)
- **Noise reduction**: separate luminance (multi-band à trous wavelet
  shrinkage) and color (luma-guided chroma denoise) controls, plus a detail
  slider; the per-image analysis runs once in a worker so the sliders stay
  realtime
- **Crop** with aspect presets, orientation flipping, and a custom ratio saved
  across sessions; **zoom / pan** with pinch support
- **Histogram** (RGB, GPU-computed) and a shot-settings EXIF line
- **Per-section eye toggles** for instant before/after comparison
- **Export** full-resolution PNG, JPG, or uncompressed 16-bit TIFF; the CPU
  path in a worker applies the exact same math as the preview shader
- Responsive layout with a draggable split on touch devices
- **Installable**, and once installed the OS can hand files straight to it:
  "Open with…" / double-click on the desktop (File Handling API) and the
  Android share sheet (Web Share Target)

## Architecture

```
src/
  decode/    libraw-wasm worker client + box downscale to the preview size
  gl/        WebGL2 renderer and GLSL tone pipeline (preview + histogram)
  tone/      pure-JS tone pipeline, shared constants, auto WB/tone statistics
  export/    full-resolution export worker (CPU tone mapping, chunked)
  ui/        panel, crop, zoom, histogram, dropzone, status bar, ...
  launch.js  files handed over by the OS: File Handling + Web Share Target
  state.js   slider definitions + a minimal observable store
  main.js    wiring
server/      Hono static server for the production build
public/      copied verbatim into the build (icons, _headers, share worker)
```

The tone pipeline (white balance → exposure → whites/blacks → contrast →
highlights/shadows → vibrance/saturation → sRGB encode) is implemented twice:
once in GLSL for the preview and histogram, once in JS for the full-res
export. Both interpolate their constants from `src/tone/constants.js` so they
cannot drift apart.

### How a file gets in

Besides the dropzone, an installed app is offered two OS-level entry points,
declared in the manifest (`vite.config.js`) and picked up by `src/launch.js`:

- **File Handling** — `file_handlers` registers the app against `.arw`,
  `.raf`, and `.dng`, so "Open with…" or a double-click launches it.
  Chromium delivers the handles on `window.launchQueue`.
- **Web Share Target** — `share_target` puts the app in the Android share
  sheet. Files can only be shared into a PWA over a multipart POST, and
  Cloudflare's static assets answer nothing but GET, so `public/share-target-sw.js`
  takes the POST inside the service worker, parks the file in a Cache, and
  redirects to `/?share-target=1`, where the page picks it up.

Neither member is honored outside Chromium, and both no-op there rather than
degrading anything. `protocol_handlers` is deliberately absent: it registers
URL schemes (`web+raw://…`), not file types, so it cannot open a local file
and does nothing for this app. `launch_handler` is absent for a sharper
reason — its `focus-existing` mode suppresses the launch navigation, and the
share target *is* a navigation, so opting in would silently drop shared files.

## Development

```sh
npm install
npm run dev
```

libraw-wasm allocates shared `WebAssembly.Memory`, which browsers only allow
on cross-origin-isolated pages; the dev server and the production server
both send the required COOP/COEP headers. `SharedArrayBuffer` additionally
needs a secure context: `localhost` qualifies, but testing from another
device (e.g. a phone on the LAN) needs HTTPS:

```sh
npm run dev:https   # vite with a self-signed cert; accept the warning once
```

Put sample RAW files in `samples/` (gitignored) and append `?open=<name>` to
the URL to auto-load one on startup, e.g. `http://localhost:5173/?open=a7m3.ARW`.

### Scripts

| Script              | What it does                                    |
| ------------------- | ----------------------------------------------- |
| `npm run dev`       | vite dev server                                 |
| `npm run dev:https` | dev server over HTTPS for LAN devices           |
| `npm run dev:server`| Hono server with auto-restart (serves `dist/`)  |
| `npm test`          | node test runner (`src` and `server` suites)    |
| `npm run typecheck` | tsc over JSDoc types (web + node configs)       |
| `npm run lint`      | eslint + prettier (runs typecheck first)        |
| `npm run build`     | production build to `dist/`                     |
| `npm start`         | serve `dist/` with the Hono server (port 3102)  |

Husky runs lint (which includes typecheck) on commit.

## Deployment

The build is static and is served from Cloudflare Workers static assets
(config in `wrangler.jsonc`). Pushing to `main` triggers a Cloudflare deploy
to <https://open.raweditor.io>; the `public/_headers` file carries the
COOP/COEP cross-origin-isolation headers that libraw-wasm needs.

To build and deploy manually:

```sh
npm run build
npx wrangler deploy
```

## Requirements

A browser with WebGL2 and cross-origin isolation support: any recent Chrome,
Firefox, Edge, or Safari 16.4+.

## Special thanks

This editor's image processing leans heavily on the open-source photography
community — most operators are ports of theirs, with the constants and
provenance documented inline in `src/tone/constants.js`. For the noise
reduction in particular:

- **[darktable](https://www.darktable.org/)** and
  **[RawTherapee](https://rawtherapee.com/)** — the noise reduction follows
  their wavelet-denoise recipe: multi-band à trous (B3-spline) wavelet
  shrinkage with soft-threshold coring for luminance, and a luma-guided chroma
  denoise for color. (The sharpening, texture, clarity, dehaze, and film-grain
  operators draw on these two projects as well.)
- **He et al., _Guided Image Filtering_ (ECCV 2010)** — the edge-aware guided
  filter that smooths chroma while preserving luminance edges.
