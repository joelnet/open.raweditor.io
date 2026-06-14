// Collapsible sidebar sections: a +/- toggle prepended to each section
// header that hides the section body (everything in the .section except the
// header). All sections start collapsed except the always-open ones
// (EXPORT, REVERT, and INSTALL if it ever exists), which have no toggle.
// Sections are built across several modules, so this runs once over the
// finished #panel-scroll rather than touching each builder.

/** Section classes that must stay open and get no collapse toggle. */
const ALWAYS_OPEN = ["section-export", "section-revert", "section-install"];

/** Section titles that start expanded (still collapsible). */
const DEFAULT_OPEN = new Set(["HISTOGRAM", "WHITE BALANCE", "TONE"]);

/**
 * @param {HTMLElement} container the scroll column holding the .section list
 */
export function initCollapse(container) {
  for (const section of container.querySelectorAll(".section")) {
    if (ALWAYS_OPEN.some((c) => section.classList.contains(c))) continue;
    const header = section.querySelector(":scope > .section-header");
    if (!header) continue;

    // the title is the header's first text node (skip the AUTO/eye buttons).
    // Wrap it in a span with margin-right:auto so the title always sits next
    // to the toggle on the left and the AUTO/eye buttons stay flush right —
    // otherwise justify-content:space-between would re-center it per header.
    const titleNode = Array.from(header.childNodes).find(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim(),
    );
    const title = titleNode?.textContent?.trim() ?? "section";
    if (titleNode) {
      const titleSpan = document.createElement("span");
      titleSpan.className = "section-title";
      titleSpan.textContent = title;
      titleNode.replaceWith(titleSpan);
    }

    const toggle = /** @type {HTMLButtonElement} */ (
      document.createElement("button")
    );
    toggle.type = "button";
    toggle.className = "section-collapse";

    if (!DEFAULT_OPEN.has(title)) section.classList.add("collapsed");

    const sync = () => {
      const collapsed = section.classList.contains("collapsed");
      toggle.textContent = collapsed ? "+" : "−"; // + / − (minus sign)
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.setAttribute(
        "aria-label",
        `${collapsed ? "Expand" : "Collapse"} ${title.toLowerCase()} section`,
      );
    };

    toggle.addEventListener("click", () => {
      section.classList.toggle("collapsed");
      sync();
    });

    sync();
    header.prepend(toggle);
  }
}
