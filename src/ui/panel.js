// Right sidebar: slider sections (WHITE BALANCE, TONE) generated from the
// SECTIONS table and an EXPORT section. Aesthetic per the user's reference:
// colored left accent bars, uppercase monospace headers, green/red value
// readouts.

import { SECTIONS, GRADE_KEYS, HSL_KEYS, EFFECTS_KEYS } from "../state.js";
import { buildGrading } from "./grading.js";
import { buildMixer } from "./mixer.js";
import { buildEffects } from "./effects.js";
import { onDoubleTap } from "./double-tap.js";

const MAX_EXPORT_DIMENSION = 32768;

export const EYE_OPEN =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" ' +
  'stroke="currentColor" stroke-width="1.4" aria-hidden="true">' +
  '<path d="M1.5 8s2.5-4.2 6.5-4.2S14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8Z"/>' +
  '<circle cx="8" cy="8" r="2.1"/></svg>';

export const EYE_CLOSED =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" ' +
  'stroke="currentColor" stroke-width="1.4" aria-hidden="true">' +
  '<path d="M1.5 8s2.5-4.2 6.5-4.2S14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8Z"/>' +
  '<circle cx="8" cy="8" r="2.1"/>' +
  '<line x1="2.5" y1="13.5" x2="13.5" y2="2.5"/></svg>';

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
 * @param {HTMLElement} container scrollable column the sections render into
 * @param {import("../state.js").Store} store
 * @param {{ onExport: (opts: { format: "png" | "jpeg" | "tiff",
 *                              width: number, height: number }) => void,
 *           getExportSize: () => { width: number, height: number } | null,
 *           onBypassChange: () => void,
 *           onAdjustmentChange: () => void,
 *           onAuto: (title: string) => void,
 *           onRevert: () => void,
 *           onClose: () => void }} handlers
 */
export function buildPanel(
  container,
  store,
  {
    onExport,
    getExportSize,
    onBypassChange,
    onAdjustmentChange,
    onAuto,
    onRevert,
    onClose,
  },
) {
  /** A key can have several rows (e.g. luminance in 3-way and detail views).
   * @type {{ key: string, input: HTMLInputElement, value: HTMLElement,
   *          decimals: number, scale: number, signed: boolean }[]} */
  const rows = [];

  // Sections whose eye is toggled off: sliders keep their values but are
  // treated as zero by effectiveSettings(), giving a before/after preview.
  /** @type {Set<string>} */
  const bypassed = new Set();
  /** `buttons` holds bespoke section controls (e.g. the EFFECTS NEGATIVE
   *  toggle) so they disable/bypass alongside the slider inputs.
   * @typedef {{ title: string, section: HTMLElement, eye: HTMLButtonElement,
   *              auto: HTMLButtonElement, inputs: HTMLInputElement[],
   *              buttons: HTMLButtonElement[] }} SectionEntry */
  /** @type {SectionEntry[]} */
  const entries = [];
  let panelEnabled = false;

  /** @param {SectionEntry} entry @param {boolean} off */
  function setBypassed(entry, off) {
    if (off) bypassed.add(entry.title);
    else bypassed.delete(entry.title);
    entry.section.classList.toggle("bypassed", off);
    entry.eye.innerHTML = off ? EYE_CLOSED : EYE_OPEN;
    entry.eye.setAttribute("aria-pressed", String(!off));
    entry.auto.disabled = !panelEnabled || off;
    for (const input of entry.inputs) input.disabled = !panelEnabled || off;
    for (const btn of entry.buttons) btn.disabled = !panelEnabled || off;
  }

  /**
   * Build one slider row, registering it for store sync and bypass/disable.
   * @param {import("../state.js").SliderDef} def
   * @param {SectionEntry} entry
   */
  function makeRow(def, entry) {
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
      onAdjustmentChange();
      store.set({ [def.key]: input.valueAsNumber * def.scale });
    });
    onDoubleTap(row, () => {
      onAdjustmentChange();
      store.set({ [def.key]: (def.reset ?? 0) * def.scale });
    });

    row.append(label, value, input);
    entry.inputs.push(input);
    rows.push({
      key: def.key,
      input,
      value,
      decimals: def.decimals,
      scale: def.scale,
      signed: def.signed ?? true,
    });
    return row;
  }

  /** @type {HTMLElement[]} */
  const sections = [];
  for (const sectionDef of SECTIONS) {
    const { title, sliders, auto: hasAuto } = sectionDef;
    const section = el("div", "section");
    const header = el("div", "section-header", title);
    const auto = /** @type {HTMLButtonElement} */ (
      el("button", "section-auto", "AUTO")
    );
    auto.type = "button";
    auto.disabled = true;
    auto.setAttribute("aria-label", `Auto ${title.toLowerCase()}`);
    const eye = /** @type {HTMLButtonElement} */ (el("button", "section-eye"));
    eye.type = "button";
    eye.disabled = true;
    eye.innerHTML = EYE_OPEN;
    eye.setAttribute("aria-label", `Toggle ${title.toLowerCase()} edits`);
    eye.setAttribute("aria-pressed", "true");
    if (hasAuto) header.append(auto);
    header.append(eye);
    section.append(header);

    /** @type {SectionEntry} */
    const entry = { title, section, eye, auto, inputs: [], buttons: [] };
    entries.push(entry);
    auto.addEventListener("click", () => onAuto(title));
    eye.addEventListener("click", () => {
      setBypassed(entry, !bypassed.has(title));
      onBypassChange();
    });

    if (sectionDef.grading) {
      buildGrading(section, store, (def) => makeRow(def, entry));
    } else if (sectionDef.mixer) {
      buildMixer(section, (def) => makeRow(def, entry));
    } else if (sectionDef.effects) {
      const { toggle } = buildEffects(section, store, (def) =>
        makeRow(def, entry),
      );
      toggle.disabled = true;
      entry.buttons.push(toggle);
    } else {
      for (const def of sliders) section.append(makeRow(def, entry));
    }
    sections.push(section);
  }

  const exportSection = el("div", "section section-export");
  exportSection.append(el("div", "section-header", "EXPORT"));
  const exportBody = el("div", "export-body");
  const exportBtn = /** @type {HTMLButtonElement} */ (
    el("button", "export-open", "Export...")
  );
  exportBtn.type = "button";
  exportBtn.disabled = true;
  exportBody.append(exportBtn);
  exportSection.append(exportBody);

  const dialog = /** @type {HTMLDialogElement} */ (
    el("dialog", "export-dialog")
  );
  dialog.setAttribute("aria-labelledby", "export-dialog-title");
  const form = /** @type {HTMLFormElement} */ (el("form", "export-form"));
  form.method = "dialog";
  const title = el("div", "export-dialog-title", "EXPORT");
  title.id = "export-dialog-title";

  const formatGroup = el("fieldset", "export-format");
  const formatLegend = el("legend", "", "TYPE");
  const formats = /** @type {const} */ ([
    ["png", "PNG"],
    ["jpeg", "JPG"],
    ["tiff", "TIFF"],
  ]);
  /** @type {HTMLInputElement[]} */
  const formatInputs = [];
  for (const [value, labelText] of formats) {
    const label = el("label", "export-format-option");
    const input = /** @type {HTMLInputElement} */ (el("input"));
    input.type = "radio";
    input.name = "export-format";
    input.value = value;
    input.checked = value === "png";
    const span = el("span", "", labelText);
    label.append(input, span);
    formatGroup.append(label);
    formatInputs.push(input);
  }
  formatGroup.prepend(formatLegend);

  const sizeGroup = el("div", "export-size");
  const widthLabel = el("label", "export-size-field");
  const widthText = el("span", "", "WIDTH");
  const widthInput = /** @type {HTMLInputElement} */ (el("input"));
  widthInput.type = "number";
  widthInput.inputMode = "numeric";
  widthInput.min = "1";
  widthInput.max = String(MAX_EXPORT_DIMENSION);
  widthInput.step = "1";
  widthLabel.append(widthText, widthInput);

  const heightLabel = el("label", "export-size-field");
  const heightText = el("span", "", "HEIGHT");
  const heightInput = /** @type {HTMLInputElement} */ (el("input"));
  heightInput.type = "number";
  heightInput.inputMode = "numeric";
  heightInput.min = "1";
  heightInput.max = String(MAX_EXPORT_DIMENSION);
  heightInput.step = "1";
  heightLabel.append(heightText, heightInput);
  sizeGroup.append(widthLabel, heightLabel);

  const sizeTools = el("div", "export-size-tools");
  const sourceSize = el("span", "export-source-size");
  const resetSizeBtn = /** @type {HTMLButtonElement} */ (
    el("button", "", "Reset Size")
  );
  resetSizeBtn.type = "button";
  sizeTools.append(sourceSize, resetSizeBtn);

  const actions = el("div", "export-dialog-actions");
  const cancelBtn = /** @type {HTMLButtonElement} */ (
    el("button", "", "Cancel")
  );
  cancelBtn.type = "button";
  const submitBtn = /** @type {HTMLButtonElement} */ (
    el("button", "export-submit", "Export")
  );
  submitBtn.type = "submit";
  actions.append(cancelBtn, submitBtn);
  form.append(title, formatGroup, sizeGroup, sizeTools, actions);
  dialog.append(form);
  document.body.append(dialog);

  /** @type {{ width: number, height: number }} */
  let naturalExportSize = { width: 1, height: 1 };
  let syncingSize = false;

  function selectedFormat() {
    return /** @type {"png" | "jpeg" | "tiff"} */ (
      formatInputs.find((input) => input.checked)?.value ?? "png"
    );
  }

  /** @param {number} value */
  function clampSize(value) {
    return Math.min(
      Math.max(1, Math.round(Number.isFinite(value) ? value : 1)),
      MAX_EXPORT_DIMENSION,
    );
  }

  function syncSourceSize() {
    sourceSize.textContent = `${naturalExportSize.width} × ${naturalExportSize.height} px`;
  }

  function resetExportSize() {
    syncingSize = true;
    widthInput.value = String(naturalExportSize.width);
    heightInput.value = String(naturalExportSize.height);
    syncingSize = false;
  }

  /** @param {"width" | "height"} source */
  function syncBoundSize(source) {
    if (syncingSize) return;
    const ratio = naturalExportSize.width / naturalExportSize.height || 1;
    syncingSize = true;
    if (source === "width") {
      const width = clampSize(widthInput.valueAsNumber);
      widthInput.value = String(width);
      heightInput.value = String(clampSize(width / ratio));
    } else {
      const height = clampSize(heightInput.valueAsNumber);
      heightInput.value = String(height);
      widthInput.value = String(clampSize(height * ratio));
    }
    syncingSize = false;
  }

  function openExportDialog() {
    const size = getExportSize();
    if (!size) return;
    naturalExportSize = {
      width: clampSize(size.width),
      height: clampSize(size.height),
    };
    syncSourceSize();
    resetExportSize();
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    widthInput.focus();
    widthInput.select();
  }

  exportBtn.addEventListener("click", openExportDialog);
  widthInput.addEventListener("input", () => syncBoundSize("width"));
  heightInput.addEventListener("input", () => syncBoundSize("height"));
  resetSizeBtn.addEventListener("click", resetExportSize);
  cancelBtn.addEventListener("click", () => dialog.close());
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const width = clampSize(widthInput.valueAsNumber);
    const height = clampSize(heightInput.valueAsNumber);
    onExport({ format: selectedFormat(), width, height });
    dialog.close();
  });

  // Revert: drop every edit (sliders, crop, bypass) back to the
  // just-opened state. Close discards the image entirely.
  const revertSection = el("div", "section section-revert");
  const revertBody = el("div", "revert-body");
  const revertBtn = /** @type {HTMLButtonElement} */ (
    el("button", "", "Revert All Edits")
  );
  revertBtn.type = "button";
  revertBtn.disabled = true;
  revertBtn.addEventListener("click", () => onRevert());
  const closeBtn = /** @type {HTMLButtonElement} */ (el("button", "", "Close"));
  closeBtn.type = "button";
  closeBtn.disabled = true;
  closeBtn.addEventListener("click", () => onClose());
  revertBody.append(revertBtn, closeBtn);
  revertSection.append(revertBody);

  container.append(...sections, exportSection, revertSection);

  store.subscribe((state) => {
    for (const row of rows) {
      const scaled =
        state[/** @type {import("../state.js").SliderKey} */ (row.key)];
      const raw = scaled / row.scale;
      if (Math.abs(row.input.valueAsNumber - raw) > 1e-9) {
        row.input.value = String(raw);
      }
      const text =
        (row.signed && raw > 0 ? "+" : "") +
        raw.toFixed(row.decimals).replace(/^-0(\.0*)?$/, "0$1");
      row.value.textContent = text;
      row.value.classList.toggle("pos", row.signed && raw > 0);
      row.value.classList.toggle("neg", row.signed && raw < 0);
    }
  });

  return {
    /** @param {boolean} enabled */
    setEnabled(enabled) {
      panelEnabled = enabled;
      for (const entry of entries) {
        entry.eye.disabled = !enabled;
        entry.auto.disabled = !enabled || bypassed.has(entry.title);
        entry.section.classList.toggle("disabled", !enabled);
        for (const input of entry.inputs) {
          input.disabled = !enabled || bypassed.has(entry.title);
        }
        for (const btn of entry.buttons) {
          btn.disabled = !enabled || bypassed.has(entry.title);
        }
      }
      exportBtn.disabled = !enabled;
      revertBtn.disabled = !enabled;
      closeBtn.disabled = !enabled;
    },
    /**
     * Settings with bypassed sections' sliders treated as zero — what the
     * preview, histogram, and export should actually apply.
     * @param {import("../tone/tone-math.js").ToneSettings} settings
     * @returns {import("../tone/tone-math.js").ToneSettings}
     */
    effectiveSettings(settings) {
      if (bypassed.size === 0) return settings;
      const out = { ...settings };
      for (const sec of SECTIONS) {
        if (!bypassed.has(sec.title)) continue;
        const keys = sec.grading
          ? GRADE_KEYS
          : sec.mixer
            ? HSL_KEYS
            : sec.effects
              ? EFFECTS_KEYS
              : sec.sliders.map((d) => d.key);
        for (const key of keys) out[key] = 0;
      }
      return out;
    },
    /** Re-show all sections' edits (used when a new image is opened). */
    resetBypass() {
      for (const entry of entries) setBypassed(entry, false);
    },
    /** @returns {string[]} section titles currently preview-bypassed */
    bypassedSections() {
      return [...bypassed];
    },
    /** @param {readonly string[]} titles */
    setBypassedSections(titles) {
      const next = new Set(titles);
      for (const entry of entries) setBypassed(entry, next.has(entry.title));
    },
    /**
     * @param {boolean} busy
     * @param {"png" | "jpeg" | "tiff"} [format] which export is running
     */
    setExportBusy(busy, format) {
      exportBtn.disabled = busy || !panelEnabled;
      submitBtn.disabled = busy;
      cancelBtn.disabled = busy;
      resetSizeBtn.disabled = busy;
      for (const input of [...formatInputs, widthInput, heightInput]) {
        input.disabled = busy;
      }
      const suffix = format
        ? ` ${format === "jpeg" ? "JPG" : format.toUpperCase()}`
        : "";
      exportBtn.textContent = busy ? `Exporting${suffix}…` : "Export...";
      submitBtn.textContent = busy ? "Exporting..." : "Export";
    },
  };
}
