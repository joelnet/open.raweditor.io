import { Decoder } from "./decode/client.js";
import { boxDownscaleToRgba16, detailMaxEdge } from "./decode/downscale.js";
import { createRenderer, FULL_VIEW } from "./gl/renderer.js";
import { createStore } from "./state.js";
import { ZERO_SETTINGS, cropPixelRect } from "./tone/tone-math.js";
import { orientedDims, frameRectToSource } from "./tone/geometry.js";
import { autoWhiteBalance, autoTone } from "./tone/auto.js";
import { createSpatialAnalyzer } from "./tone/spatial-client.js";
import { createSkyDetector } from "./tone/sky-client.js";
import { buildPanel } from "./ui/panel.js";
import { initHistogram } from "./ui/histogram.js";
import { initCrop } from "./ui/crop.js";
import { initMasks } from "./ui/masks.js";
import { initZoom } from "./ui/zoom.js";
import { initDropzone, isSupportedRaw } from "./ui/dropzone.js";
import { initDivider } from "./ui/divider.js";
import { initElevator } from "./ui/elevator.js";
import { initCollapse } from "./ui/collapse.js";
import { initCompare } from "./ui/compare.js";
import { buildPresets } from "./ui/presets.js";
import { createStatus } from "./ui/status.js";
import { createExporter, downloadBlob } from "./export/export.js";
import { initPwaUpdates, initInstallPrompt } from "./pwa.js";
import { consumeSharedFile, initFileHandler } from "./launch.js";
import {
  cloneSettings,
  createEditSnapshot,
  deleteSavedEdit,
  editKeyForFile,
  loadSavedEdit,
  pruneSavedEdits,
  saveEdit,
} from "./edit-persistence.js";

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
// Own queue for background zoom-detail decodes, so one never delays the
// next opened file's preview decode.
const detailDecoder = new Decoder();
const exporter = createExporter();
const spatial = createSpatialAnalyzer();
/** Guards stale presence-analysis results against newer opens. */
let spatialToken = 0;
const sky = createSkyDetector();
let skyBusy = false;

const renderer = createRenderer(canvas);

/** Reported device memory in GB — a Chrome-only hint, absent elsewhere. */
const deviceMemoryGb =
  /** @type {{ deviceMemory?: number }} */ (navigator).deviceMemory ?? 8;
/** GPU pixel budget for the zoom detail texture (8 bytes/px at RGBA16UI:
 * 16 Mpx ≈ 128 MB), halved on low-memory devices. */
const DETAIL_BUDGET_PX = deviceMemoryGb <= 4 ? 8e6 : 16e6;

/** @type {File | null} */
let currentFile = null;
/** @type {{ width: number, height: number } | null} */
let previewSize = null;
/** Dims of the zoom detail texture once uploaded (source-oriented). */
/** @type {{ width: number, height: number } | null} */
let detailSize = null;
/** Guards stale detail uploads against newer opens/closes. */
let detailToken = 0;
/** Preview pixels kept for image statistics (auto WB / auto tone). */
/** @type {{ pixels: Uint16Array, width: number, height: number } | null} */
let previewImage = null;
let opening = false;
let autosaveReady = false;
let autosaveTimer = 0;
/** @type {string | null} */
let currentEditKey = null;
/** @type {{ name: string, size: number, lastModified: number,
 *           width?: number, height?: number } | null} */
let currentFileInfo = null;

// --- preview rendering, coalesced to one draw per frame ---

let renderQueued = false;
function queueRender() {
  if (renderQueued || !renderer) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    // Compare toggle: render the original tone (and no local masks) while
    // still applying the user's crop/geometry, so before/after lines up.
    const settings = compare.isBefore()
      ? { ...ZERO_SETTINGS }
      : effectiveSettings();
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

function currentEditSnapshot() {
  return createEditSnapshot({
    settings: store.get(),
    cropRect: crop.rect(),
    geometry: crop.geometry(),
    panelBypassed: panel.bypassedSections(),
    masksBypassed: masks.isBypassed(),
  });
}

function scheduleAutosave() {
  if (!autosaveReady || !currentEditKey || !currentFileInfo || opening) return;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    autosaveTimer = 0;
    saveCurrentEdit();
  }, 350);
}

function saveCurrentEdit() {
  if (!autosaveReady || !currentEditKey || !currentFileInfo || opening) return;
  saveEdit({
    key: currentEditKey,
    file: currentFileInfo,
    edit: currentEditSnapshot(),
  }).catch((err) => {
    console.warn("could not save edits:", err);
    status.setError(
      `Could not save edits in this browser: ${/** @type {any} */ (err)?.message ?? err}`,
    );
  });
}

function cancelAutosave() {
  autosaveReady = false;
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = 0;
  }
}

/**
 * @param {ReturnType<typeof createEditSnapshot>} edit
 * @param {{ width: number, height: number }} preview
 */
function restoreEdit(edit, preview) {
  panel.setBypassedSections(edit.panelBypassed);
  masks.setBypassed(edit.masksBypassed);
  crop.setEditState({ rect: edit.cropRect, geometry: edit.geometry });
  const frame = frameSize();
  masks.setFrameSize(
    frame?.width ?? preview.width,
    frame?.height ?? preview.height,
  );
  store.set(edit.settings);
}

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

/** Oriented dims of the sharpest uploaded texture — the real texels the
 * canvas backing store can resolve. */
function renderSize() {
  if (!previewSize) return null;
  const best = detailSize ?? previewSize;
  return orientedDims(crop.geometry().orient, best.width, best.height);
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
  const scale = Math.min(maxW / srcW, maxH / srcH);
  const cssW = Math.max(1, Math.round(srcW * scale));
  const cssH = Math.max(1, Math.round(srcH * scale));
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const dpr = window.devicePixelRatio || 1;
  // backing store capped at the real texels behind the visible region —
  // the detail texture (when loaded) raises this beyond the preview, so
  // hi-DPI displays and zoom get true resolution
  const best = renderSize() ?? frame;
  renderer.setSize(
    Math.min(
      Math.round(cssW * dpr),
      Math.round(Math.max(best.width * rect.w, 1)),
    ),
    Math.min(
      Math.round(cssH * dpr),
      Math.round(Math.max(best.height * rect.h, 1)),
    ),
  );
  crop.reposition();
  masks.reposition();
  queueRender();
}
window.addEventListener("resize", layout);
window.addEventListener("pagehide", () => {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = 0;
  }
  saveCurrentEdit();
});

// --- open / decode ---

/**
 * Upgrade the on-screen image beyond the fit-sized preview so zooming has
 * real pixels to show (issue #5). Two rungs, both off the open critical
 * path: an instant repack of the halfSize decode already in hand, then —
 * only when the sensor fits the pixel budget whole, keeping the work and
 * memory bounded — a background full-resolution decode.
 * @param {import("libraw-wasm").RawImageData} image the halfSize decode
 * @param {{ width: number, height: number }} meta full sensor dims
 * @param {Uint8Array} bytes original file bytes
 * @param {number} token
 */
async function upgradeDetail(image, meta, bytes, token) {
  if (token !== detailToken || !renderer || !previewSize) return;
  const fullW = meta.width || image.width;
  const fullH = meta.height || image.height;
  const maxEdge = detailMaxEdge(
    fullW,
    fullH,
    renderer.maxTextureSize,
    DETAIL_BUDGET_PX,
  );
  /** @param {ReturnType<typeof boxDownscaleToRgba16>} img */
  const apply = (img) => {
    if (token !== detailToken || !renderer) return;
    renderer.setDetail(img);
    detailSize = { width: img.width, height: img.height };
    layout();
  };
  try {
    const half = boxDownscaleToRgba16(image, maxEdge);
    if (half.width > previewSize.width) apply(half);
    if (Math.max(fullW, fullH) > maxEdge) return; // full decode over budget
    if (Math.max(fullW, fullH) <= Math.max(half.width, half.height)) return;
    const { image: full } = await detailDecoder.decode(bytes, {});
    if (token !== detailToken) return;
    apply(boxDownscaleToRgba16(full, maxEdge));
  } catch (err) {
    console.warn("zoom detail upgrade failed:", err);
  }
}

/** @param {File} file */
async function openFile(file) {
  if (!renderer || opening) return;
  opening = true;
  cancelAutosave();
  currentEditKey = null;
  currentFileInfo = null;
  panel.setEnabled(false);
  presets.setEnabled(false);
  crop.setEnabled(false);
  masks.setEnabled(false);
  status.setFile(`Decoding ${file.name}…`);
  status.setProgress("");
  status.setBusy(true);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const editKeyPromise = editKeyForFile(file, bytes);
    const { meta, image, decodeMs } = await decoder.decode(bytes, {
      halfSize: true,
    });
    const editKey = await editKeyPromise;
    const savedEdit = editKey
      ? await loadSavedEdit(editKey).catch((err) => {
          console.warn("could not load saved edits:", err);
          return null;
        })
      : null;
    const preview = boxDownscaleToRgba16(image);
    detailToken++; // any in-flight detail belongs to the previous image
    detailSize = null;
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
    currentEditKey = editKey;
    currentFileInfo = {
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      width: meta.width,
      height: meta.height,
    };
    canvas.hidden = false;
    dropzone.setVisible(false);
    panel.resetBypass();
    masks.resetBypass();
    crop.setImage(preview.width, preview.height, meta.width, meta.height);
    masks.setImage(preview.width, preview.height);
    zoom.reset();
    zoom.setEnabled(true);
    if (savedEdit) restoreEdit(savedEdit, preview);
    else store.set({ ...ZERO_SETTINGS });
    layout();
    panel.setEnabled(true);
    presets.setEnabled(true);
    masks.setEnabled(true);
    histo.setHasImage(true);
    histo.setExif(meta);
    compare.setHasImage(true);
    status.setFile(
      `${file.name} · ${meta.camera_make} ${meta.camera_model} · ` +
        `${meta.width}×${meta.height} (preview decoded in ${(decodeMs / 1000).toFixed(1)}s)` +
        (savedEdit ? " · edits restored" : ""),
    );
    // zoom detail waits for the first painted preview frame
    const job = detailToken;
    requestAnimationFrame(() =>
      setTimeout(() => upgradeDetail(image, meta, bytes, job), 0),
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
    status.clearProgressBar();
    if (currentFile) {
      panel.setEnabled(true);
      presets.setEnabled(true);
      crop.setEnabled(true);
      masks.setEnabled(true);
      autosaveReady = !!currentEditKey;
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
    status.setBusy(true);
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
        const ratio = total > 0 ? done / total : 0;
        status.setProgress(
          `Export: applying tone… ${Math.round(ratio * 100)}%`,
        );
        status.setProgressValue(ratio);
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
    status.clearProgressBar();
  }
}

// --- wiring ---

// Section order in the sidebar follows init order: HISTOGRAM, CROP, then
// the panel's slider sections and EXPORT.
const histo = initHistogram(panelScroll, viewport, { onToggle: queueRender });
const compare = initCompare(viewport, canvas, { onToggle: queueRender });
const crop = initCrop(viewport, canvas, panelScroll, {
  // in crop mode the canvas shows the full frame, so a rect change only
  // moves the overlay + histogram; outside it the rect is the visible
  // region and the canvas aspect must follow
  onRectChange: () => {
    if (crop.isActive()) queueRender();
    else layout();
    scheduleAutosave();
  },
  onModeChange: (active) => {
    zoom.setEnabled(!active && !!previewSize);
    masks.setCropActive(active);
    layout();
    scheduleAutosave();
  },
  // 90° turn or straighten change: the frame aspect may have swapped, so
  // masks re-normalize and the whole layout (canvas aspect) follows
  onGeometryChange: () => {
    const frame = frameSize();
    if (frame) masks.setFrameSize(frame.width, frame.height);
    layout();
    scheduleAutosave();
  },
});
const zoom = initZoom(canvas, viewport, {
  getBounds: () => crop.rect(),
  // detail-aware: double-click 1:1 targets the sharpest loaded texels
  getImageSize: () => renderSize(),
  onChange: () => {
    masks.reposition(); // the overlay maps masks through the zoom window
    queueRender();
  },
});
const masks = initMasks(viewport, canvas, panelScroll, store, {
  getView: () => zoom.view(),
  onUiChange: () => {
    queueRender();
    scheduleAutosave();
  },
  onSkyRequest: () => void addSkyMask(),
});

/** "+ Sky": run the sky-segmentation model over the neutral preview (see
 * sky-worker.js) and land the result as a regular brush-raster mask. The
 * first press downloads the model (~3MB, cached after); a run takes a
 * moment, so the status bar carries the wait and `currentFile` identity
 * guards against the image changing mid-flight. */
async function addSkyMask() {
  if (!previewImage || !currentFile || opening || skyBusy) return;
  const file = currentFile;
  skyBusy = true;
  masks.setSkyBusy(true);
  status.setProgress("Detecting sky…");
  status.setBusy(true);
  try {
    const result = await sky.detect(previewImage, crop.geometry());
    if (file !== currentFile) return; // a different image landed meanwhile
    if (!result) {
      status.setError("No sky detected in this image.");
      return;
    }
    if (masks.addGeneratedMask(result.coverage, result.w, result.h)) {
      status.setProgress("Sky mask added — Paint/Erase refines it");
    } else {
      status.setError("Sky mask not added: mask limit reached.");
    }
  } catch (err) {
    console.error("sky detection failed:", err);
    if (file === currentFile) {
      status.setError(
        `Sky detection failed: ${/** @type {any} */ (err)?.message ?? err}`,
      );
    }
  } finally {
    skyBusy = false;
    masks.setSkyBusy(false);
    status.setBusy(false);
  }
}
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
  const key = currentEditKey;
  cancelAutosave();
  panel.resetBypass();
  masks.resetBypass();
  crop.reset(); // also clears rotation, so the frame is the source again
  masks.setFrameSize(previewSize.width, previewSize.height);
  zoom.reset();
  zoom.setEnabled(true); // crop.reset() may have silently left crop mode
  store.set({ ...ZERO_SETTINGS });
  layout();
  if (key) {
    deleteSavedEdit(key).catch((err) => {
      console.warn("could not delete saved edits:", err);
      status.setError(
        `Could not delete saved edits: ${/** @type {any} */ (err)?.message ?? err}`,
      );
    });
  }
  autosaveReady = !!currentEditKey;
}

// Close: discard the current image and return to the empty dropzone state.
function onClose() {
  if (!currentFile || opening) return;
  cancelAutosave();
  spatialToken++; // invalidate any in-flight presence analysis
  detailToken++; // and any in-flight detail upgrade
  currentFile = null;
  currentEditKey = null;
  currentFileInfo = null;
  previewSize = null;
  previewImage = null;
  detailSize = null;
  canvas.hidden = true;
  dropzone.setVisible(true);
  panel.setEnabled(false);
  presets.setEnabled(false);
  crop.setEnabled(false);
  masks.setEnabled(false);
  zoom.setEnabled(false);
  histo.setHasImage(false);
  histo.setExif(null);
  compare.setHasImage(false);
  panel.resetBypass();
  masks.resetBypass();
  store.set({ ...ZERO_SETTINGS });
  status.setFile("No file loaded: drop a RAW file");
  status.setProgress("");
  status.clearProgressBar();
}

const panel = buildPanel(panelScroll, store, {
  onExport,
  getExportSize: () => crop.exportSize(),
  onBypassChange: () => {
    queueRender();
    scheduleAutosave();
  },
  onAuto,
  onRevert,
  onClose,
});
store.subscribe(() => scheduleAutosave());

// Presets: a file-agnostic look (global scalars only) saved once and applied
// to any image. Saving captures the visible/effective settings; applying
// REPLACES the scalar adjustments but leaves the live masks, crop, and
// geometry untouched (those are image-specific). store.set() then drives the
// existing render + autosave subscriptions, so there's no special wiring.
const presets = buildPresets(panelScroll, {
  getLook: () => panel.effectiveSettings(store.get()),
  applyLook: (settings) => {
    const patch = cloneSettings(settings);
    delete (/** @type {Partial<typeof patch>} */ (patch).masks);
    store.set(patch);
  },
});
initInstallPrompt(panelScroll);
/** @param {string} name */
function rejectFile(name) {
  status.setError(`${name} is not a supported RAW file (.ARW, .RAF, .DNG)`);
}
const dropzone = initDropzone({ onFile: openFile, onReject: rejectFile });

/** Files the OS hands over (file handler, share sheet) skip the dropzone's
 * extension check, so they get it here.
 * @param {File} file */
function intakeFile(file) {
  if (isSupportedRaw(file)) openFile(file);
  else rejectFile(file.name);
}
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
  pruneSavedEdits().catch((err) =>
    console.warn("could not prune saved edits:", err),
  );

  // Installed-PWA entry points: "Open with…" on the desktop, the Android
  // share sheet. Both hand over a file directly; see launch.js.
  initFileHandler({
    onFile: intakeFile,
    onError: (err) =>
      status.setError(
        `Could not open the file: ${/** @type {any} */ (err)?.message ?? err}`,
      ),
  });
  consumeSharedFile()
    .then((file) => {
      if (file) intakeFile(file);
    })
    .catch((err) =>
      status.setError(
        `Could not open the shared file: ${/** @type {any} */ (err)?.message ?? err}`,
      ),
    );

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
