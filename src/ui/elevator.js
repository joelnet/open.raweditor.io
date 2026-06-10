// Touch scroll rail ("elevator") on the right edge of the slider panel.
// Touch-scrolling over the sliders risks accidental adjustments; dragging
// the rail scrolls #panel-scroll without ever touching a control. Visible
// only on coarse pointers (styles.css) and hidden when nothing overflows.

const MIN_THUMB = 28; // px — comfortable touch target

export function initElevator() {
  const scroller = /** @type {HTMLElement} */ (
    document.getElementById("panel-scroll")
  );
  const rail = /** @type {HTMLElement} */ (document.getElementById("elevator"));
  const thumb = /** @type {HTMLElement} */ (
    rail.querySelector(".elevator-thumb")
  );

  function sync() {
    const max = scroller.scrollHeight - scroller.clientHeight;
    rail.classList.toggle("hidden", max <= 1);
    if (max <= 1) return;
    const trackH = rail.clientHeight;
    const thumbH = Math.max(
      (scroller.clientHeight / scroller.scrollHeight) * trackH,
      MIN_THUMB,
    );
    const y = (scroller.scrollTop / max) * (trackH - thumbH);
    thumb.style.height = `${thumbH}px`;
    thumb.style.transform = `translateY(${y}px)`;
    rail.setAttribute(
      "aria-valuenow",
      String(Math.round((scroller.scrollTop / max) * 100)),
    );
  }

  // Where the pointer grabbed the thumb, so drags track the finger instead
  // of snapping the thumb's top edge to it.
  let grabOffset = 0;

  /** @param {PointerEvent} e */
  function dragTo(e) {
    const track = rail.getBoundingClientRect();
    const thumbH = thumb.getBoundingClientRect().height;
    const range = track.height - thumbH;
    if (range <= 0) return;
    const max = scroller.scrollHeight - scroller.clientHeight;
    const t = (e.clientY - track.top - grabOffset) / range;
    scroller.scrollTop = Math.min(Math.max(t, 0), 1) * max;
  }

  rail.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try {
      rail.setPointerCapture(e.pointerId);
    } catch {
      // non-capturable pointer (synthetic events); drag still works
    }
    const box = thumb.getBoundingClientRect();
    grabOffset =
      e.clientY >= box.top && e.clientY <= box.bottom
        ? e.clientY - box.top // grabbed the thumb: keep relative position
        : box.height / 2; // tapped the track: center thumb on finger
    rail.classList.add("dragging");
    dragTo(e);
  });
  rail.addEventListener("pointermove", (e) => {
    if (rail.classList.contains("dragging")) dragTo(e);
  });
  const end = () => rail.classList.remove("dragging");
  rail.addEventListener("pointerup", end);
  rail.addEventListener("pointercancel", end);

  scroller.addEventListener("scroll", sync);
  const observer = new ResizeObserver(sync);
  observer.observe(scroller);
  observer.observe(rail);
  for (const child of scroller.children) observer.observe(child);
  sync();
}
