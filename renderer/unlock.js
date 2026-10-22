// The unlock window's page. It shows what the main process says, and tells it when a button was
// pressed. It never sees a key, a request or anything of the household.
const $ = (id) => document.getElementById(id);

/** @param {{ title: string, lead: string, button: string | null, code?: string | null, check?: string | null, said?: string | null, fine?: string | null }} view */
function show(view) {
  $("title").textContent = view.title;
  $("lead").textContent = view.lead;
  $("go").hidden = !view.button;
  $("go").textContent = view.button ?? "";
  for (const id of ["code", "check", "said"]) {
    $(id).hidden = !view[id];
    $(id).textContent = view[id] ?? "";
  }
  $("fine").textContent = view.fine ?? "";
}

window.unlock.onView(show);
$("go").addEventListener("click", () => window.unlock.go());
$("cancel").addEventListener("click", () => window.unlock.cancel());
