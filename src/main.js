import { Decoder } from "./decode/client.js";
import { boxDownscaleToRgba16 } from "./decode/downscale.js";
import { createRenderer } from "./gl/renderer.js";
import { createStore } from "./state.js";
import { ZERO_SETTINGS } from "./tone/tone-math.js";
import { buildPanel } from "./ui/panel.js";
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
let opening = false;

// --- preview rendering, coalesced to one draw per frame ---

let renderQueued = false;
function queueRender() {
  if (renderQueued || !renderer) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderer.render(store.get());
  });
}
store.subscribe(queueRender);

// --- layout: fit canvas to viewport at the preview's aspect ratio ---

function layout() {
  if (!previewSize || !renderer) return;
  const pad = 24;
  const maxW = Math.max(viewport.clientWidth - pad * 2, 64);
  const maxH = Math.max(viewport.clientHeight - pad * 2, 64);
  const scale = Math.min(
    maxW / previewSize.width,
    maxH / previewSize.height,
    1,
  );
  const cssW = Math.max(1, Math.round(previewSize.width * scale));
  const cssH = Math.max(1, Math.round(previewSize.height * scale));
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const dpr = window.devicePixelRatio || 1;
  renderer.setSize(
    Math.min(Math.round(cssW * dpr), previewSize.width),
    Math.min(Math.round(cssH * dpr), previewSize.height),
  );
  queueRender();
}
window.addEventListener("resize", layout);

// --- open / decode ---

/** @param {File} file */
async function openFile(file) {
  if (!renderer || opening) return;
  opening = true;
  panel.setEnabled(false);
  status.setFile(`Decoding ${file.name}…`);
  status.setProgress("");
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { meta, image, decodeMs } = await decoder.decode(bytes, {
      halfSize: true,
    });
    const preview = boxDownscaleToRgba16(image);
    renderer.setImage(preview);
    previewSize = { width: preview.width, height: preview.height };
    currentFile = file;
    canvas.hidden = false;
    dropzone.setVisible(false);
    store.set({ ...ZERO_SETTINGS });
    layout();
    panel.setEnabled(true);
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
    if (currentFile) panel.setEnabled(true);
  }
}

// --- export ---

/** @param {"png" | "jpeg"} format */
async function onExport(format) {
  if (!currentFile || opening) return;
  const file = currentFile;
  const settings = store.get();
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
      `Exported ${name} (${image.width}×${image.height}, ${(blob.size / 1e6).toFixed(1)}MB)`,
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

const panel = buildPanel(panelScroll, store, { onExport });
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
