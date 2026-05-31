/**
 * Browse filters — progressive enhancement.
 *
 * The browse sidebar is a plain GET form that works without JavaScript (the
 * magnifier button submits every filter at once). When JS is available this
 * upgrades the experience: ticking category checkboxes, changing the model,
 * searching, or clicking a status/sort/pagination link updates the listing
 * in place — no full page reload — and keeps the URL in sync so links stay
 * shareable and Back/Forward work.
 *
 * It swaps the whole #browse-root subtree (sidebar + listing) with the
 * server-rendered version for the new query, so faceted counts, active states,
 * and pagination all stay correct without duplicating any render logic here.
 */
(function () {
  "use strict";
  if (!document.getElementById("browse-root")) return;

  var inflight = null;

  // Build a clean query URL from a filter form, dropping empty values so the
  // URL stays tidy (e.g. no trailing ?q=). Checked category boxes share the
  // name "category", so they serialize as repeated ?category= params.
  function formUrl(form) {
    var params = new URLSearchParams();
    new FormData(form).forEach(function (value, key) {
      if (value !== "" && value != null) params.append(key, value);
    });
    var qs = params.toString();
    return form.getAttribute("action") + (qs ? "?" + qs : "");
  }

  // Fetch the target URL, parse it, and replace #browse-root in place. Falls
  // back to a normal navigation if anything goes wrong.
  function load(url, push) {
    if (inflight) inflight.abort();
    var controller = new AbortController();
    inflight = controller;
    document.getElementById("browse-root").setAttribute("aria-busy", "true");
    fetch(url, { signal: controller.signal, headers: { "X-Requested-With": "fetch" } })
      .then(function (r) {
        if (!r.ok) throw new Error("bad status");
        return r.text();
      })
      .then(function (html) {
        var fresh = new DOMParser().parseFromString(html, "text/html").getElementById("browse-root");
        var current = document.getElementById("browse-root");
        if (!fresh || !current) { window.location.assign(url); return; }
        current.replaceWith(document.importNode(fresh, true));
        if (push) history.pushState({ browse: true }, "", url);
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") return;
        window.location.assign(url);
      })
      .finally(function () {
        if (inflight === controller) inflight = null;
        var el = document.getElementById("browse-root");
        if (el) el.removeAttribute("aria-busy");
      });
  }

  // Search / Enter / no-JS submit button → apply all current filters.
  document.addEventListener("submit", function (e) {
    var form = e.target.closest("[data-browse-filters]");
    if (!form) return;
    e.preventDefault();
    load(formUrl(form), true);
  });

  // Live-apply category checkboxes and the model dropdown the moment they change.
  document.addEventListener("change", function (e) {
    if (!e.target.matches('[data-browse-filters] input[type="checkbox"], [data-browse-filters] select')) return;
    var form = e.target.closest("[data-browse-filters]");
    if (form) load(formUrl(form), true);
  });

  // Intercept in-listing browse links (status, sort, pagination, the
  // "All categories" reset, in-card category/tag links). Entry permalinks
  // (/e/...) and external links are left to navigate normally.
  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest("#browse-root a");
    if (!a) return;
    var href = a.getAttribute("href");
    if (!href || href.indexOf("/browse") !== 0) return;
    e.preventDefault();
    load(href, true);
  });

  // Back/Forward: re-render the listing for the restored URL.
  window.addEventListener("popstate", function () {
    if (document.getElementById("browse-root")) load(window.location.href, false);
  });
})();
