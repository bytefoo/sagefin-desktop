// The home window. Everything it knows comes from window.desktop (main/preload.cjs); it builds the
// list with textContent only, so nothing a retailer page says can become markup here.
const list = document.getElementById("retailers");
const cannotSave = document.getElementById("cannot-save");

function describe(retailer) {
  const parts = [];
  if (retailer.captures === 0) parts.push("Nothing saved yet.");
  else parts.push(`${retailer.captures} page${retailer.captures === 1 ? "" : "s"} saved on this computer.`);
  if (retailer.notice) parts.push(retailer.notice);
  return parts.join(" ");
}

async function render() {
  const status = await window.desktop.status();
  if (!status) return;

  cannotSave.hidden = status.canSave;
  list.replaceChildren(
    ...status.retailers.map((retailer) => {
      const item = document.createElement("li");

      const avatar = document.createElement("div");
      avatar.className = "avatar";
      avatar.setAttribute("aria-hidden", "true");
      avatar.textContent = retailer.name.slice(0, 1).toUpperCase();

      const label = document.createElement("div");
      label.className = "retailer";
      const name = document.createElement("div");
      name.className = "retailer-name";
      name.textContent = retailer.name;
      const detail = document.createElement("div");
      detail.className = "retailer-detail";
      detail.textContent = describe(retailer);
      label.append(name, detail);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn-primary";
      button.textContent = retailer.open ? `Show ${retailer.name}` : `Open ${retailer.name}`;
      button.addEventListener("click", () => window.desktop.open(retailer.code));

      item.append(avatar, label, button);
      return item;
    }),
  );
}

window.desktop.onChanged(() => void render());
void render();
