// The home window. Everything it knows comes from window.desktop (main/preload.cjs); it builds the
// list with textContent only, so nothing a retailer page says can become markup here.
const list = document.getElementById("retailers");
const cannotSave = document.getElementById("cannot-save");

/** Retailers whose "Set up history again" choices are open. */
const resetOpen = new Set();

function describe(retailer) {
  const parts = [];
  if (retailer.captures === 0) parts.push("Nothing saved yet.");
  else parts.push(`${retailer.captures} page${retailer.captures === 1 ? "" : "s"} saved on this computer.`);
  if (retailer.notice) parts.push(retailer.notice);
  return parts.join(" ");
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
};

/** Today on this computer, YYYY-MM-DD: the latest day "Change how far back" takes. */
const today = () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

/** The history line: how far setup got, and what is still to read. */
function describeHistory(history) {
  if (history.settingUp) return "Setting up its history now, in its window.";
  const parts = [];
  if (history.setup === "never") parts.push("History not set up yet.");
  else {
    const back = history.reachedDate ? ` back to ${longDate(history.reachedDate)}` : "";
    parts.push(`History ${history.setup === "done" ? "set up" : "partly set up"}${back}, ${history.orders} order${history.orders === 1 ? "" : "s"}.`);
  }
  if (history.toRead > 0) parts.push(`${history.toRead} order${history.toRead === 1 ? "" : "s"} still to read, twenty a sync.`);
  if (history.setAside > 0) {
    parts.push(
      history.setAside === 1
        ? "1 set aside: its page showed no order, so its items were not read. Setting up history again past it tries it again."
        : `${history.setAside} set aside: their pages showed no order, so their items were not read. Setting up history again past them tries them again.`,
    );
  }
  return parts.join(" ");
}

function button(text, className, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

/** Setting up the history, and the two ways of setting it up again. */
function historyActions(retailer) {
  const history = retailer.history;
  const box = document.createElement("div");
  box.className = "history-actions";
  if (history.settingUp || retailer.syncing) return box;

  if (history.setup === "never") {
    box.append(button("Set up history", "btn-secondary", () => void window.desktop.setUpHistory(retailer.code)));
    return box;
  }
  if (history.setup === "started") {
    box.append(button("Carry on setting up", "btn-secondary", () => void window.desktop.setUpHistory(retailer.code)));
    return box;
  }
  if (!resetOpen.has(retailer.code)) {
    box.append(button("Set up history again", "btn-secondary", () => {
      resetOpen.add(retailer.code);
      void render();
    }));
    return box;
  }

  // Going further back is setup again: what was read is skipped, and the strip says so.
  box.append(button("Go further back", "btn-secondary", () => {
    resetOpen.delete(retailer.code);
    void window.desktop.setUpHistory(retailer.code);
  }));

  // Change how far back: orders on the to-do list older than the date are not read. The box starts
  // at how far back the history reads now, so the member only moves it later.
  const howFar = document.createElement("div");
  howFar.className = "how-far-back";
  const date = document.createElement("input");
  date.type = "date";
  date.id = `history-back-to-${retailer.code}`;
  date.max = today();
  date.value = history.readsBackTo ?? history.reachedDate ?? "";
  const label = document.createElement("label");
  label.htmlFor = date.id;
  label.className = "fine";
  label.textContent = `Read ${retailer.name} orders back to`;
  howFar.append(label, date, button("Change how far back", "btn-secondary", () => {
    if (!date.value) return;
    resetOpen.delete(retailer.code);
    void window.desktop.changeHowFarBack(retailer.code, date.value);
  }));
  if (!date.value) {
    const hint = document.createElement("p");
    hint.className = "fine how-far-back-hint";
    hint.textContent = "How far back it reads is not known yet. Pick the oldest day to read.";
    howFar.append(hint);
  }

  // Start over: everything read here is forgotten and setup opens. SageFin keeps what it has.
  box.append(button("Start over", "btn-secondary", () => {
    const sure = window.confirm(
      `Start ${retailer.name}'s history over? This computer forgets every order it has read there and opens setup again. Orders SageFin already has stay in SageFin.`,
    );
    if (!sure) return;
    resetOpen.delete(retailer.code);
    void window.desktop.startOver(retailer.code);
  }));
  box.append(button("Cancel", "btn-secondary", () => {
    resetOpen.delete(retailer.code);
    void render();
  }));
  box.append(howFar);
  return box;
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
      if (retailer.syncable && retailer.history) {
        const history = document.createElement("div");
        history.className = "retailer-detail";
        history.textContent = describeHistory(retailer.history);
        label.append(history);
      }

      const open = document.createElement("button");
      open.type = "button";
      open.className = "btn-primary";
      open.textContent = retailer.open ? `Show ${retailer.name}` : `Open ${retailer.name}`;
      open.addEventListener("click", () => window.desktop.open(retailer.code));

      item.append(avatar, label, open);
      // Under the row, the width of the window: a narrow window wraps the buttons, never cuts them.
      if (retailer.syncable && retailer.history) item.append(historyActions(retailer));
      return item;
    }),
  );
}

window.desktop.onChanged(() => void render());
void render();
