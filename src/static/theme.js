/* Encyclopedia of AI Hallucinations — theme toggle.
 * Vanilla JS, no frameworks. The initial preference read runs synchronously
 * (top-level IIFE) to avoid flash-of-unstyled-content. Wiring the click
 * handler — and inserting the rainbow overlay element, which needs <body> —
 * is deferred until DOMContentLoaded.
 *
 * Preference values: "auto" (default; follows OS), "light", "dark", "rainbow".
 * "rainbow" uses the light palette as its base plus a faint VIBGYOR overlay.
 * Stored under localStorage["eah-theme"].
 */
(function () {
  var KEY = "eah-theme";
  var VALID = { auto: 1, light: 1, dark: 1, rainbow: 1 };

  function readPref() {
    try {
      var v = localStorage.getItem(KEY);
      if (v && VALID[v]) return v;
    } catch (e) {}
    return "auto";
  }

  // The overlay needs document.body, which doesn't exist when this script runs
  // synchronously in <head>. So overlay toggling is a no-op until init().
  function setRainbowOverlay(on) {
    if (!document.body) return;
    var el = document.getElementById("rainbow-overlay");
    if (on && !el) {
      el = document.createElement("div");
      el.id = "rainbow-overlay";
      el.className = "rainbow-overlay";
      el.setAttribute("aria-hidden", "true");
      document.body.appendChild(el);
    } else if (!on && el) {
      el.remove();
    }
  }

  function applyPref(pref) {
    var root = document.documentElement;
    if (pref === "light" || pref === "dark") {
      root.setAttribute("data-theme", pref);
    } else if (pref === "rainbow") {
      root.setAttribute("data-theme", "light"); // light palette is the base
    } else {
      root.removeAttribute("data-theme");
    }
    setRainbowOverlay(pref === "rainbow");
  }

  // Synchronous: must run before paint (sets data-theme; overlay waits for body).
  applyPref(readPref());

  var ICONS = { auto: "◐", light: "☀", dark: "☾", rainbow: "🌈" };
  var NEXT  = { auto: "light", light: "dark", dark: "rainbow", rainbow: "auto" };

  function updateButton(btn, pref) {
    var icon = btn.querySelector(".theme-icon");
    var label = btn.querySelector(".theme-label");
    if (icon) icon.textContent = ICONS[pref] || ICONS.auto;
    if (label) label.textContent = "theme: " + pref;
    btn.setAttribute("aria-label", "Toggle theme (current: " + pref + ")");
  }

  function init() {
    setRainbowOverlay(readPref() === "rainbow"); // body exists now
    var btn = document.getElementById("theme-toggle");
    if (!btn) return;
    updateButton(btn, readPref());
    btn.addEventListener("click", function () {
      var current = readPref();
      var next = NEXT[current] || "auto";
      try {
        localStorage.setItem(KEY, next);
      } catch (e) {}
      applyPref(next);
      updateButton(btn, next);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
