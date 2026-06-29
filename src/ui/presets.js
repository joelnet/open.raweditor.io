// PRESETS section: a horizontally-scrollable strip of preset "pills" pinned to
// the top of the panel (tap a pill = apply that look instantly — the
// Lightroom-mobile / filter-strip pattern), plus a "+ Save Look" button and a
// "Manage" dialog for rename / delete / import / export. The strip costs one
// row of the scarce bottom-panel height on mobile; the heavier, rarer actions
// live in a <dialog>, mirroring the EXPORT section.
//
// Storage lives in ../presets.js; this module owns only the DOM and re-renders
// after every mutation. The host (main.js) supplies the two bridges to the
// editor state: getLook() (what to save) and applyLook() (how to apply).

import { downloadBlob } from "../export/export.js";
import {
  createPreset,
  deletePreset,
  exportPresetsJson,
  listPresets,
  parsePresetsJson,
  savePreset,
  uniqueName,
} from "../presets.js";

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
 * @param {HTMLElement} container the #panel-scroll column (section is inserted
 *   just below the histogram)
 * @param {{
 *   getLook: () => import("../tone/tone-math.js").ToneSettings,
 *   applyLook: (settings: import("../tone/tone-math.js").ToneSettings) => void
 * }} handlers
 * @returns {{ setEnabled: (enabled: boolean) => void }}
 */
export function buildPresets(container, { getLook, applyLook }) {
  /** @type {import("../presets.js").PresetRecord[]} */
  let presets = [];
  let enabled = false;

  // --- section shell (a peer of the SECTIONS-generated sections) ---
  const section = el("div", "section section-presets");
  const header = el("div", "section-header", "PRESETS");
  section.append(header);

  const strip = el("div", "preset-strip");
  const empty = el(
    "div",
    "preset-empty",
    "No presets yet — save a look below.",
  );
  const actions = el("div", "preset-actions");
  const saveBtn = /** @type {HTMLButtonElement} */ (
    el("button", "preset-save", "+ Save Look")
  );
  saveBtn.type = "button";
  saveBtn.disabled = true;
  const manageBtn = /** @type {HTMLButtonElement} */ (
    el("button", "preset-manage", "Manage")
  );
  manageBtn.type = "button";
  actions.append(saveBtn, manageBtn);
  section.append(strip, empty, actions);

  // hidden file input for JSON import
  const fileInput = /** @type {HTMLInputElement} */ (el("input"));
  fileInput.type = "file";
  fileInput.accept = "application/json,.json";
  fileInput.hidden = true;
  section.append(fileInput);

  // Sit just below the histogram. On mobile the histogram section is
  // display:none, so PRESETS becomes the top of the bottom panel either way.
  const histogram = container.querySelector(".section-histogram");
  if (histogram) histogram.after(section);
  else container.prepend(section);

  // --- name dialog (reused for Save and Rename) ---
  const nameDialog = /** @type {HTMLDialogElement} */ (
    el("dialog", "export-dialog preset-dialog")
  );
  const nameForm = /** @type {HTMLFormElement} */ (el("form", "export-form"));
  nameForm.method = "dialog";
  const nameTitle = el("div", "export-dialog-title", "SAVE PRESET");
  const nameField = el("label", "export-size-field");
  const nameInput = /** @type {HTMLInputElement} */ (el("input"));
  nameInput.type = "text";
  nameInput.maxLength = 60;
  nameInput.setAttribute("aria-label", "preset name");
  nameField.append(el("span", "", "NAME"), nameInput);
  const nameActions = el("div", "export-dialog-actions");
  const nameCancel = /** @type {HTMLButtonElement} */ (
    el("button", "", "Cancel")
  );
  nameCancel.type = "button";
  const nameSave = /** @type {HTMLButtonElement} */ (
    el("button", "export-submit", "Save")
  );
  nameSave.type = "submit";
  nameActions.append(nameCancel, nameSave);
  nameForm.append(nameTitle, nameField, nameActions);
  nameDialog.append(nameForm);
  document.body.append(nameDialog);

  /** @type {((value: string | null) => void) | null} */
  let nameResolve = null;

  /** @param {string} title @param {string} initial @returns {Promise<string | null>} */
  function promptName(title, initial) {
    nameTitle.textContent = title;
    nameInput.value = initial;
    return new Promise((resolve) => {
      nameResolve = resolve;
      if (typeof nameDialog.showModal === "function") nameDialog.showModal();
      else nameDialog.setAttribute("open", "");
      nameInput.focus();
      nameInput.select();
    });
  }

  /** @param {string | null} value */
  function settleName(value) {
    const resolve = nameResolve;
    nameResolve = null;
    if (nameDialog.open) nameDialog.close();
    if (resolve) resolve(value);
  }

  nameForm.addEventListener("submit", (e) => {
    e.preventDefault();
    settleName(nameInput.value);
  });
  nameCancel.addEventListener("click", () => settleName(null));
  // Esc (and any programmatic close) resolves as cancel.
  nameDialog.addEventListener("close", () => settleName(null));

  // --- manage dialog (rename / delete / import / export) ---
  const manageDialog = /** @type {HTMLDialogElement} */ (
    el("dialog", "export-dialog preset-dialog")
  );
  const manageBody = el("div", "export-form");
  const manageTitle = el("div", "export-dialog-title", "PRESETS");
  const manageList = el("div", "preset-manage-list");
  const manageTools = el("div", "preset-manage-tools");
  const importBtn = /** @type {HTMLButtonElement} */ (
    el("button", "", "Import…")
  );
  importBtn.type = "button";
  const exportAllBtn = /** @type {HTMLButtonElement} */ (
    el("button", "", "Export All")
  );
  exportAllBtn.type = "button";
  manageTools.append(importBtn, exportAllBtn);
  const manageActions = el("div", "export-dialog-actions");
  const doneBtn = /** @type {HTMLButtonElement} */ (
    el("button", "export-submit", "Done")
  );
  doneBtn.type = "button";
  manageActions.append(doneBtn);
  manageBody.append(manageTitle, manageList, manageTools, manageActions);
  manageDialog.append(manageBody);
  document.body.append(manageDialog);
  doneBtn.addEventListener("click", () => manageDialog.close());

  /** @returns {string[]} */
  function currentNames() {
    return presets.map((p) => p.name);
  }

  function renderStrip() {
    strip.replaceChildren();
    for (const preset of presets) {
      const pill = /** @type {HTMLButtonElement} */ (
        el("button", "preset-pill", preset.name)
      );
      pill.type = "button";
      pill.title = preset.name;
      pill.disabled = !enabled;
      pill.addEventListener("click", () => applyLook(preset.settings));
      strip.append(pill);
    }
    const hasPresets = presets.length > 0;
    strip.hidden = !hasPresets;
    empty.hidden = hasPresets;
  }

  function renderManageList() {
    manageList.replaceChildren();
    if (presets.length === 0) {
      manageList.append(el("div", "preset-empty", "No presets saved."));
      return;
    }
    for (const preset of presets) {
      const row = el("div", "preset-row");
      const name = el("span", "preset-row-name", preset.name);
      name.title = preset.name;
      const renameBtn = /** @type {HTMLButtonElement} */ (
        el("button", "", "Rename")
      );
      renameBtn.type = "button";
      const deleteBtn = /** @type {HTMLButtonElement} */ (
        el("button", "preset-del", "Delete")
      );
      deleteBtn.type = "button";

      renameBtn.addEventListener("click", async () => {
        const input = await promptName("RENAME PRESET", preset.name);
        if (input == null) return;
        const others = presets
          .filter((p) => p.id !== preset.id)
          .map((p) => p.name);
        const name = uniqueName(input, others);
        await savePreset({ ...preset, name, updatedAt: Date.now() });
        await refresh();
      });

      // Two-step delete: first click arms the row, second confirms. Avoids
      // losing a hand-crafted preset to a single mis-tap.
      deleteBtn.addEventListener("click", async () => {
        if (deleteBtn.dataset.armed === "1") {
          await deletePreset(preset.id);
          await refresh();
        } else {
          deleteBtn.dataset.armed = "1";
          deleteBtn.textContent = "Delete?";
          deleteBtn.classList.add("confirm");
        }
      });

      row.append(name, renameBtn, deleteBtn);
      manageList.append(row);
    }
  }

  async function refresh() {
    presets = await listPresets();
    renderStrip();
    if (manageDialog.open) renderManageList();
  }

  saveBtn.addEventListener("click", async () => {
    if (!enabled) return;
    const input = await promptName(
      "SAVE PRESET",
      uniqueName("Preset", currentNames()),
    );
    if (input == null) return;
    const name = uniqueName(input, currentNames());
    await savePreset(createPreset({ name, settings: getLook() }));
    await refresh();
  });

  manageBtn.addEventListener("click", () => {
    renderManageList();
    if (typeof manageDialog.showModal === "function") manageDialog.showModal();
    else manageDialog.setAttribute("open", "");
  });

  exportAllBtn.addEventListener("click", () => {
    if (presets.length === 0) return;
    const blob = new Blob([exportPresetsJson(presets)], {
      type: "application/json",
    });
    downloadBlob(blob, "raw-editor-presets.json");
  });

  importBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = ""; // allow re-importing the same file later
    if (!file) return;
    const incoming = parsePresetsJson(await file.text());
    const names = currentNames();
    for (const preset of incoming) {
      const name = uniqueName(preset.name, names);
      names.push(name);
      await savePreset({ ...preset, name });
    }
    await refresh();
  });

  // Initial load (presets exist independently of any open image).
  refresh().catch((err) => console.warn("could not load presets:", err));

  return {
    /** @param {boolean} value */
    setEnabled(value) {
      enabled = value;
      saveBtn.disabled = !value;
      for (const pill of strip.querySelectorAll("button")) {
        /** @type {HTMLButtonElement} */ (pill).disabled = !value;
      }
    },
  };
}
