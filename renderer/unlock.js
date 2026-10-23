// The unlock window's page. It shows what the main process says, and tells it when a button was
// pressed. It never sees a key, a request or anything of the household.
const $ = (id) => document.getElementById(id);

/**
 * The enrolment's QR code, from rows of "1" (dark) and "0" the main process made (lib/qr.mjs).
 * Dark on white whatever the theme, with the four-module margin a reader needs.
 * @param {string[] | null | undefined} rows
 */
function drawQr(rows) {
  const canvas = $("qr");
  canvas.hidden = !rows || rows.length === 0;
  if (canvas.hidden) return;
  const scale = 6;
  const margin = 4;
  const size = (rows.length + margin * 2) * scale;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size, size);
  context.fillStyle = "#000000";
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === "1") context.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
    }
  });
}

/** @param {{ title: string, lead: string, button: string | null, qr?: string[] | null, code?: string | null, check?: string | null, said?: string | null, fine?: string | null }} view */
function show(view) {
  drawQr(view.qr);
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
