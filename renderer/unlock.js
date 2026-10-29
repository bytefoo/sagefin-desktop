// The unlock window's page. It shows what the main process says, and tells it when a button was
// pressed, with what the person typed when the view asked for it. It never sees a key, a request
// or anything of the household beyond the words it is given.
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

/** Whether the view shown asks the person to type something, which the main button then sends. */
let asking = false;

/**
 * @param {{ title: string, lead: string, button: string | null, qr?: string[] | null, code?: string | null, check?: string | null,
 *   said?: string | null, fine?: string | null, codes?: string[] | null, ask?: { label: string, placeholder?: string } | null,
 *   other?: string | null, cancel?: string | null }} view
 */
function show(view) {
  drawQr(view.qr);
  $("title").textContent = view.title;
  $("lead").textContent = view.lead;
  $("go").hidden = !view.button;
  $("go").textContent = view.button ?? "";
  $("other").hidden = !view.other;
  $("other").textContent = view.other ?? "";
  $("cancel").textContent = view.cancel ?? "Not now";
  for (const id of ["code", "check", "said"]) {
    $(id).hidden = !view[id];
    $(id).textContent = view[id] ?? "";
  }
  const codes = $("codes");
  codes.replaceChildren(
    ...(view.codes ?? []).map((text) => {
      const item = document.createElement("li");
      item.textContent = text;
      return item;
    }),
  );
  codes.hidden = !view.codes || view.codes.length === 0;
  $("codes-actions").hidden = codes.hidden;
  const wasAsking = asking;
  asking = Boolean(view.ask);
  $("ask-row").hidden = !asking;
  $("ask-label").textContent = view.ask?.label ?? "";
  $("ask").placeholder = view.ask?.placeholder ?? "";
  if (asking && !wasAsking) {
    $("ask").value = "";
    $("ask").focus();
  }
  $("fine").textContent = view.fine ?? "";
}

const go = () => window.unlock.go(asking ? $("ask").value : undefined);

window.unlock.onView(show);
$("go").addEventListener("click", go);
$("ask").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !$("go").hidden) go();
});
$("other").addEventListener("click", () => window.unlock.other());
$("copy").addEventListener("click", () => window.unlock.copyCodes());
$("save").addEventListener("click", () => window.unlock.saveCodes());
$("cancel").addEventListener("click", () => window.unlock.cancel());
