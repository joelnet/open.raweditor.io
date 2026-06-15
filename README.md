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
- **Crop** with aspect presets, orientation flipping, and a custom ratio saved
  across sessions; **zoom / pan** with pinch support
- **Histogram** (RGB, GPU-computed) and a shot-settings EXIF line
- **Per-section eye toggles** for instant before/after comparison
- **Export** full-resolution PNG, JPG, or uncompressed 16-bit TIFF; the CPU
  path in a worker applies the exact same math as the preview shader
- Responsive layout with a draggable split on touch devices

## Architecture

```
src/
  decode/    libraw-wasm worker client + box downscale to the preview size
  gl/        WebGL2 renderer and GLSL tone pipeline (preview + histogram)
  tone/      pure-JS tone pipeline, shared constants, auto WB/tone statistics
  export/    full-resolution export worker (CPU tone mapping, chunked)
  ui/        panel, crop, zoom, histogram, dropzone, status bar, ...
  state.js   slider definitions + a minimal observable store
  main.js    wiring
server/      Hono static server for the production build
```

The tone pipeline (white balance → exposure → whites/blacks → contrast →
highlights/shadows → vibrance/saturation → sRGB encode) is implemented twice:
once in GLSL for the preview and histogram, once in JS for the full-res
export. Both interpolate their constants from `src/tone/constants.js` so they
cannot drift apart.

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

## Requirements

A browser with WebGL2 and cross-origin isolation support: any recent Chrome,
Firefox, Edge, or Safari 16.4+.
