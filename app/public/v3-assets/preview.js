"use strict";
const toggle = document.getElementById("toggle-motion");
const layer = document.getElementById("flow-layer");
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
let playing = false;
function renderMotion() {
  layer.classList.toggle("hidden", !playing || reduced.matches);
  toggle.disabled = reduced.matches;
  toggle.textContent = reduced.matches ? "Reduced motion enabled" : playing ? "Stop sample flow" : "Play sample flow";
  toggle.setAttribute("aria-pressed", String(playing && !reduced.matches));
}
toggle.addEventListener("click", () => { playing = !playing; renderMotion(); });
reduced.addEventListener("change", renderMotion);
renderMotion();
