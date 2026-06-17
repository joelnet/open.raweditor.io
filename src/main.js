import { Decoder } from "./decode/client.js";
import { boxDownscaleToRgba16 } from "./decode/downscale.js";
import { createRenderer, FULL_VIEW } from "./gl/renderer.js";
import { createStore } from "./state.js";
import { ZERO_SETTINGS, cropPixelRect } from "./tone/tone-math.js";
import { orientedDims, frameRectToSource } from "./tone/geometry.js";
import { autoWhiteBalance, autoTone } from "./tone/auto.js";
import { createSpatialAnalyzer } from "./tone/spatial-client.js";
import { buildPanel } from "./ui/panel.js";
import { initHistogram } from "./ui/histogram.js";
import { initCrop } from "./ui/crop.js";
import { initMasks } from "./ui/masks.js";
import { initZoom } from "./ui/zoom.js";
import { initDropzone } from "./ui/dropzone.js";
import { initDivider } from "./ui/divider.js";
import { initElevator } from "./ui/elevator.js";
import { initCollapse } from "./ui/collapse.js";
import { createStatus } from "./ui/status.js";
import { createExporter, downloadBlob } from "./export/export.js";
import { initPwaUpdates, initInstallPrompt } from "./pwa.js";

initPwaUpdates();

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
const spatial = createSpatialAnalyzer();
/** Guards stale presence-analysis results against newer opens. */
let spatialToken = 0;

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
    const settings = effectiveSettings();
    const geometry = crop.geometry();
    // crop mode shows the full frame under the overlay; otherwise the
    // zoom/pan window inside the crop. The histogram always reflects the
    // crop — what an export would contain — regardless of zoom.
    renderer.render(settings, crop.isActive() ? FULL_VIEW : zoom.view(), {
      maskOverlay: masks.overlayIndex(),
      geometry,
    });
    if (histo.visible()) {
      histo.draw(renderer.computeHistogram(settings, crop.rect(), geometry));
    }
  });
}
store.subscribe(queueRender);

/** Sliders with section bypasses applied, then disabled masks neutralized —
 * what the preview, histogram, and export should actually apply. */
function effectiveSettings() {
  return masks.effective(panel.effectiveSettings(store.get()));
}

// --- layout: fit canvas to viewport at the visible region's aspect ---

/** Preview dims of the oriented image (the frame the crop rect lives in). */
function frameSize() {
  if (!previewSize) return null;
  const g = crop.geometry();
  return orientedDims(g.orient, previewSize.width, previewSize.height);
}

function layout() {
  const frame = frameSize();
  if (!frame || !renderer) return;
  const pad = 24;
  const rect = crop.isActive() ? FULL_VIEW : crop.rect();
  const srcW = Math.max(frame.width * rect.w, 1);
  const srcH = Math.max(frame.height * rect.h, 1);
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
  masks.reposition();
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
  masks.setEnabled(false);
  status.setFile(`Decoding ${file.name}…`);
  status.setProgress("");
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { meta, image, decodeMs } = await decoder.decode(bytes, {
      halfSize: true,
    });
    const preview = boxDownscaleToRgba16(image);
    renderer.setImage(preview);
    // Presence (texture/clarity/dehaze) aux planes compute off-thread;
    // the sliders take effect as soon as they land.
    const token = ++spatialToken;
    spatial
      .analyze(preview)
      .then((aux) => {
        if (token !== spatialToken || !renderer) return;
        renderer.setAux(aux);
        queueRender();
      })
      .catch((err) => console.error("presence analysis failed:", err));
    previewImage = preview;
    previewSize = { width: preview.width, height: preview.height };
    currentFile = file;
    canvas.hidden = false;
    dropzone.setVisible(false);
    panel.resetBypass();
    masks.resetBypass();
    crop.setImage(preview.width, preview.height, meta.width, meta.height);
    masks.setImage(preview.width, preview.height);
    zoom.reset();
    zoom.setEnabled(true);
    store.set({ ...ZERO_SETTINGS });
    layout();
    panel.setEnabled(true);
    masks.setEnabled(true);
    histo.setHasImage(true);
    histo.setExif(meta);
    status.setFile(
      `${file.name} · ${meta.camera_make} ${meta.camera_model} · ` +
        `${meta.width}×${meta.height} (preview decoded in ${(decodeMs / 1000).toFixed(1)}s)`,
    );
  } catch (err) {
    console.error(err);
    status.setFile(
      currentFile
        ? `${currentFile.name} (previous image kept)`
        : "No file loaded: drop a RAW file",
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
      masks.setEnabled(true);
    }
  }
}

// --- export ---

/** @param {{ format: "png" | "jpeg" | "tiff", width: number, height: number }} opts */
async function onExport(opts) {
  if (!currentFile || opening) return;
  const { format, width, height } = opts;
  const file = currentFile;
  const settings = effectiveSettings();
  const cropRect = crop.rect();
  const geometry = crop.geometry();
  panel.setExportBusy(true, format);
  try {
    status.setProgress("Export: decoding full resolution…");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { image } = await decoder.decode(bytes, {});
    status.setProgress("Export: applying tone…");
    const blob = await exporter.exportImage(
      image,
      settings,
      format,
      cropRect,
      geometry,
      previewSize?.width ?? 0,
      { width, height },
      (done, total) => {
        status.setProgress(
          `Export: applying tone… ${Math.round((done / total) * 100)}%`,
        );
      },
    );
    const ext =
      format === "jpeg" ? ".jpg" : format === "tiff" ? ".tif" : ".png";
    const name = file.name.replace(/\.[^.]+$/, "") + ext;
    downloadBlob(blob, name);
    status.setProgress(
      `Exported ${name} (${width}×${height}, ${(blob.size / 1e6).toFixed(1)}MB)`,
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
    masks.setCropActive(active);
    layout();
  },
  // 90° turn or straighten change: the frame aspect may have swapped, so
  // masks re-normalize and the whole layout (canvas aspect) follows
  onGeometryChange: () => {
    const frame = frameSize();
    if (frame) masks.setFrameSize(frame.width, frame.height);
    layout();
  },
});
const zoom = initZoom(canvas, viewport, {
  getBounds: () => crop.rect(),
  getImageSize: () => frameSize(),
  onChange: () => {
    masks.reposition(); // the overlay maps masks through the zoom window
    queueRender();
  },
});
const masks = initMasks(viewport, canvas, panelScroll, store, {
  getView: () => zoom.view(),
  onUiChange: queueRender,
});
// Auto WB / auto tone: image statistics over the cropped preview. Auto tone
// runs downstream of white balance, so it sees the current effective WB.
/** @param {string} title */
function onAuto(title) {
  if (!previewImage) return;
  // Stats run on the source-oriented preview pixels; map the frame-space
  // crop back through the 90° turns (the straighten angle is ignored —
  // close enough for statistics).
  const rect = cropPixelRect(
    frameRectToSource(crop.geometry().orient, crop.rect()),
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

// Revert: back to the just-opened state — sliders, masks, crop, bypass,
// and zoom.
function onRevert() {
  if (!previewSize) return;
  panel.resetBypass();
  masks.resetBypass();
  crop.reset(); // also clears rotation, so the frame is the source again
  masks.setFrameSize(previewSize.width, previewSize.height);
  zoom.reset();
  zoom.setEnabled(true); // crop.reset() may have silently left crop mode
  store.set({ ...ZERO_SETTINGS });
  layout();
}

const panel = buildPanel(panelScroll, store, {
  onExport,
  getExportSize: () => crop.exportSize(),
  onBypassChange: queueRender,
  onAuto,
  onRevert,
});
initInstallPrompt(panelScroll);
const dropzone = initDropzone({
  onFile: openFile,
  onReject: (name) =>
    status.setError(`${name} is not a supported RAW file (.ARW, .RAF, .DNG)`),
});
// Collapse every section by default (except EXPORT / REVERT) — runs after all
// sections (histogram, crop, masks, and the panel sections) are in the DOM.
initCollapse(panelScroll);
initDivider({ onResize: layout });
initElevator();

if (!renderer) {
  status.setError(
    "WebGL2 is not available in this browser, so it cannot preview.",
  );
} else {
  status.setFile("No file loaded: drop a RAW file");
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
