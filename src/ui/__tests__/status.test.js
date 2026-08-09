import test from "node:test";
import assert from "node:assert/strict";

import { createStatus } from "../status.js";

function fakeElement() {
  const attributes = new Map();
  const classes = new Set();
  return {
    hidden: false,
    textContent: "",
    style: { width: "" },
    classList: {
      add(...tokens) {
        for (const token of tokens) classes.add(token);
      },
      remove(...tokens) {
        for (const token of tokens) classes.delete(token);
      },
      contains(token) {
        return classes.has(token);
      },
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
  };
}

test("activity indicator restores overlapping work and clears when idle", () => {
  const ids = [
    "app",
    "status-file",
    "status-progress",
    "activity-indicator",
    "activity-label",
    "activity-detail",
    "activity-progress",
    "activity-progress-fill",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, fakeElement()]));
  const previousDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      getElementById(id) {
        return elements[id] ?? null;
      },
    },
  });

  try {
    const status = createStatus();
    const openId = status.startActivity("OPENING PHOTO", "photo.arw");
    assert.equal(elements["activity-indicator"].hidden, false);
    assert.equal(elements["activity-label"].textContent, "OPENING PHOTO");
    assert.equal(elements.app.getAttribute("aria-busy"), "true");
    assert.equal(
      elements["activity-progress"].classList.contains("busy"),
      true,
    );

    const exportId = status.startActivity("EXPORTING JPG", "Decoding");
    status.setActivityProgress(openId, 0.5, "Halfway");
    assert.equal(elements["activity-label"].textContent, "EXPORTING JPG");

    status.clearActivity(exportId);
    assert.equal(elements["activity-label"].textContent, "OPENING PHOTO");
    assert.equal(elements["activity-detail"].textContent, "Halfway");
    assert.equal(elements["activity-progress-fill"].style.width, "50%");

    status.clearActivity(openId);
    assert.equal(elements["activity-indicator"].hidden, true);
    assert.equal(elements.app.getAttribute("aria-busy"), null);
  } finally {
    if (previousDocument) {
      Object.defineProperty(globalThis, "document", previousDocument);
    } else {
      delete globalThis.document;
    }
  }
});
