// Live RGB histogram of the post-tone preview. Desktop: a panel section at
// the top of the sidebar, above WHITE BALANCE. Mobile (≤768px): a small
// toggle button in the viewport's top-right corner that shows a compact
// overlay on top of the image. styles.css media queries pick which one is
// visible; draw() only paints canvases that are actually displayed.

const BINS = 256;

// Channel colors chosen for "screen" compositing: overlaps brighten toward
// white like a classic RGB histogram.
const CHANNELS = /** @type {const} */ ([
  ["r", "rgb(225, 85, 85)"],
  ["g", "rgb(120, 205, 100)"],
  ["b", "rgb(95, 140, 235)"],
]);

/**
 * @param {HTMLCanvasElement} canvas
 * @param {import("../gl/renderer.js").HistogramBins | null} bins
 */
function drawInto(canvas, bins) {
  if (canvas.offsetWidth === 0) return; // hidden by media query / toggle
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  if (!bins) return;

  // Normalize to the tallest interior bin; the clipped-end spikes at 0 and
  // 255 would otherwise flatten everything else.
  let max = 0;
  for (let i = 1; i < BINS - 1; i++) {
    max = Math.max(max, bins.r[i], bins.g[i], bins.b[i]);
  }
  if (max === 0) {
    max = Math.max(
      bins.r[0],
      bins.g[0],
      bins.b[0],
      bins.r[BINS - 1],
      bins.g[BINS - 1],
      bins.b[BINS - 1],
      1,
    );
  }

  ctx.globalCompositeOperation = "screen";
  for (const [key, color] of CHANNELS) {
    const data = bins[key];
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < BINS; i++) {
      const v = Math.min(data[i] / max, 1);
      ctx.lineTo(((i + 0.5) / BINS) * w, h - v * (h - 1));
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";
}

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** @param {number} width @param {number} height */
function makeCanvas(width, height) {
  const canvas = /** @type {HTMLCanvasElement} */ (el("canvas"));
  canvas.width = width;
  canvas.height = height;
  canvas.setAttribute("aria-hidden", "true");
  return canvas;
}

/**
 * @param {HTMLElement} panelContainer sidebar column the section renders into
 * @param {HTMLElement} viewport image pane the mobile toggle/overlay attach to
 * @param {{ onToggle: () => void }} handlers onToggle: overlay opened, redraw
 */
export function initHistogram(panelContainer, viewport, { onToggle }) {
  const section = el("div", "section section-histogram");
  section.append(el("div", "section-header", "HISTOGRAM"));
  const body = el("div", "histo-body");
  const panelCanvas = makeCanvas(BINS, 100);
  body.append(panelCanvas);
  section.append(body);
  panelContainer.append(section);

  const toggle = /** @type {HTMLButtonElement} */ (el("button"));
  toggle.id = "histo-toggle";
  toggle.type = "button";
  toggle.hidden = true; // shown once an image is loaded
  toggle.setAttribute("aria-label", "Toggle histogram");
  toggle.setAttribute("aria-pressed", "false");
  toggle.innerHTML =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">' +
    '<rect x="1" y="9" width="2.8" height="6"/>' +
    '<rect x="4.4" y="3" width="2.8" height="12"/>' +
    '<rect x="7.8" y="6" width="2.8" height="9"/>' +
    '<rect x="11.2" y="10" width="2.8" height="5"/>' +
    "</svg>";

  const overlay = el("div");
  overlay.id = "histo-overlay";
  const overlayCanvas = makeCanvas(BINS, 96);
  overlay.append(overlayCanvas);
  viewport.append(toggle, overlay);

  toggle.addEventListener("click", () => {
    const open = overlay.classList.toggle("open");
    toggle.classList.toggle("active", open);
    toggle.setAttribute("aria-pressed", String(open));
    if (open) onToggle();
  });

  return {
    /** @returns {boolean} true when any histogram canvas is displayed */
    visible() {
      return panelCanvas.offsetWidth > 0 || overlayCanvas.offsetWidth > 0;
    },
    /** @param {import("../gl/renderer.js").HistogramBins | null} bins */
    draw(bins) {
      drawInto(panelCanvas, bins);
      drawInto(overlayCanvas, bins);
    },
    /** @param {boolean} has */
    setHasImage(has) {
      toggle.hidden = !has;
      if (!has) {
        overlay.classList.remove("open");
        toggle.classList.remove("active");
        toggle.setAttribute("aria-pressed", "false");
      }
    },
  };
}
