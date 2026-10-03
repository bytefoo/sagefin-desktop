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
 *   has loaded. `document`: the page's HTML as the store sent it, read from the response itself,
 *   so the server's parser sees what the store served rather than what scripts made of it.
 * @property {boolean} syncs
 *   Whether Sync now can open this store's orders itself. Without it the app saves only the pages
 *   the member opens.
 * @property {string} [agent]
 *   For a store whose terms require software acting by itself to say so: the name a sync gives in its
 *   user agent, as `Agent/<name>`, on every request it makes. Only during a sync; the member's own
 *   browsing in the window is an ordinary browser's.
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
 * Only for a store that `syncs`:
 * @property {(payload: string) => ListedOrder[]} [listedOrders]
 *   The orders an orders-list page names, for a sync to open. Empty for anything it cannot read.
 * @property {(payload: string) => boolean} [hasNextListPage]
 *   Whether an orders-list page says there are older orders after it.
 * @property {(page: number) => string} [listPageUrl]
 *   The address of the orders list's `page`th page, counting from 1. For a list paged by a form,
 *   only its first page has one.
 * @property {string} [nextPageScript]
 *   For a list whose next page is a form rather than an address: an expression, run in the page,
 *   that submits the form as the page's own Next button would and returns true, or returns false
 *   when there is no next page to go to.
 * @property {(payload: string) => string | null} [orderIdIn]
 *   The order an order page's data describes, or null when the page holds no order.
 */

/**
 * @typedef {object} ListedOrder
 * @property {string} id           The retailer's order number.
 * @property {string} url          The order's own page.
 * @property {string} fingerprint  Changes when the order does. Compared, never interpreted.
 * @property {string | null} date  When it was placed, YYYY-MM-DD, or null when the list does not say.
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

/** @type {Retailer} */
export const walmart = {
  code: "walmart",
  name: "Walmart",
  startUrl: "https://www.walmart.com/orders",
  saves: "next_data",
  syncs: true,

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
    /** @type {any} */
    let orders;
    try {
      orders = JSON.parse(payload)?.props?.pageProps?.phRedesignInitialData?.data?.purchaseHistory?.orders;
    } catch {
      return [];
    }
    if (!Array.isArray(orders)) return [];

    /** @type {ListedOrder[]} */
    const listed = [];
    for (const order of orders) {
      const id = typeof order?.id === "string" ? order.id : "";
      // Digits only, because the id goes into a URL the app then loads.
      if (!/^\d{6,30}$/.test(id)) continue;
      const groups = Array.isArray(order.groups) ? order.groups : [];
      const groupId = typeof groups[0]?.groupId === "string" && /^[0-9a-f]{16,64}$/i.test(groups[0].groupId) ? groups[0].groupId : null;

      // What tells a changed order from an unchanged one. The whole entry cannot be used: measured
      // on 2026-10-02, three loads of the same five orders over two hours hashed differently every
      // time, because Walmart reorders its cancel reasons and renumbers its feedback prompts on
      // each load. These fields were the same across all three.
      const items = groups.flatMap((/** @type {any} */ g) =>
        (Array.isArray(g?.items) ? g.items : []).map(
          (/** @type {any} */ i) => `${g.groupId ?? ""}:${i?.id ?? ""}:${i?.statusCode ?? ""}:${i?.isUnavailable ?? ""}`,
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
        url: `https://www.walmart.com/orders/${id}${groupId ? `?groupId=${groupId}` : ""}`,
        fingerprint,
        date,
      });
    }
    return listed;
  },

  // Purchase history shows five orders a page, newest first, and says whether there is another
  // with a cursor the page itself uses. The cursor is not followed: the app opens the numbered
  // address a person reaches with the page's own arrows (seen in a browser on 2026-10-02), as a
  // full load, so each page arrives with its own __NEXT_DATA__ and is saved like the first.
  hasNextListPage(payload) {
    try {
      const cursor = JSON.parse(payload)?.props?.pageProps?.phRedesignInitialData?.data?.purchaseHistory?.pageInfo?.nextPageCursor;
      return typeof cursor === "string" && cursor.length > 0;
    } catch {
      return false;
    }
  },

  listPageUrl(page) {
    if (!Number.isInteger(page) || page < 1) throw new Error("Not a page number.");
    return page === 1 ? walmart.startUrl : `${walmart.startUrl}?page=${page}`;
  },

  orderIdIn(payload) {
    try {
      const id = JSON.parse(payload)?.props?.pageProps?.initialData?.data?.order?.id;
      return typeof id === "string" && id ? id : null;
    } catch {
      return null;
    }
  },
};

/**
 * A store window's title, which stands in for the address bar it does not have: the store, then
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
  startUrl: "https://www.amazon.com/your-orders/orders",
  // Amazon's pages are rendered on its servers with no embedded data, so the page itself is the
  // capture, as the browser extension's were, and the API's Amazon page parser is its reader.
  saves: "document",
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
  responseKind: () => null,

  // A sync works from Your Payments, not Your Orders. Your Orders reaches the app with each order
  // card encrypted, for Amazon's own scripts to decrypt in the browser (seen on 2026-10-02); reading
  // it would mean going round a measure aimed at software that reads pages, which the Agent Terms
  // rule out. Your Payments is not encrypted, and lists what a run needs: each charge, its date, and
  // the order it paid for.
  //
  // Twenty charges a page. The next page is a form rather than an address, so a run moves on
  // by submitting it the way the page's Next button does: the same request the page makes, under
  // the run's marked user agent. How far back is readListPage's rule, by the charges' dates.
  listedOrders(payload) {
    /** @type {Map<string, { dates: string[], rows: string[] }>} */
    const byOrder = new Map();
    let date = /** @type {string | null} */ (null);
    // Date headings and rows, in the order the page has them: each row is under the last heading.
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
      const entry = byOrder.get(id) ?? { dates: [], rows: [] };
      if (date) entry.dates.push(date);
      entry.rows.push(`${date ?? ""}|${amount}`);
      byOrder.set(id, entry);
    }

    return [...byOrder].map(([id, { dates, rows }]) => ({
      id,
      url: `https://www.amazon.com/gp/your-account/order-details?orderID=${id}`,
      // A new charge or refund on the order is a new row, and so a reason to read its page again.
      fingerprint: createHash("sha256").update(JSON.stringify(rows.sort())).digest("hex"),
      date: dates.sort().at(-1) ?? null,
    }));
  },

  // The Next button is a submit input named for the next page's key; on the last page there is none
  // with a name, only a disabled one. Seen on 2026-10-02.
  hasNextListPage(payload) {
    return /<input\b(?![^>]*\bdisabled\b)[^>]*\bname="ppw-widgetEvent:DefaultNextPageNavigationEvent/.test(payload);
  },

  listPageUrl(page) {
    if (page !== 1) throw new Error("Amazon's payments pages after the first have no address; a sync submits the page's own form.");
    return "https://www.amazon.com/cpe/yourpayments/transactions";
  },

  nextPageScript: `(() => {
    const next = [...document.querySelectorAll('input[type="submit"]')]
      .find((i) => i.name.startsWith("ppw-widgetEvent:DefaultNextPageNavigationEvent") && !i.disabled);
    if (!next || !next.form) return false;
    next.form.requestSubmit(next);
    return true;
  })()`,

  // The invoice link names the order a details page is about. Not every order has one: in the first
  // real run (2026-10-02) 2 of 20 details pages had none, so they were never remembered as read and
  // would have been opened on every run. The page's other order links (tracking, returns, support)
  // carry the number too; one number across all of them is the page's, and two is not an answer.
  orderIdIn(payload) {
    const invoice = /\/gp\/css\/summary\/print\.html\?orderID=(\d{3}-\d{7}-\d{7})/.exec(payload)?.[1];
    if (invoice) return invoice;
    const linked = new Set([...payload.matchAll(/[?&](?:amp;)?orderI[dD]=(\d{3}-\d{7}-\d{7})/g)].map((m) => m[1]));
    return linked.size === 1 ? [...linked][0] : null;
  },
};

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** "October 9, 2026" as 2026-10-09, or null. @param {string} text */
function amazonDate(text) {
  const m = /^\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*$/.exec(text);
  const month = m ? MONTHS.indexOf(m[1].toLowerCase()) + 1 : 0;
  if (!m || month === 0) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** Every retailer the app can open, in the order the home window lists them. */
export const RETAILERS = [walmart, amazon];

/** @param {string} code */
export function retailerByCode(code) {
  return RETAILERS.find((r) => r.code === code) ?? null;
}
