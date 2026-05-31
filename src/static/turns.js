/* Encyclopedia of AI Hallucinations — multi-turn submission form helper.
 *
 * Progressive enhancement for the conversation fieldset (data-transcript):
 *   - toggles between the structured "turns" boxes and the pasted "block"
 *     textarea based on the selected mode radio;
 *   - "Add turn" clones a turn box client-side (no server round-trip);
 *   - "Remove turn" deletes a box (keeping at least one).
 *
 * Degrades gracefully: with JS off, all three regions are visible and the
 * "Add turn" / "Remove turn" buttons are plain submit buttons that re-render
 * the form server-side. This script intercepts them and prevents that submit.
 * Vanilla JS, no frameworks — matches theme.js style.
 */
(function () {
  "use strict";
  var root = document.querySelector("[data-transcript]");
  if (!root) return;

  var list = root.querySelector("[data-turns-list]");
  var turnsRegion = root.querySelector(".transcript-turns");
  var actionsRegion = root.querySelector(".transcript-turns-actions");
  var blockRegion = root.querySelector("[data-block]");
  var MAX_TURNS = 100;

  function mode() {
    var checked = root.querySelector('input[name="transcript_mode"]:checked');
    return checked ? checked.value : "turns";
  }

  // Show the structured boxes OR the pasted block, per the selected radio.
  function applyMode() {
    var block = mode() === "block";
    if (turnsRegion) turnsRegion.style.display = block ? "none" : "";
    if (actionsRegion) actionsRegion.style.display = block ? "none" : "";
    if (blockRegion) blockRegion.style.display = block ? "" : "none";
  }

  function renumber() {
    var boxes = list ? list.querySelectorAll("[data-turn]") : [];
    for (var i = 0; i < boxes.length; i++) {
      var ta = boxes[i].querySelector('textarea[name="turn_content"]');
      if (ta && !ta.value) ta.setAttribute("placeholder", "turn " + (i + 1) + " text");
    }
  }

  function addTurn() {
    if (!list) return;
    var boxes = list.querySelectorAll("[data-turn]");
    if (boxes.length >= MAX_TURNS) return;
    var last = boxes[boxes.length - 1];
    var clone = last.cloneNode(true);
    // Clear the cloned textarea and alternate the role from the previous box.
    var ta = clone.querySelector('textarea[name="turn_content"]');
    if (ta) ta.value = "";
    var sel = clone.querySelector('select[name="turn_role"]');
    var lastSel = last.querySelector('select[name="turn_role"]');
    if (sel && lastSel) sel.value = lastSel.value === "user" ? "assistant" : "user";
    list.appendChild(clone);
    renumber();
  }

  function removeTurn(box) {
    if (!list) return;
    var boxes = list.querySelectorAll("[data-turn]");
    if (boxes.length <= 1) {
      // Keep at least one box; just clear it.
      var ta = box.querySelector('textarea[name="turn_content"]');
      if (ta) ta.value = "";
      return;
    }
    box.parentNode.removeChild(box);
    renumber();
  }

  root.addEventListener("change", function (e) {
    if (e.target.name === "transcript_mode") applyMode();
  });

  root.addEventListener("click", function (e) {
    var add = e.target.closest("[data-add-turn]");
    if (add) {
      e.preventDefault();
      addTurn();
      return;
    }
    var rm = e.target.closest(".turn-remove");
    if (rm) {
      e.preventDefault();
      var box = rm.closest("[data-turn]");
      if (box) removeTurn(box);
    }
  });

  applyMode();
})();
