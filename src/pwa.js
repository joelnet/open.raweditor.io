/// <reference types="vite-plugin-pwa/client" />

import { registerSW } from "virtual:pwa-register";

const UPDATE_CHECK_MS = 60 * 60 * 1000;

/** Chromium-only event; not in lib.dom.
 * @typedef {Event & {
 *   prompt: () => Promise<void>,
 *   userChoice: Promise<{ outcome: "accepted" | "dismissed" }>,
 * }} BeforeInstallPromptEvent
 */

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari exposes installed state here instead of display-mode.
    /** @type {{ standalone?: boolean }} */ (navigator).standalone === true
  );
}

function isIos() {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    // iPadOS reports itself as macOS, but Macs have no touch points.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/**
 * Adds an "Install App" section at the end of the panel. Hidden until the
 * browser says the app is installable (`beforeinstallprompt`), and never
 * shown when already running from the home screen / installed window.
 * iOS never fires that event, so there the button reveals manual
 * Add-to-Home-Screen instructions instead.
 * @param {HTMLElement} container
 */
export function initInstallPrompt(container) {
  if (isStandalone()) return;

  const section = document.createElement("div");
  section.className = "section section-install";
  section.hidden = true;

  const body = document.createElement("div");
  body.className = "install-body";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Install App";

  body.append(btn);
  section.append(body);
  container.append(section);

  /** @type {BeforeInstallPromptEvent | null} */
  let deferredPrompt = null;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = /** @type {BeforeInstallPromptEvent} */ (e);
    section.hidden = false;
  });

  // Fires regardless of how the install happened (our button, the
  // browser's address-bar affordance, ...).
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    section.remove();
  });

  if (isIos()) {
    btn.textContent = "Add to Home Screen";
    const hint = document.createElement("p");
    hint.className = "install-hint";
    hint.hidden = true;
    hint.textContent =
      "In Safari: tap the Share button, then \u201cAdd to Home Screen\u201d.";
    body.append(hint);
    btn.addEventListener("click", () => {
      hint.hidden = !hint.hidden;
    });
    section.hidden = false;
    return;
  }

  btn.addEventListener("click", () => {
    if (!deferredPrompt) return;
    const prompt = deferredPrompt;
    // The event is single-use; hide until the browser fires a fresh one.
    deferredPrompt = null;
    section.hidden = true;
    void prompt.prompt();
  });
}

export function initPwaUpdates() {
  if (!("serviceWorker" in navigator)) return;

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh: showUpdateBanner,
    onRegisteredSW(_url, registration) {
      if (!registration) return;

      // Mobile browsers resume a backgrounded PWA without re-fetching the
      // service worker, so without these checks a stale build can stick
      // around indefinitely — even across pull-to-refresh.
      const check = () => void registration.update();
      window.setInterval(check, UPDATE_CHECK_MS);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
    },
  });

  function showUpdateBanner() {
    if (document.getElementById("update-banner")) return;

    const banner = document.createElement("div");
    banner.id = "update-banner";
    banner.setAttribute("role", "status");

    const text = document.createElement("span");
    text.textContent = "A new version is available.";

    const update = document.createElement("button");
    update.type = "button";
    update.className = "update";
    update.textContent = "Update";
    update.addEventListener("click", () => {
      update.disabled = true;
      update.textContent = "Updating…";
      // Sends SKIP_WAITING to the waiting worker; the plugin reloads the
      // page once that worker takes control.
      void updateSW();
    });

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "dismiss";
    dismiss.setAttribute("aria-label", "Dismiss update notice");
    dismiss.textContent = "✕";
    dismiss.addEventListener("click", () => banner.remove());

    banner.append(text, update, dismiss);
    document.body.append(banner);
  }
}
