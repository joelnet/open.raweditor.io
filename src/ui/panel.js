// Right sidebar: slider sections (WHITE BALANCE, TONE) generated from the
// SECTIONS table and an EXPORT section. Aesthetic per the user's reference:
// colored left accent bars, uppercase monospace headers, green/red value
// readouts.

import { SECTIONS, GRADE_KEYS, HSL_KEYS, EFFECTS_KEYS } from "../state.js";
import { buildGrading } from "./grading.js";
import { buildMixer } from "./mixer.js";
import { buildEffects } from "./effects.js";

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
 * @param {{ onExport: (format: "png" | "jpeg" | "tiff") => void,
 *           onBypassChange: () => void,
 *           onAuto: (title: string) => void,
 *           onRevert: () => void }} handlers
 */
export function buildPanel(
  container,
  store,
  { onExport, onBypassChange, onAuto, onRevert },
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
      store.set({ [def.key]: input.valueAsNumber * def.scale });
    });
    row.addEventListener("dblclick", () => {
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
  const exportRow = el("div", "export-row");
  const pngBtn = /** @type {HTMLButtonElement} */ (
    el("button", "", "Export PNG")
  );
  const jpgBtn = /** @type {HTMLButtonElement} */ (
    el("button", "", "Export JPG")
  );
  const tiffBtn = /** @type {HTMLButtonElement} */ (
    el("button", "", "Export TIFF")
  );
  pngBtn.disabled = true;
  jpgBtn.disabled = true;
  tiffBtn.disabled = true;
  tiffBtn.title = "Uncompressed 16-bit TIFF";
  pngBtn.addEventListener("click", () => onExport("png"));
  jpgBtn.addEventListener("click", () => onExport("jpeg"));
  tiffBtn.addEventListener("click", () => onExport("tiff"));
  exportRow.append(pngBtn, jpgBtn, tiffBtn);
  exportBody.append(exportRow);
  exportSection.append(exportBody);

  // Revert: drop every edit (sliders, crop, bypass) back to the
  // just-opened state.
  const revertSection = el("div", "section section-revert");
  const revertBody = el("div", "revert-body");
  const revertBtn = /** @type {HTMLButtonElement} */ (
    el("button", "", "Revert All Edits")
  );
  revertBtn.type = "button";
  revertBtn.disabled = true;
  revertBtn.addEventListener("click", () => onRevert());
  revertBody.append(revertBtn);
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
      pngBtn.disabled = !enabled;
      jpgBtn.disabled = !enabled;
      tiffBtn.disabled = !enabled;
      revertBtn.disabled = !enabled;
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
    /**
     * @param {boolean} busy
     * @param {"png" | "jpeg" | "tiff"} [format] which export is running
     */
    setExportBusy(busy, format) {
      pngBtn.disabled = busy;
      jpgBtn.disabled = busy;
      tiffBtn.disabled = busy;
      pngBtn.textContent =
        busy && format === "png" ? "Exporting…" : "Export PNG";
      jpgBtn.textContent =
        busy && format === "jpeg" ? "Exporting…" : "Export JPG";
      tiffBtn.textContent =
        busy && format === "tiff" ? "Exporting…" : "Export TIFF";
    },
  };
}
