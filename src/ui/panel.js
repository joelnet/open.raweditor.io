// Right sidebar: slider sections (WHITE BALANCE, TONE) generated from the
// SECTIONS table and an EXPORT section. Aesthetic per the user's reference:
// colored left accent bars, uppercase monospace headers, green/red value
// readouts.

import { SECTIONS } from "../state.js";

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

/**
 * @param {HTMLElement} sidebar
 * @param {import("../state.js").Store} store
 * @param {{ onExport: () => void }} handlers
 */
export function buildPanel(sidebar, store, { onExport }) {
  /** @type {Map<string, { input: HTMLInputElement, value: HTMLElement,
   *                        decimals: number, scale: number }>} */
  const rows = new Map();

  /** @type {HTMLElement[]} */
  const sections = [];
  for (const { title, sliders } of SECTIONS) {
    const section = el("div", "section");
    section.append(el("div", "section-header", title));

    for (const def of sliders) {
      const row = el("div", "slider-row");
      const label = el("span", "slider-label", def.label);
      const value = el("span", "slider-value", "0");
      const input = /** @type {HTMLInputElement} */ (el("input"));
      input.type = "range";
      input.min = String(def.min);
      input.max = String(def.max);
      input.step = String(def.step);
      input.value = "0";
      input.disabled = true;
      input.setAttribute("aria-label", def.label.toLowerCase());

      input.addEventListener("input", () => {
        store.set({ [def.key]: input.valueAsNumber * def.scale });
      });
      row.addEventListener("dblclick", () => {
        store.set({ [def.key]: 0 });
      });

      row.append(label, value, input);
      section.append(row);
      rows.set(def.key, {
        input,
        value,
        decimals: def.decimals,
        scale: def.scale,
      });
    }
    sections.push(section);
  }

  const exportSection = el("div", "section section-export");
  exportSection.append(el("div", "section-header", "EXPORT"));
  const exportBody = el("div", "export-body");
  const exportBtn = /** @type {HTMLButtonElement} */ (
    el("button", "", "Export PNG")
  );
  exportBtn.disabled = true;
  exportBtn.addEventListener("click", onExport);
  exportBody.append(exportBtn);
  exportSection.append(exportBody);

  sidebar.append(...sections, exportSection);

  store.subscribe((state) => {
    for (const [key, row] of rows) {
      const scaled = state[/** @type {keyof typeof state} */ (key)];
      const raw = scaled / row.scale;
      if (Math.abs(row.input.valueAsNumber - raw) > 1e-9) {
        row.input.value = String(raw);
      }
      const text =
        (raw > 0 ? "+" : "") +
        raw.toFixed(row.decimals).replace(/^-0(\.0*)?$/, "0$1");
      row.value.textContent = text;
      row.value.classList.toggle("pos", raw > 0);
      row.value.classList.toggle("neg", raw < 0);
    }
  });

  return {
    /** @param {boolean} enabled */
    setEnabled(enabled) {
      for (const { input } of rows.values()) input.disabled = !enabled;
      exportBtn.disabled = !enabled;
    },
    /** @param {boolean} busy */
    setExportBusy(busy) {
      exportBtn.disabled = busy;
      exportBtn.textContent = busy ? "Exporting…" : "Export PNG";
    },
  };
}
