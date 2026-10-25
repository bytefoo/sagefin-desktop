// @ts-check
// What the desktop app knows about each retailer: where its orders live and which of its pages
// are worth saving. Pure — no Electron imports — so `node --test` runs it with nothing installed.

import { createHash } from "node:crypto";

/**
 * @typedef {object} Retailer
 * @property {string} code     The IntegrationPartner.Code the server knows it by.
 * @property {string} name     What a person calls it.
 * @property {string} startUrl Where its window opens.
 * @property {"next_data" | "document"} saves
 *   Where a page's data is. `next_data`: the `__NEXT_DATA__` script the page embeds, read once it
 *   has loaded. `document`: the page's HTML as the retailer sent it, read from the response itself,
 *   so the server's parser sees what the retailer served rather than what scripts made of it.
 * @property {boolean} syncs
 *   Whether Sync now can open this retailer's orders itself. Without it the app saves only the pages
 *   the member opens.
 * @property {boolean} [memberNamesAccount]
 *   The retailer's pages, as the app saves them, do not say whose account they are. So the member
 *   may give the account a name on each computer, which is what lets SageFin tell two accounts at
 *   this retailer apart (lib/account-names.mjs). Absent where the page says, as Walmart's does.
 * @property {string} [agent]
 *   For a retailer whose terms require software acting by itself to say so: the name a sync gives in its
 *   user agent, as `Agent/<name>`, on every request it makes. Only during a sync; the member's own
 *   browsing in the window is an ordinary browser's.
 * @property {Terms} terms
 *   What the retailer's own terms of use say about software like this, quoted, and what that makes
 *   of the two things the app does there. Kept beside the pages the app reads so the words ship
 *   with the code that acts on them (lib/consent.mjs).
 * @property {(url: string, options?: { anyHost?: boolean }) => string | null} captureKind
 *   The RetailCaptureKinds value for a page worth saving, or null for every other page.
 * @property {(url: string, options?: { anyHost?: boolean }) => boolean} isChallenge
 *   True on the retailer's "are you a robot" page. Seeing it means stop, never retry.
 *   `anyHost` is for a development stand-in, which is served from somewhere else and says so.
 * @property {(kind: string, payload: string) => boolean} isSignedOut
 *   True when a page of this kind is the one served before sign-in.
 * @property {(url: string) => boolean} needsReload
 *   True for a page that was reached without a full load and so has not been saved.
 * @property {(url: string, options?: { anyHost?: boolean }) => string | null} responseKind
 *   The RetailCaptureKinds value for a response the retailer's own page requested and that is
 *   worth saving, or null for every other request the page makes.
 * @property {(payload: string) => boolean} [isChallengePayload]
 *   True for a page whose content is the robot check, served at an address that does not say so.
 *
 * Only for a retailer that `syncs`:
 * @property {(payload: string) => ListedOrder[]} [listedOrders]
 *   The orders an orders-list page names, for a sync to open. Empty for anything it cannot read.
 * @property {(payload: string) => boolean} [hasNextListPage]
 *   Whether an orders-list page says there are older orders after it.
 * @property {(page: number) => string} [listPageUrl]
 *   The address of the orders list's `page`th page, counting from 1. For a list paged by a form,
 *   only its first page has one.
 * @property {string} [nextPageScript]
 *   For a list whose next page has no address: an expression, run in the page, that presses the
 *   page's own Next control and returns true, or returns false when there is none to press.
 * @property {string} [nextPageKind]
 *   With `nextPageScript`, for a list whose next page the page fetches by itself rather than loads:
 *   the capture kind of that response, which is where the run reads the next orders from.
 * @property {number} [listPagesPerRun]
 *   How many pages of its orders list one run reads at most, where that is not
 *   MAX_LIST_PAGES_PER_RUN (lib/sync-plan.mjs): for a list whose "page" is much smaller than a page.
 * @property {"first_read_charge" | "read_and_settled"} [caughtUpWhen]
 *   When a run has listed far enough (lib/history.mjs). `first_read_charge`: at the first charge it
 *   has read before, for a list of charges where anything new arrives at the top (Amazon's Your
 *   Payments). `read_and_settled`: once it has reached an order it knows and is past the days in
 *   which an order still changes (Walmart's Purchase history).
 * @property {(payload: string) => ListedCharge[]} [listedCharges]
 *   With `first_read_charge`: the charges a list page shows, newest first, as keys to remember.
 * @property {(payload: string) => string | null} [orderIdIn]
 *   The order an order page's data describes, or null when the page holds no order.
 */

/**
 * @typedef {object} Terms
 * @property {string} url      Where the retailer publishes them.
 * @property {string} updated  The date the retailer says they were last updated, YYYY-MM-DD. A
 *   choice the member made is about the terms as of this date: when it changes, the choice is
 *   asked again.
 * @property {string} read     When the quotes below were last checked against the live page.
 * @property {string[]} quotes The lines that bear on this, verbatim. Never paraphrased or softened.
 * @property {"prohibited" | "within_terms"} saving
 *   Saving the orders pages the member opens. `prohibited`: the terms rule it out, so it is the
 *   member's choice to make and is off until they make it.
 * @property {"prohibited" | "within_terms"} automation
 *   The app opening the member's orders by itself: Sync now and the daily schedule.
 * @property {string} [withinTermsBecause]
 *   Where something is within the terms on conditions, what the conditions are and that the app
 *   meets them. There is then nothing for the member to accept.
 */

/**
 * @typedef {object} ListedOrder
 * @property {string} id           The retailer's order number.
 * @property {string} url          The order's own page.
 * @property {string} fingerprint  Changes when the order does. Compared, never interpreted.
 * @property {string | null} date  When it was placed, YYYY-MM-DD, or null when the list does not say.
 * @property {string[]} [rows]
 *   For a list that can show one order's rows on more than one page (Amazon's Your Payments, whose
 *   rows grow below as it is scrolled): the rows its fingerprint was made from, so that a run makes
 *   one fingerprint from every row it saw (`gatherListed`). Kept in memory for the run, never sent.
 */

/**
 * @typedef {object} ListedCharge
 * @property {string} key          SHA-256 over the charge's orders, date, amount and its place among
 *   identical ones on the page. Compared, never interpreted, and never sent.
 * @property {string | null} date  YYYY-MM-DD, or null when the row does not say.
 */

/** @param {string} url */
function parse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** @param {URL} u */
const isWalmart = (u) => u.protocol === "https:" && (u.hostname === "www.walmart.com" || u.hostname === "walmart.com");

/**
 * Purchase history's data, from either place Walmart puts it: embedded in the page for the first
 * five orders, and in the response the page itself requests for every page after. The object is the
 * same in both (compared on 2026-10-03).
 * @param {string} payload
 * @returns {any}
 */
function purchaseHistory(payload) {
  try {
    const data = JSON.parse(payload);
    return data?.props?.pageProps?.phRedesignInitialData?.data?.purchaseHistory ?? data?.data?.purchaseHistory ?? null;
  } catch {
    return null;
  }
}

/**
 * A value from a page's data as text, for a fingerprint. JSON can hold an object with a property
 * named `toString`, and one of those cannot be made into text at all: it throws. That is nothing,
 * as a missing value is, rather than the end of reading the list.
 * @param {unknown} value
 */
function text(value) {
  try {
    return `${value ?? ""}`;
  } catch {
    return "";
  }
}

/** @type {Retailer} */
export const walmart = {
  code: "walmart",
  name: "Walmart",
  startUrl: "https://www.walmart.com/orders",
  saves: "next_data",
  syncs: true,

  // Read against the live page on 2026-10-03. Both things the app does at Walmart are things these
  // lines prohibit, so both are the member's choice and off until they make it.
  terms: {
    url: "https://www.walmart.com/help/article/walmart-com-terms-of-use/3b75080af40340d6bbd596f116fae5a0",
    updated: "2026-09-09",
    read: "2026-10-03",
    quotes: [
      "Systematically download and store any Materials.",
      "Use any robot, spider, site search/retrieval application or other manual or automatic device to retrieve, index, “scrape,” “data mine” or otherwise gather any Materials … without Walmart’s express prior written consent.",
    ],
    saving: "prohibited",
    automation: "prohibited",
  },

  // Only Purchase history and an order's own page. The window can show the rest of the account —
  // addresses, wallet, profile — and none of it is read: there is no reason to hold it.
  captureKind(url, { anyHost = false } = {}) {
    const u = parse(url);
    if (!u || (!anyHost && !isWalmart(u))) return null;
    const path = u.pathname.replace(/\/+$/, "");
    if (path === "/orders") return "order_list_next_data";
    if (path.startsWith("/orders/")) return "order_detail_next_data";
    return null;
  },

  isChallenge(url, { anyHost = false } = {}) {
    const u = parse(url);
    return Boolean(u && (anyHost || isWalmart(u)) && u.pathname.startsWith("/blocked"));
  },

  // Measured on 2026-10-02: Purchase history before sign-in still has a __NEXT_DATA__, with
  // `purchaseHistory` an empty object. Saved, it would read as an account with no orders. The
  // server's parser refuses the same page; refusing it here keeps it off the disk as well.
  isSignedOut(kind, payload) {
    if (kind !== "order_list_next_data") return false;
    try {
      const history = JSON.parse(payload)?.props?.pageProps?.phRedesignInitialData?.data?.purchaseHistory;
      return !history || !Array.isArray(history.orders);
    } catch {
      return false;
    }
  },

  // Clicking into an order changes the address without loading a page, and __NEXT_DATA__ still
  // describes Purchase history. Reading it then would file the list under the order's URL.
  needsReload(url) {
    return this.captureKind(url) === "order_detail_next_data";
  },

  // What the page itself asks Walmart for once it is running: the next page of Purchase history as
  // the member scrolls, and an order's detail when they click into one. Those never reach
  // __NEXT_DATA__, so without them only the first five orders and a reloaded order are ever saved.
  //
  // Two operations and nothing else. The page makes dozens of other requests — cart, account,
  // recommendations — and none of them is read. "/getOrderLedger/" is not "/getOrder/": the
  // character after "getOrder" is "L", not "/".
  responseKind(url, { anyHost = false } = {}) {
    const u = parse(url);
    if (!u || (!anyHost && !isWalmart(u))) return null;
    if (!u.pathname.includes("/orchestra/")) return null;
    if (/\/PurchaseHistoryV\d+\//.test(u.pathname)) return "order_list_json";
    if (u.pathname.includes("/getOrder/")) return "order_detail_json";
    return null;
  },

  // The orders Purchase history lists, so a sync knows which pages to open. The app reads an
  // order's number and where its page is, and nothing else it would have to understand: amounts
  // go to SageFin inside the page's data, untouched.
  listedOrders(payload) {
    const orders = purchaseHistory(payload)?.orders;
    if (!Array.isArray(orders)) return [];

    /** @type {ListedOrder[]} */
    const listed = [];
    for (const order of orders) {
      const id = typeof order?.id === "string" ? order.id : "";
      // Digits only, because the id goes into a URL the app then loads.
      if (!/^\d{6,30}$/.test(id)) continue;
      const groups = Array.isArray(order.groups) ? order.groups : [];
      // Something bought at a register has its own page, and Walmart fills it only when the address
      // says so: `?groupId=0&storePurchase=true` (seen on 2026-10-25). Without those, the page comes
      // back with Walmart's header and no order. Online orders in Purchase history carry
      // `isInStore: false` and `type: "GLASS"`; an in-store purchase's own page has `type: "IN_STORE"`
      // and no `isInStore` (seen on 2026-10-25). How the list marks one is not yet seen, so either
      // counts: `isInStore` exactly `true`, or `type` exactly "IN_STORE". Anything else opens the
      // online page, as before.
      const inStore = order.isInStore === true || order.type === "IN_STORE";
      // Digits or hex only, because the group id goes into the URL too. An online order's is a long
      // hex string; an in-store purchase's is short ("0").
      const rawGroupId = groups[0]?.groupId;
      const groupId =
        typeof rawGroupId === "string" && (inStore ? /^[0-9a-f]{1,64}$/i : /^[0-9a-f]{16,64}$/i).test(rawGroupId) ? rawGroupId : null;
      const query = [groupId ? `groupId=${groupId}` : null, inStore ? "storePurchase=true" : null].filter(Boolean).join("&");

      // What tells a changed order from an unchanged one. The whole entry cannot be used: measured
      // on 2026-10-02, three loads of the same five orders over two hours hashed differently every
      // time, because Walmart reorders its cancel reasons and renumbers its feedback prompts on
      // each load. These fields were the same across all three.
      const items = groups.flatMap((/** @type {any} */ g) =>
        (Array.isArray(g?.items) ? g.items : []).map(
          (/** @type {any} */ i) => `${text(g.groupId)}:${text(i?.id)}:${text(i?.statusCode)}:${text(i?.isUnavailable)}`,
        ),
      );
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([order.version ?? null, order.itemCount ?? null, order.priceDetails?.orderTotal?.value ?? null, items.sort()]))
        .digest("hex");

      // The calendar date as Walmart wrote it, offset and all: it is compared with a horizon
      // months wide, where a day either side changes nothing.
      const date = typeof order.orderDate === "string" && /^\d{4}-\d{2}-\d{2}/.test(order.orderDate)
        ? order.orderDate.slice(0, 10)
        : null;

      listed.push({
        id,
        url: `https://www.walmart.com/orders/${id}${query ? `?${query}` : ""}`,
        fingerprint,
        date,
      });
    }
    return listed;
  },

  // Purchase history shows five orders a page, newest first, and pages by a cursor the page holds,
  // not by its address: on 2026-10-03 a fresh load of /orders?page=2 embedded the same five orders
  // as page 1. So only the first page has an address. Every page after it is reached the way a
  // person reaches it, by pressing the page's own Next page button, and is read from the request
  // the page then makes. The cursor itself is never used by the app, only seen: it says whether
  // there is a next page.
  hasNextListPage(payload) {
    const cursor = purchaseHistory(payload)?.pageInfo?.nextPageCursor;
    return typeof cursor === "string" && cursor.length > 0;
  },

  listPageUrl(page) {
    if (page !== 1) throw new Error("Purchase history's pages after the first have no address; a sync presses the page's own Next page button.");
    return walmart.startUrl;
  },

  // The button as Walmart marks it up (seen on 2026-10-03): a plain button, with no address.
  nextPageScript: `(() => {
    const next = document.querySelector('button[data-automation-id="next-pages-button"]')
      ?? document.querySelector('button[aria-label="Next page"]');
    if (!next || next.disabled || next.getAttribute("aria-disabled") === "true") return false;
    next.click();
    return true;
  })()`,
  nextPageKind: "order_list_json",
  // Orders keep changing for weeks after they are placed (late shipments, substitutions, refunds),
  // and a change is a changed order, not a new row at the top. So a run reads on past the orders it
  // knows until it is past those weeks.
  caughtUpWhen: "read_and_settled",

  // Which order the page holds, or null when it holds none, so a run takes an order off its to-do
  // list only when its page was really there. An order with nothing in it is not one: a page Walmart
  // could not fill (its header and nothing else, or its "Sorry… WCP_ORDER_FAIL" page) must not count
  // as read, or the order would never be opened again. Every order page seen carries its items in
  // groups, under an alias the page chooses (`groups_2101` today), which SageFin's reader matches by
  // the same shape and refuses a page without.
  orderIdIn(payload) {
    try {
      const order = JSON.parse(payload)?.props?.pageProps?.initialData?.data?.order;
      if (!order || typeof order !== "object") return null;
      const id = order.id;
      if (typeof id !== "string" || !id) return null;
      const filled = Object.keys(order).some(
        (key) => /^groups(_\d+)?$/.test(key) && Array.isArray(order[key]) && order[key].length > 0,
      );
      return filled ? id : null;
    } catch {
      return null;
    }
  },
};

/**
 * A retailer window's title, which stands in for the address bar it does not have: the retailer, then
 * where the window is, without the scheme. A stand-in page on disk shows its file name.
 *
 * @param {Retailer} retailer
 * @param {string} url
 */
export function windowTitle(retailer, url) {
  const u = parse(url);
  if (!u || !["https:", "http:", "file:"].includes(u.protocol)) return retailer.name;
  const where = u.protocol === "file:" ? (u.pathname.split("/").pop() ?? "") : `${u.host}${u.pathname}`;
  return `${retailer.name} — ${where}${u.search}`;
}

/** @param {URL} u */
const isAmazon = (u) => u.protocol === "https:" && (u.hostname === "www.amazon.com" || u.hostname === "amazon.com");

/** @type {Retailer} */
export const amazon = {
  code: "amazon",
  name: "Amazon",
  // Your Orders greets the member by first name and names no account.
  memberNamesAccount: true,
  startUrl: "https://www.amazon.com/your-orders/orders",
  // Amazon's pages are rendered on its servers with no embedded data, so the page itself is the
  // capture, as the browser extension's were, and the API's Amazon page parser is its reader.
  saves: "document",

  // Read against the live page on 2026-10-03. Amazon's terms name software like this and set
  // conditions for it, which a sync meets, so there is nothing for the member to accept.
  terms: {
    url: "https://www.amazon.com/gp/help/customer/display.html?nodeId=GLSBYFE9MGKKQXXM",
    updated: "2026-08-14",
    read: "2026-10-03",
    quotes: [
      "“Agent” means any software or service that takes autonomous or semi-autonomous action on behalf of, or at the instruction of, any person or entity.",
      "In all HTTP/HTTPS requests, identify that the request is from an Agent and disclose the name of the Agent by including the following in the request's user agent string: “Agent/[agent name]”",
      "Not conceal or obfuscate that any access, use, or interactions are from an Agent, such as by (a) mimicking the speed or pattern of human keystrokes, page navigation, or other interactions or (b) completing or circumventing CAPTCHAs or other measures intended to distinguish computers from humans.",
    ],
    saving: "within_terms",
    automation: "within_terms",
    withinTermsBecause:
      "Amazon allows software acting for you if it says what it is and does not pretend to be a person. A sync names itself Agent/SageFinDesktop on every request, keeps one steady pace, never answers a robot check, and stops when Amazon turns it away.",
  },
  // Amazon's Agent Terms (2026-08-14): software acting by itself puts Agent/<name> in its user agent
  // on every request, never imitates a person, never answers a CAPTCHA, and stops when turned away.
  // A sync does all four; the member browsing in the window is not an agent and is not marked.
  syncs: true,
  agent: "SageFinDesktop",

  // Your Orders, an order's details, and Your Payments, under the addresses Amazon uses for each
  // today and the older ones it still redirects from. Nothing else in the account is read.
  captureKind(url, { anyHost = false } = {}) {
    const u = parse(url);
    if (!u || (!anyHost && !isAmazon(u))) return null;
    const path = u.pathname.replace(/\/+$/, "");
    if (path === "/your-orders/orders" || path === "/gp/css/order-history" || path === "/gp/your-account/order-history") {
      return "order_list_html";
    }
    if (path === "/your-orders/order-details" || path === "/gp/your-account/order-details") return "order_detail_html";
    if (path === "/cpe/yourpayments/transactions") return "payments_html";
    return null;
  },

  isChallenge(url, { anyHost = false } = {}) {
    const u = parse(url);
    return Boolean(u && (anyHost || isAmazon(u)) && u.pathname.startsWith("/errors/validateCaptcha"));
  },

  // Amazon also serves its robot check in place of the page that was asked for, at that page's own
  // address, and the form on it posts to the captcha route.
  isChallengePayload(payload) {
    return /action="\/errors\/validateCaptcha"/i.test(payload);
  },

  // Amazon redirects a signed-out member to its sign-in page, which is never saved by address. A
  // page that still carries the sign-in form is the same thing reached another way.
  isSignedOut(_kind, payload) {
    return /\bid="ap_email"|\bname="signIn"/.test(payload);
  },

  needsReload: () => false,

  // The one request of the page's own the app reads at Amazon: Your Payments asking for its next
  // twenty charges as the list is scrolled (`get-transactions`, seen on 2026-10-24). Its answer is
  // JSON, the same charges the page then draws, with a cursor for the next twenty. The app never
  // sends it; it reads the answer to the page's own.
  responseKind(url, { anyHost = false } = {}) {
    const u = parse(url);
    if (!u || (!anyHost && !isAmazon(u))) return null;
    return /\/get-?transactions(?:\/|$)/i.test(u.pathname) ? "payments_json" : null;
  },

  // A sync works from Your Payments, not Your Orders. Your Orders reaches the app with each order
  // card encrypted, for Amazon's own scripts to decrypt in the browser (seen on 2026-10-02); reading
  // it would mean going round a measure aimed at software that reads pages, which the Agent Terms
  // rule out. Your Payments is not encrypted, and lists what a run needs: each charge, its date, and
  // the order it paid for.
  //
  // Twenty charges a page. The next page has no address: the Next Page button is a submit inside
  // one of Amazon's payments widgets, whose own script takes the press, fetches the next twenty and
  // replaces the list where it stands. No page loads (found on 2026-10-03, when a run pressed it
  // and waited 45 seconds for a page that never came). So a run presses the button as a person
  // does, waits for the list on the page to change, and reads it there: the request is the page's
  // own, under the run's marked user agent. How far back is readListPage's rule, by the charges'
  // dates.
  //
  // Amazon rebuilt the page, seen on 2026-10-20. It has no date headings and no Next button: each
  // row is a link marked data-testid="transaction-link" carrying its own date, card, order, amount
  // and a Pending or Charged status, and more rows arrive below as the list is scrolled to its end.
  // Its classes are generated and change whenever Amazon rebuilds, so the rows are read by their
  // markers and their text. Both shapes are read, in case a member is still shown the old one. A
  // row is recorded the same way in both, so an order read from the old page is not read again
  // only because the page changed.
  listedOrders(payload) {
    /** @type {Map<string, { dates: string[], rows: string[] }>} */
    const byOrder = new Map();
    /** @param {string} id @param {string | null} date @param {string} amount */
    const add = (id, date, amount) => {
      const entry = byOrder.get(id) ?? { dates: [], rows: [] };
      if (date) entry.dates.push(date);
      entry.rows.push(`${date ?? ""}|${amount}`);
      byOrder.set(id, entry);
    };

    // The page's own get-transactions answer: the same charges, as data. A charge that paid for
    // several orders is a row of each.
    for (const row of paymentsJsonRows(payload) ?? []) {
      if (row.pending || !row.amount) continue;
      for (const id of row.orders) if (RETAIL_ORDER.test(id)) add(id, row.date, row.amount);
    }

    // The rebuilt page. The marker exactly: a row's inner parts are "transaction-link-content-wrapper" and so on.
    const links = [...payload.matchAll(/data-testid="transaction-link"(?=[\s>/])/g)];
    for (const [index, match] of links.entries()) {
      const row = payload.slice(match.index, links[index + 1]?.index ?? payload.length);
      const texts = [...row.matchAll(/data-testid="text"[^>]*>([^<]*)</g)].map((m) => m[1].trim()).filter(Boolean);
      const id = texts.map((t) => /^Order #\s*(\d{3}-\d{7}-\d{7})$/.exec(t)?.[1]).find(Boolean);
      const amount = texts.find((t) => /^[-+]?\$[\d,]+\.\d\d$/.test(t));
      if (!id || !amount) continue;
      // A hold, which becomes a charge, sometimes of another amount. It says nothing the order's
      // own page does not, so it is no reason to open that page, and counting it made every hold
      // that was charged a second open of its order. SageFin's reader leaves holds out the same
      // way and reads the row once it is marked Charged. An order with only holds is listed once
      // one of them is charged.
      if (texts.some((t) => t.toLowerCase() === "pending")) continue;
      add(id, texts.map(amazonDate).find(Boolean) ?? null, amount);
    }

    // The old page. Date headings and rows, in the order the page has them: each row is under the last heading.
    let date = /** @type {string | null} */ (null);
    const token = /apx-transaction-date-container[^>]*>\s*<span>([^<]+)<\/span>|apx-transactions-line-item-component-container/g;
    const starts = [...payload.matchAll(token)];
    for (const [index, match] of starts.entries()) {
      if (match[1] !== undefined) {
        date = amazonDate(match[1]);
        continue;
      }
      const row = payload.slice(match.index, starts[index + 1]?.index ?? payload.length);
      const id = /Order #\s*(\d{3}-\d{7}-\d{7})/.exec(row)?.[1];
      const amount = /[-+]?\$[\d,]+\.\d\d/.exec(row)?.[0];
      if (!id || !amount) continue;
      add(id, date, amount);
    }

    return [...byOrder].map(([id, { dates, rows }]) => ({
      id,
      url: `https://www.amazon.com/gp/your-account/order-details?orderID=${id}`,
      // A new charge or refund on the order is a new row, and so a reason to read its page again.
      fingerprint: rowsFingerprint(rows),
      date: dates.sort().at(-1) ?? null,
      rows: [...rows].sort(),
    }));
  },

  // The Next button is a submit input named for the next page's key; on the last page there is none
  // with a name, only a disabled one. Seen on 2026-10-02.
  //
  // The rebuilt page says nothing about whether more rows will come. While it shows rows, a run
  // scrolls to the end of the list; when that brings no more, the run's own watch on the list says
  // the list has ended (main/main.mjs), as it did when a Next press changed nothing.
  hasNextListPage(payload) {
    const json = paymentsJson(payload);
    if (json) {
      const cursor = json.displayResponse?.lastEvaluatedKey;
      return typeof cursor === "string" && cursor.length > 0;
    }
    return /<input\b(?![^>]*\bdisabled\b)[^>]*\bname="ppw-widgetEvent:DefaultNextPageNavigationEvent/.test(payload)
      || /data-testid="transaction-link"(?=[\s>/])/.test(payload);
  },

  listPageUrl(page) {
    if (page !== 1) throw new Error("Amazon's payments pages after the first have no address; a sync submits the page's own form.");
    return "https://www.amazon.com/cpe/yourpayments/transactions";
  },

  // The rebuilt page: its list grows when its last row is scrolled into view, as a person scrolls to
  // the end, and the page then asks for the next twenty (get-transactions), which is where the run
  // reads them. Seen on 2026-10-20 and 2026-10-24. The page has a "Load more" button too, but it is
  // never shown, and pressing it does nothing. The old page's Next button is gone, and not pressed.
  nextPageScript: `(() => {
    const rows = document.querySelectorAll('[data-testid="transaction-link"]');
    if (rows.length === 0) return false;
    rows[rows.length - 1].scrollIntoView({ block: "end" });
    return true;
  })()`,
  nextPageKind: "payments_json",
  // A run stops at the first charge it has read before (lib/history.mjs), so a daily run reads one
  // scroll or two. Five bounds a day with many new charges; the history behind them is the
  // member's to load once, in setup, not a run's. On 2026-10-24 thirty scrolls in one run met
  // Amazon's robot check, where ten never had.
  listPagesPerRun: 5,
  caughtUpWhen: "first_read_charge",

  // Each charge on a page, newest first, as a key: what a run stops at once it has seen it before.
  // A refund or a late charge is a new row at the top, so it is new; a hold is left out until it
  // is charged, so a hold that becomes a charge is new then.
  listedCharges(payload) {
    /** @type {{ orders: string[], date: string | null, amount: string }[]} */
    const rows = [];
    const json = paymentsJsonRows(payload);
    if (json) {
      for (const row of json) if (!row.pending && row.amount) rows.push({ orders: row.orders, date: row.date, amount: row.amount });
    } else {
      const links = [...payload.matchAll(/data-testid="transaction-link"(?=[\s>/])/g)];
      for (const [index, match] of links.entries()) {
        const row = payload.slice(match.index, links[index + 1]?.index ?? payload.length);
        const texts = [...row.matchAll(/data-testid="text"[^>]*>([^<]*)</g)].map((m) => m[1].trim()).filter(Boolean);
        const amount = texts.find((t) => /^[-+]?\$[\d,]+\.\d\d$/.test(t));
        if (!amount || texts.some((t) => t.toLowerCase() === "pending")) continue;
        const orders = texts.flatMap((t) => ANY_ORDER_TEXT.exec(t)?.[1] ?? []);
        rows.push({ orders, date: texts.map(amazonDate).find(Boolean) ?? null, amount });
      }
    }
    /** @type {Map<string, number>} */
    const times = new Map();
    return rows.map(({ orders, date, amount }) => {
      const same = JSON.stringify([[...orders].sort(), date, amount]);
      const n = times.get(same) ?? 0;
      times.set(same, n + 1);
      return { key: createHash("sha256").update(JSON.stringify([same, n])).digest("hex"), date };
    });
  },

  // Which order a details page is about, tried in the order SageFin's own reader trusts them:
  //
  // 1. The invoice link. Not every order has one: in the first real run (2026-10-02) 2 of 20
  //    details pages had none.
  // 2. The page's own order-number element, which is what SageFin's reader takes the number from.
  //    A run on 2026-10-03 still could not place 2 of 20 pages that SageFin read without trouble;
  //    this is the rule it was using and the app was not.
  // 3. The page's other order links (tracking, returns, support), when they all carry one number.
  // 4. Any order number at all, when the whole page names exactly one.
  //
  // Two different numbers with nothing to choose between them is not an answer. A page that is not
  // recognised is never remembered as read, and so is opened again on every run.
  orderIdIn(payload) {
    const number = "((?:\\d{3}|D\\d{2})-\\d{7}-\\d{7})";
    const invoice = new RegExp(`/gp/css/summary/print\\.html\\?orderID=${number}`).exec(payload)?.[1];
    if (invoice) return invoice;

    // The first number inside the element. What follows the element on the page is not looked at,
    // so the search stops a little way in.
    const named = new RegExp(`data-component="orderId"[^>]*>[\\s\\S]{0,300}?${number}`).exec(payload)?.[1];
    if (named) return named;

    const linked = new Set([...payload.matchAll(new RegExp(`[?&](?:amp;)?orderI[dD]=${number}`, "g"))].map((m) => m[1]));
    if (linked.size === 1) return [...linked][0];

    const anywhere = new Set([...payload.matchAll(new RegExp(`(?<![\\w-])${number}(?![\\w-])`, "g"))].map((m) => m[1]));
    return anywhere.size === 1 ? [...anywhere][0] : null;
  },
};

/** A retail order's number, which is what a run opens. A digital order (D01-…) is read from its charges only. */
const RETAIL_ORDER = /^\d{3}-\d{7}-\d{7}$/;
/** "Order #…" as a row of Your Payments writes it, retail or digital. */
const ANY_ORDER_TEXT = /^Order #\s*((?:\d{3}|D\d{2})-\d{7}-\d{7})$/;

/**
 * Your Payments' own get-transactions answer, or null for anything else. Read on 2026-10-24: the
 * charges are `displayResponse.transactionsList`, the cursor `displayResponse.lastEvaluatedKey`.
 * @param {string} payload
 * @returns {any}
 */
function paymentsJson(payload) {
  if (typeof payload !== "string" || !payload.trimStart().startsWith("{")) return null;
  try {
    const data = JSON.parse(payload);
    return Array.isArray(data?.displayResponse?.transactionsList) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Each charge in a get-transactions answer, as the app needs it: its orders, date, amount, and
 * whether it is only a hold. One charge can pay for several orders, so `orders` is a list. What a
 * refund's status says is not known yet (none was in the answers looked at), so only a row marked
 * Pending is left out, and every other row counts, however it is labelled.
 * @param {string} payload
 * @returns {{ orders: string[], date: string | null, amount: string | null, pending: boolean }[] | null}
 */
function paymentsJsonRows(payload) {
  const json = paymentsJson(payload);
  if (!json) return null;
  /** @type {{ orders: string[], date: string | null, amount: string | null, pending: boolean }[]} */
  const rows = [];
  for (const tx of json.displayResponse.transactionsList) {
    if (!tx || typeof tx !== "object") continue;
    const amount = text(tx.formattedAmount).trim();
    const label = text(tx.statusInfo?.label).trim().toLowerCase();
    const status = text(tx.statusInfo?.status).trim().toLowerCase();
    /** @type {string[]} */
    const orders = [];
    for (const order of Array.isArray(tx.orderData) ? tx.orderData : []) {
      const id = ANY_ORDER_TEXT.exec(text(order?.orderDisplayString).trim())?.[1]
        ?? /[?&]orderI[dD]=((?:\d{3}|D\d{2})-\d{7}-\d{7})(?:&|$)/.exec(text(order?.orderDetailsUrl))?.[1];
      if (id && !orders.includes(id)) orders.push(id);
    }
    rows.push({
      orders,
      date: amazonDate(text(tx.formattedDate)),
      amount: /^[-+]?\$[\d,]+\.\d\d$/.test(amount) ? amount : null,
      pending: label === "pending" || status === "pending",
    });
  }
  return rows;
}

/**
 * An Amazon order's fingerprint: SHA-256 over its sorted `date|amount` rows. The same on the old
 * page and the rebuilt one, and on every page of a run that showed the same rows.
 * @param {string[]} rows
 */
function rowsFingerprint(rows) {
  return createHash("sha256").update(JSON.stringify([...rows].sort())).digest("hex");
}

/**
 * One order's rows from two pages of the same list, as one set: each row as many times as the page
 * that showed it most often. A row seen on two pages is one row, because the rebuilt Your Payments
 * keeps its rows on the page as more load below; two identical charges on one page are two.
 * @param {string[]} a
 * @param {string[]} b
 */
function unionRows(a, b) {
  /** @param {string[]} rows */
  const count = (rows) => rows.reduce((m, r) => m.set(r, (m.get(r) ?? 0) + 1), /** @type {Map<string, number>} */ (new Map()));
  const ca = count(a);
  const cb = count(b);
  /** @type {string[]} */
  const out = [];
  for (const row of new Set([...a, ...b])) {
    for (let i = 0; i < Math.max(ca.get(row) ?? 0, cb.get(row) ?? 0); i += 1) out.push(row);
  }
  return out.sort();
}

/**
 * What a run has listed, with one more page of the list read into it.
 *
 * An order is fingerprinted from every row the run saw for it, not from the first page it appeared
 * on. On a list that grows as it is scrolled, an order whose rows straddle the end of one page shows
 * some of them on that page and all of them on the next; and as more rows load, the rebuilt Your
 * Payments drops the oldest from the page, so a later page can show an order with only its newest
 * rows. Fingerprinted from whichever page came first, the same unchanged order could have another
 * fingerprint on the next run, and be opened again for it.
 *
 * @param {ListedOrder[]} listed      What earlier pages of this run listed.
 * @param {ListedOrder[]} pageOrders  This page's orders.
 * @returns {{ listed: ListedOrder[], page: ListedOrder[], grew: number }}
 *   `listed`: the earlier orders, with what this page adds to their rows. `page`: this page's
 *   orders, each fingerprinted from every row the run has seen for it. `grew`: how many earlier
 *   orders this page showed rows of that no earlier page had.
 */
export function gatherListed(listed, pageOrders) {
  const onPage = new Map(pageOrders.map((o) => [o.id, o]));
  let grew = 0;
  const merged = listed.map((before) => {
    const now = onPage.get(before.id);
    if (!now?.rows || !before.rows) return before;
    const rows = unionRows(before.rows, now.rows);
    if (rows.length === before.rows.length) return before;
    grew += 1;
    const dates = [before.date, now.date].filter((d) => d !== null).sort();
    return { ...before, rows, fingerprint: rowsFingerprint(rows), date: dates.at(-1) ?? null };
  });
  const byId = new Map(merged.map((o) => [o.id, o]));
  return { listed: merged, page: pageOrders.map((o) => byId.get(o.id) ?? o), grew };
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** "October 9, 2026", or "Oct 9, 2026" as the rebuilt page writes it, as 2026-10-09, or null. @param {string} text */
function amazonDate(text) {
  const m = /^\s*([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})\s*$/.exec(text);
  const name = m?.[1].toLowerCase() ?? "";
  const month = name.length >= 3 ? MONTHS.findIndex((full) => full.startsWith(name === "sept" ? "sep" : name)) + 1 : 0;
  if (!m || month === 0) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** Every retailer the app can open, in the order the home window lists them. */
export const RETAILERS = [walmart, amazon];

/** @param {string} code */
export function retailerByCode(code) {
  return RETAILERS.find((r) => r.code === code) ?? null;
}
