/* Encyclopedia of AI Hallucinations — theme toggle.
 * Vanilla JS, no frameworks. The initial preference read runs synchronously
 * (top-level IIFE) to avoid flash-of-unstyled-content. Wiring the click
 * handler is deferred until DOMContentLoaded.
 *
 * Preference values: "auto" (default; follows OS), "light", "dark".
 * Stored under localStorage["eah-theme"].
 */
(function () {
  var KEY = "eah-theme";
  var VALID = { auto: 1, light: 1, dark: 1 };

  function readPref() {
    try {
      var v = localStorage.getItem(KEY);
      if (v && VALID[v]) return v;
    } catch (e) {}
    return "auto";
  }

  function applyPref(pref) {
    var root = document.documentElement;
    if (pref === "light" || pref === "dark") {
      root.setAttribute("data-theme", pref);
    } else {
      root.removeAttribute("data-theme");
    }
  }

  // Synchronous: must run before paint.
  applyPref(readPref());

  var ICONS = { auto: "◐", light: "☀", dark: "☾" };
  var NEXT  = { auto: "light", light: "dark", dark: "auto" };

  function updateButton(btn, pref) {
    var icon = btn.querySelector(".theme-icon");
    var label = btn.querySelector(".theme-label");
    if (icon) icon.textContent = ICONS[pref] || ICONS.auto;
    if (label) label.textContent = "theme: " + pref;
    btn.setAttribute("aria-label", "Toggle theme (current: " + pref + ")");
  }

  function init() {
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
