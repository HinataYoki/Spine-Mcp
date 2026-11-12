// Shared timeline helpers for the feature videos. Pure functions of the timeline: no clocks, no randomness.
window.K = {
  /** Splits an element's text into spans so it can be typed out. */
  typeable(id) {
    const el = document.getElementById(id);
    const text = el.textContent;
    el.textContent = "";
    for (const ch of text) { const s = document.createElement("span"); s.textContent = ch; el.appendChild(s); }
    return `#${id} span`;
  },
  /** Fade + rise in. */
  rise(tl, target, at, { y = 30, d = 0.45, stagger = 0 } = {}) {
    tl.fromTo(target, { opacity: 0, y }, { opacity: 1, y: 0, duration: d, stagger, ease: "power3.out" }, at);
  },
  /** Slide in from the right (result rows). */
  slide(tl, target, at, { x = 40, d = 0.3 } = {}) {
    tl.fromTo(target, { opacity: 0, x }, { opacity: 1, x: 0, duration: d, ease: "power3.out" }, at);
  },
  /** Scene exit: fade and drift. */
  out(tl, target, at, { x = -60, d = 0.35 } = {}) {
    tl.to(target, { opacity: 0, x, duration: d, ease: "power2.in" }, at);
  },
  /** Brand bug in, hook, outro: the parts every feature video shares. */
  frame(tl, total) {
    tl.fromTo(".bug", { opacity: 0 }, { opacity: 1, duration: 0.5 }, 0.6);
    tl.to(".bug", { opacity: 0, duration: 0.3 }, total - 3.3);
    tl.fromTo(".outro", { opacity: 0, scale: 0.92 }, { opacity: 1, scale: 1, duration: 0.5, ease: "back.out(1.4)" }, total - 3.0);
    tl.fromTo(".outro .tag", { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.4, ease: "power3.out" }, total - 2.5);
    tl.fromTo(".outro .small", { opacity: 0 }, { opacity: 1, duration: 0.4 }, total - 2.05);
  },
};
