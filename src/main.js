import { Decoder } from "./decode/client.js";
import { boxDownscaleToRgba16 } from "./decode/downscale.js";
import { createRenderer, FULL_VIEW } from "./gl/renderer.js";
import { createStore } from "./state.js";
import { ZERO_SETTINGS, cropPixelRect } from "./tone/tone-math.js";
import { autoWhiteBalance, autoTone } from "./tone/auto.js";
import { buildPanel } from "./ui/panel.js";
import { initHistogram } from "./ui/histogram.js";
import { initCrop } from "./ui/crop.js";
import { initZoom } from "./ui/zoom.js";
import { initDropzone } from "./ui/dropzone.js";
import { initDivider } from "./ui/divider.js";
import { initElevator } from "./ui/elevator.js";
import { createStatus } from "./ui/status.js";
import { createExporter, downloadBlob } from "./export/export.js";

const canvas = /** @type {HTMLCanvasElement} */ (
  document.getElementById("preview")
);
const viewport = /** @type {HTMLElement} */ (
  document.getElementById("viewport")
);
const panelScroll = /** @type {HTMLElement} */ (
  document.getElementById("panel-scroll")
);

const status = createStatus();
const store = createStore();
const decoder = new Decoder();
const exporter = createExporter();

const renderer = createRenderer(canvas);

/** @type {File | null} */
let currentFile = null;
/** @type {{ width: number, height: number } | null} */
let previewSize = null;
/** Preview pixels kept for image statistics (auto WB / auto tone). */
/** @type {{ pixels: Uint16Array, width: number, height: number } | null} */
let previewImage = null;
let opening = false;

// --- preview rendering, coalesced to one draw per frame ---

let renderQueued = false;
function queueRender() {
  if (renderQueued || !renderer) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const settings = panel.effectiveSettings(store.get());
    // crop mode shows the full frame under the overlay; otherwise the
    // zoom/pan window inside the crop. The histogram always reflects the
    // crop — what an export would contain — regardless of zoom.
    renderer.render(settings, crop.isActive() ? FULL_VIEW : zoom.view());
    if (histo.visible()) {
      histo.draw(renderer.computeHistogram(settings, crop.rect()));
    }
  });
}
store.subscribe(queueRender);

// --- layout: fit canvas to viewport at the visible region's aspect ---

function layout() {
  if (!previewSize || !renderer) return;
  const pad = 24;
  const rect = crop.isActive() ? FULL_VIEW : crop.rect();
  const srcW = Math.max(previewSize.width * rect.w, 1);
  const srcH = Math.max(previewSize.height * rect.h, 1);
  const maxW = Math.max(viewport.clientWidth - pad * 2, 64);
  const maxH = Math.max(viewport.clientHeight - pad * 2, 64);
  const scale = Math.min(maxW / srcW, maxH / srcH, 1);
  const cssW = Math.max(1, Math.round(srcW * scale));
  const cssH = Math.max(1, Math.round(srcH * scale));
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const dpr = window.devicePixelRatio || 1;
  renderer.setSize(
    Math.min(Math.round(cssW * dpr), Math.round(srcW)),
    Math.min(Math.round(cssH * dpr), Math.round(srcH)),
  );
  crop.reposition();
  queueRender();
}
window.addEventListener("resize", layout);

// --- open / decode ---

/** @param {File} file */
async function openFile(file) {
  if (!renderer || opening) return;
  opening = true;
  panel.setEnabled(false);
  crop.setEnabled(false);
  status.setFile(`Decoding ${file.name}…`);
  status.setProgress("");
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { meta, image, decodeMs } = await decoder.decode(bytes, {
      halfSize: true,
    });
    const preview = boxDownscaleToRgba16(image);
    renderer.setImage(preview);
    previewImage = preview;
    previewSize = { width: preview.width, height: preview.height };
    currentFile = file;
    canvas.hidden = false;
    dropzone.setVisible(false);
    panel.resetBypass();
    crop.setImage(preview.width, preview.height, meta.width, meta.height);
    zoom.reset();
    zoom.setEnabled(true);
    store.set({ ...ZERO_SETTINGS });
    layout();
    panel.setEnabled(true);
    histo.setHasImage(true);
    histo.setExif(meta);
    status.setFile(
      `${file.name} — ${meta.camera_make} ${meta.camera_model} — ` +
        `${meta.width}×${meta.height} (preview decoded in ${(decodeMs / 1000).toFixed(1)}s)`,
    );
  } catch (err) {
    console.error(err);
    status.setFile(
      currentFile
        ? `${currentFile.name} — previous image kept`
        : "No file loaded — drop a Sony .ARW or Fujifilm .RAF",
    );
    status.setError(
      `Could not decode ${file.name}: ${/** @type {any} */ (err)?.message ?? err}`,
    );
    if (!currentFile) dropzone.setVisible(true);
  } finally {
    opening = false;
    if (currentFile) {
      panel.setEnabled(true);
      crop.setEnabled(true);
    }
  }
}

// --- export ---

/** @param {"png" | "jpeg"} format */
async function onExport(format) {
  if (!currentFile || opening) return;
  const file = currentFile;
  const settings = panel.effectiveSettings(store.get());
  const cropRect = crop.rect();
  panel.setExportBusy(true, format);
  try {
    status.setProgress("Export: decoding full resolution…");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { image } = await decoder.decode(bytes, {});
    const px = cropPixelRect(cropRect, image.width, image.height);
    status.setProgress("Export: applying tone…");
    const blob = await exporter.exportImage(
      image,
      settings,
      format,
      cropRect,
      (done, total) => {
        status.setProgress(
          `Export: applying tone… ${Math.round((done / total) * 100)}%`,
        );
      },
    );
    const name =
      file.name.replace(/\.[^.]+$/, "") + (format === "jpeg" ? ".jpg" : ".png");
    downloadBlob(blob, name);
    status.setProgress(
      `Exported ${name} (${px.w}×${px.h}, ${(blob.size / 1e6).toFixed(1)}MB)`,
    );
  } catch (err) {
    console.error(err);
    status.setError(
      `Export failed: ${/** @type {any} */ (err)?.message ?? err}`,
    );
  } finally {
    panel.setExportBusy(false);
  }
}

// --- wiring ---

// Section order in the sidebar follows init order: HISTOGRAM, CROP, then
// the panel's slider sections and EXPORT.
const histo = initHistogram(panelScroll, viewport, { onToggle: queueRender });
const crop = initCrop(viewport, canvas, panelScroll, {
  // in crop mode the canvas shows the full frame, so a rect change only
  // moves the overlay + histogram; outside it the rect is the visible
  // region and the canvas aspect must follow
  onRectChange: () => (crop.isActive() ? queueRender() : layout()),
  onModeChange: (active) => {
    zoom.setEnabled(!active && !!previewSize);
    layout();
  },
});
const zoom = initZoom(canvas, viewport, {
  getBounds: () => crop.rect(),
  getImageSize: () => previewSize,
  onChange: queueRender,
});
// Auto WB / auto tone: image statistics over the cropped preview. Auto tone
// runs downstream of white balance, so it sees the current effective WB.
/** @param {string} title */
function onAuto(title) {
  if (!previewImage) return;
  const rect = cropPixelRect(
    crop.rect(),
    previewImage.width,
    previewImage.height,
  );
  if (title === "WHITE BALANCE") {
    store.set(autoWhiteBalance(previewImage, rect));
  } else if (title === "TONE") {
    const { temp, tint } = panel.effectiveSettings(store.get());
    store.set(autoTone(previewImage, rect, { temp, tint }));
  }
}

const panel = buildPanel(panelScroll, store, {
  onExport,
  onBypassChange: queueRender,
  onAuto,
});
const dropzone = initDropzone({
  onFile: openFile,
  onReject: (name) =>
    status.setError(`${name} is not a supported RAW file (.ARW, .RAF)`),
});
initDivider({ onResize: layout });
initElevator();

if (!renderer) {
  status.setError("WebGL2 is not available in this browser — cannot preview.");
} else {
  status.setFile("No file loaded — drop a Sony .ARW or Fujifilm .RAF");
  store.set({ ...ZERO_SETTINGS }); // sync slider readouts

  // Automation/debug hook: ?open=<sample-name> fetches from /samples/.
  const auto = new URLSearchParams(location.search).get("open");
  if (auto) {
    fetch(`/samples/${auto}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`fetch ${auto}: ${res.status}`);
        const buf = await res.arrayBuffer();
        await openFile(new File([buf], auto));
      })
      .catch((err) => status.setError(String(err?.message ?? err)));
  }
}
