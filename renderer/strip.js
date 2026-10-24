// The strip above a retailer's page while the member sets up their history. Everything it says
// comes from window.strip (main/strip-preload.cjs), in the app's own words, and is set with
// textContent only: nothing a retailer's page says becomes markup here.
const progress = document.getElementById("progress");
const target = document.getElementById("target");
const note = document.getElementById("note");
const done = document.getElementById("done");

async function render() {
  const state = await window.strip.state();
  if (!state) return;
  progress.textContent = state.progress;
  target.textContent = state.target;
  target.classList.toggle("covered", state.covered);
  note.textContent = state.note ?? "";
}

done.addEventListener("click", () => void window.strip.done());
window.strip.onChanged(() => void render());
void render();
