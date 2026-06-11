/// <reference types="vite-plugin-pwa/client" />

import { registerSW } from "virtual:pwa-register";

const UPDATE_CHECK_MS = 60 * 60 * 1000;

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
