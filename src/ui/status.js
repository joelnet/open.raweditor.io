// Bottom status bar plus the shared, always-visible activity indicator used
// for work that can take long enough that the user needs to wait.

export function createStatus() {
  const fileEl = /** @type {HTMLElement} */ (
    document.getElementById("status-file")
  );
  const progressEl = /** @type {HTMLElement} */ (
    document.getElementById("status-progress")
  );
  const appEl = /** @type {HTMLElement} */ (document.getElementById("app"));
  const activityEl = /** @type {HTMLElement} */ (
    document.getElementById("activity-indicator")
  );
  const activityLabelEl = /** @type {HTMLElement} */ (
    document.getElementById("activity-label")
  );
  const activityDetailEl = /** @type {HTMLElement} */ (
    document.getElementById("activity-detail")
  );
  const progressBarEl = /** @type {HTMLElement} */ (
    document.getElementById("activity-progress")
  );
  const progressFillEl = /** @type {HTMLElement} */ (
    document.getElementById("activity-progress-fill")
  );
  /** @type {Map<number, { label: string, detail: string, value: number | null }>} */
  const activities = new Map();
  let nextActivityId = 0;

  const renderActivity = () => {
    let current = null;
    for (const activity of activities.values()) current = activity;
    if (!current) {
      activityEl.hidden = true;
      progressBarEl.classList.remove("busy");
      progressBarEl.removeAttribute("aria-valuenow");
      progressFillEl.style.width = "0";
      appEl.removeAttribute("aria-busy");
      return;
    }
    if (activityLabelEl.textContent !== current.label) {
      activityLabelEl.textContent = current.label;
    }
    if (activityDetailEl.textContent !== current.detail) {
      activityDetailEl.textContent = current.detail;
    }
    activityEl.hidden = false;
    appEl.setAttribute("aria-busy", "true");
    if (current.value === null) {
      progressBarEl.classList.add("busy");
      progressBarEl.removeAttribute("aria-valuenow");
      progressFillEl.style.width = "";
      return;
    }
    progressBarEl.classList.remove("busy");
    progressBarEl.setAttribute(
      "aria-valuenow",
      String(Math.round(current.value * 100)),
    );
    progressFillEl.style.width = `${current.value * 100}%`;
  };

  return {
    /** @param {string} text */
    setFile(text) {
      fileEl.classList.remove("error");
      fileEl.textContent = text;
    },
    /** @param {string} text */
    setProgress(text) {
      progressEl.classList.remove("error");
      progressEl.textContent = text;
    },
    /** @param {string} text */
    setError(text) {
      progressEl.classList.add("error");
      progressEl.textContent = text;
    },
    /** Show the shared indicator with indeterminate progress.
     * @param {string} label
     * @param {string} [detail]
     * @returns {number} activity id */
    startActivity(label, detail = "Please wait") {
      const id = ++nextActivityId;
      activities.set(id, { label, detail, value: null });
      renderActivity();
      return id;
    },
    /** Update the text while an indeterminate activity is running.
     * @param {number} id
     * @param {string} detail */
    setActivityDetail(id, detail) {
      const activity = activities.get(id);
      if (!activity) return;
      activity.detail = detail;
      renderActivity();
    },
    /** Switch the shared indicator to determinate progress.
     * @param {number} id
     * @param {number} value
     * @param {string} [detail] */
    setActivityProgress(id, value, detail) {
      const activity = activities.get(id);
      if (!activity) return;
      const clamped = Math.max(0, Math.min(1, value));
      activity.value = clamped;
      if (detail) activity.detail = detail;
      renderActivity();
    },
    /** @param {number} id */
    clearActivity(id) {
      activities.delete(id);
      renderActivity();
    },
  };
}
