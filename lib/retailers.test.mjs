import assert from "node:assert/strict";
import { test } from "node:test";
import { RETAILERS, amazon, retailerByCode, walmart, windowTitle } from "./retailers.mjs";

test("Walmart: only Purchase history and an order's own page are worth saving", () => {
  assert.equal(walmart.captureKind("https://www.walmart.com/orders"), "order_list_next_data");
  assert.equal(walmart.captureKind("https://www.walmart.com/orders/"), "order_list_next_data");
  assert.equal(walmart.captureKind("https://www.walmart.com/orders?action=SignIn&rm=true"), "order_list_next_data");
  assert.equal(
    walmart.captureKind("https://www.walmart.com/orders/200000000000001?groupId=0"),
    "order_detail_next_data",
  );

  for (const other of ["/", "/account/delivery-addresses", "/wallet", "/account/profile", "/cart", "/ordersfoo"]) {
    assert.equal(walmart.captureKind(`https://www.walmart.com${other}`), null, other);
  }
  assert.equal(walmart.captureKind("not a url"), null);
});

test("Walmart: another site's /orders, or Walmart over plain http, is not Walmart's orders", () => {
  assert.equal(walmart.captureKind("https://example.com/orders"), null);
  assert.equal(walmart.captureKind("https://www.walmart.com.example.com/orders"), null);
  assert.equal(walmart.captureKind("https://evilwalmart.com/orders"), null);
  assert.equal(walmart.captureKind("http://www.walmart.com/orders"), null);
  assert.equal(walmart.captureKind("file:///orders"), null);
});

test("Walmart: its robot check is recognized wherever the query string goes", () => {
  assert.equal(walmart.isChallenge("https://www.walmart.com/blocked?url=L29yZGVycw==&uuid=abc"), true);
  assert.equal(walmart.isChallenge("https://www.walmart.com/orders"), false);
  assert.equal(walmart.isChallenge("https://example.com/blocked"), false);
  assert.equal(walmart.isChallenge("nonsense"), false);
});

// Measured 2026-10-02: the page before sign-in carries `purchaseHistory: {}`.
test("Walmart: Purchase history before sign-in is not an account with no orders", () => {
  const list = (purchaseHistory) =>
    JSON.stringify({ props: { pageProps: { phRedesignInitialData: { data: { purchaseHistory } } } } });

  assert.equal(walmart.isSignedOut("order_list_next_data", list({})), true);
  assert.equal(walmart.isSignedOut("order_list_next_data", JSON.stringify({ props: { pageProps: {} } })), true);

  // Signed in with nothing bought is a real answer and is kept.
  assert.equal(walmart.isSignedOut("order_list_next_data", list({ orders: [] })), false);
  assert.equal(walmart.isSignedOut("order_list_next_data", list({ orders: [{ id: "1" }] })), false);

  // The check is about the list page only; an order page is never judged by it.
  assert.equal(walmart.isSignedOut("order_detail_next_data", list({})), false);
});

// A development stand-in is served from a local server, and has to say so to be read at all.
test("Walmart: a stand-in on another host is read only when asked for by name", () => {
  assert.equal(walmart.captureKind("http://localhost:5098/orders"), null);
  assert.equal(walmart.captureKind("http://localhost:5098/orders", { anyHost: true }), "order_list_next_data");
  assert.equal(walmart.captureKind("http://localhost:5098/orders/200000000000001", { anyHost: true }), "order_detail_next_data");
  assert.equal(walmart.captureKind("http://localhost:5098/wallet", { anyHost: true }), null);

  assert.equal(walmart.isChallenge("http://localhost:5098/blocked"), false);
  assert.equal(walmart.isChallenge("http://localhost:5098/blocked", { anyHost: true }), true);
});

test("Walmart: an order reached without a full load is the page that needs a reload", () => {
  assert.equal(walmart.needsReload("https://www.walmart.com/orders/200000000000001"), true);
  assert.equal(walmart.needsReload("https://www.walmart.com/orders"), false);
  assert.equal(walmart.needsReload("https://www.walmart.com/cart"), false);
});

test("Walmart: of everything its page requests, only the two orders operations are read", () => {
  const at = (path) => `https://www.walmart.com${path}`;

  assert.equal(walmart.responseKind(at("/orchestra/cph/graphql/PurchaseHistoryV3/abc123?variables=%7B%7D")), "order_list_json");
  assert.equal(walmart.responseKind(at("/orchestra/cph/graphql/PurchaseHistoryV2/abc123")), "order_list_json");
  assert.equal(walmart.responseKind(at("/orchestra/orders/graphql/getOrder/abc123?variables=x")), "order_detail_json");

  // "/getOrderLedger/" does not contain "/getOrder/".
  assert.equal(walmart.responseKind(at("/orchestra/orders/graphql/getOrderLedger/abc")), null);
  for (const other of [
    "/orchestra/home/graphql/MergeAndGetCart/abc",
    "/orchestra/home/graphql/accountLandingPage/abc",
    "/orchestra/snb/graphql/FetchNotifications/abc",
    "/orders",
    "/getOrder/abc",
  ]) {
    assert.equal(walmart.responseKind(at(other)), null, other);
  }
});

test("Walmart: another site's request with the same path is not Walmart's", () => {
  const path = "/orchestra/orders/graphql/getOrder/abc";
  assert.equal(walmart.responseKind(`https://example.com${path}`), null);
  assert.equal(walmart.responseKind(`https://www.walmart.com.example.com${path}`), null);
  assert.equal(walmart.responseKind(`http://www.walmart.com${path}`), null);
  assert.equal(walmart.responseKind("nonsense"), null);

  // A development stand-in is served from somewhere else, and says so explicitly.
  assert.equal(walmart.responseKind(`http://localhost:5098${path}`, { anyHost: true }), "order_detail_json");
});

test("a retailer is found by the code the server knows it by, and by nothing else", () => {
  assert.equal(retailerByCode("walmart"), walmart);
  assert.equal(retailerByCode("Walmart"), null);
  assert.equal(retailerByCode("__proto__"), null);
  assert.equal(retailerByCode("amazon"), amazon);
  assert.deepEqual(RETAILERS.map((r) => r.code), ["walmart", "amazon"]);
});

test("every retailer opens on an https page it would itself save", () => {
  for (const retailer of RETAILERS) {
    assert.equal(new URL(retailer.startUrl).protocol, "https:");
    assert.notEqual(retailer.captureKind(retailer.startUrl), null, retailer.code);
  }
});

// ---- paging and the window's title ---------------------------------------------------------------

const purchaseHistory = (history) =>
  JSON.stringify({ props: { pageProps: { phRedesignInitialData: { data: { purchaseHistory: history } } } } });

test("Walmart: Purchase history says whether there is a page after it by its next cursor", () => {
  assert.equal(walmart.hasNextListPage(purchaseHistory({ orders: [], pageInfo: { nextPageCursor: "abc", prevPageCursor: null } })), true);
  for (const payload of [
    purchaseHistory({ orders: [], pageInfo: { nextPageCursor: null } }),
    purchaseHistory({ orders: [], pageInfo: { nextPageCursor: "" } }),
    purchaseHistory({ orders: [] }),
    "not json",
  ]) {
    assert.equal(walmart.hasNextListPage(payload), false);
  }
});

// Purchase history pages by a cursor the page holds. A fresh load of /orders?page=2 served page 1
// again (2026-10-03), so only the first page has an address.
test("Walmart: only the first page of Purchase history has an address", () => {
  assert.equal(walmart.listPageUrl(1), "https://www.walmart.com/orders");
  assert.equal(walmart.captureKind(walmart.listPageUrl(1)), "order_list_next_data");
  for (const later of [2, 3, 0, -1, 1.5, NaN]) assert.throws(() => walmart.listPageUrl(later));
});

/** Runs a retailer's next-page expression against a stand-in for the page. */
const press = (script, find) => new Function("document", `return ${script}`)({ querySelector: find });

test("Walmart: a later page is reached by pressing the page's own Next page button", () => {
  assert.equal(walmart.nextPageKind, "order_list_json");
  // The response the press makes the page fetch is one the app saves.
  assert.equal(walmart.responseKind("https://www.walmart.com/orchestra/cph/graphql/PurchaseHistoryV3/abc"), walmart.nextPageKind);

  const button = (overrides = {}) => {
    const b = { pressed: 0, disabled: false, getAttribute: () => null, click() { this.pressed += 1; }, ...overrides };
    return b;
  };

  // Found by the marker Walmart gives it.
  const marked = button();
  assert.equal(press(walmart.nextPageScript, (q) => (q.includes("next-pages-button") ? marked : null)), true);
  assert.equal(marked.pressed, 1);

  // Or by its label, should the marker go.
  const labelled = button();
  assert.equal(press(walmart.nextPageScript, (q) => (q.includes('aria-label="Next page"') ? labelled : null)), true);
  assert.equal(labelled.pressed, 1);

  // No button, or one that is switched off: nothing is pressed, and the run is told so.
  assert.equal(press(walmart.nextPageScript, () => null), false);
  for (const off of [button({ disabled: true }), button({ getAttribute: (name) => (name === "aria-disabled" ? "true" : null) })]) {
    assert.equal(press(walmart.nextPageScript, () => off), false);
    assert.equal(off.pressed, 0);
  }
});

test("Walmart: a later page's orders are read from the response the page fetched", () => {
  const order = (id) => ({ id, orderDate: "2026-09-01T10:00:00-05:00", version: 1, itemCount: 2, priceDetails: { orderTotal: { value: 12.5 } }, groups: [] });
  const history = { orders: [order("200000000000206"), order("200000000000207")], pageInfo: { nextPageCursor: "c3", prevPageCursor: "c1" } };
  const response = JSON.stringify({ data: { purchaseHistory: history } });

  assert.deepEqual(walmart.listedOrders(response).map((o) => o.id), ["200000000000206", "200000000000207"]);
  assert.equal(walmart.hasNextListPage(response), true);
  // The same orders embedded in a page read the same, fingerprint and all.
  assert.deepEqual(walmart.listedOrders(response), walmart.listedOrders(purchaseHistory(history)));

  assert.equal(walmart.hasNextListPage(JSON.stringify({ data: { purchaseHistory: { orders: [], pageInfo: { nextPageCursor: null } } } })), false);
  // A response that is not Purchase history lists nothing, which ends the paging.
  assert.deepEqual(walmart.listedOrders(JSON.stringify({ data: { order: { id: "1" } } })), []);
  assert.deepEqual(walmart.listedOrders(JSON.stringify({ errors: [{ message: "x" }] })), []);
});

test("Walmart: a listed order carries the day it was placed, or null", () => {
  const order = { id: "200000000000001", groups: [] };
  const [dated, undated, odd] = walmart.listedOrders(
    purchaseHistory({
      orders: [
        { ...order, orderDate: "2026-09-15T10:30:00-05:00" },
        { ...order, id: "200000000000002" },
        { ...order, id: "200000000000003", orderDate: "Sep 15" },
      ],
    }),
  );
  assert.deepEqual([dated.date, undated.date, odd.date], ["2026-09-15", null, null]);
});

test("a store window's title is where it is, query and all, in place of an address bar", () => {
  assert.equal(windowTitle(walmart, "https://www.walmart.com/orders?page=2"), "Walmart — www.walmart.com/orders?page=2");
  assert.equal(windowTitle(walmart, "file:///Users/x/fixtures/order-page.html"), "Walmart — order-page.html");
  assert.equal(windowTitle(walmart, "not a url"), "Walmart");
  assert.equal(windowTitle(walmart, "about:blank"), "Walmart");
});

// ---- Amazon --------------------------------------------------------------------------------------

test("Amazon: Your Orders, an order's details and Your Payments are worth saving, and nothing else", () => {
  const cases = [
    ["https://www.amazon.com/your-orders/orders", "order_list_html"],
    ["https://www.amazon.com/your-orders/orders?timeFilter=year-2026&startIndex=10", "order_list_html"],
    ["https://www.amazon.com/gp/css/order-history?ref_=nav_orders_first", "order_list_html"],
    ["https://www.amazon.com/gp/your-account/order-details?orderID=111-0000001-0000001", "order_detail_html"],
    ["https://www.amazon.com/your-orders/order-details?orderID=111-0000001-0000001", "order_detail_html"],
    ["https://www.amazon.com/cpe/yourpayments/transactions", "payments_html"],
    ["https://www.amazon.com/cpe/yourpayments/wallet", null],
    ["https://www.amazon.com/a/addresses", null],
    ["https://www.amazon.com/ap/signin?openid.return_to=x", null],
    ["https://www.amazon.com/dp/B000000000", null],
    ["http://www.amazon.com/your-orders/orders", null],
    ["https://www.amazon.co.uk/your-orders/orders", null],
    ["https://amazon.com.evil.example/your-orders/orders", null],
  ];
  for (const [url, kind] of cases) assert.equal(amazon.captureKind(url), kind, url);
});

test("Amazon: its robot check is recognized by address and by content", () => {
  assert.equal(amazon.isChallenge("https://www.amazon.com/errors/validateCaptcha?amzn=x"), true);
  assert.equal(amazon.isChallenge("https://www.amazon.com/your-orders/orders"), false);
  assert.equal(amazon.isChallengePayload('<form method="get" action="/errors/validateCaptcha" name="">'), true);
  assert.equal(amazon.isChallengePayload('<div class="order-card">'), false);
});

test("Amazon: a page still carrying the sign-in form is not an account with no orders", () => {
  assert.equal(amazon.isSignedOut("order_list_html", '<input type="email" id="ap_email" name="email">'), true);
  assert.equal(amazon.isSignedOut("order_list_html", '<form name="signIn" method="post">'), true);
  assert.equal(amazon.isSignedOut("order_list_html", '<div class="order-card">Order placed</div>'), false);
});

// Amazon's Agent Terms (2026-08-14): software acting by itself must say so. Until a sync does,
// the app only saves what the member opens.
test("Amazon: saved from the page as Amazon sent it, and synced as an agent that says so", () => {
  assert.equal(amazon.saves, "document");
  assert.equal(amazon.syncs, true);
  assert.equal(amazon.agent, "SageFinDesktop");
  // Only Amazon's terms ask for it.
  assert.equal(walmart.agent, undefined);
  assert.equal(amazon.responseKind("https://www.amazon.com/your-orders/orders"), null);
  assert.equal(amazon.needsReload("https://www.amazon.com/your-orders/orders"), false);
});

test("a store that syncs says how, and Walmart reads its embedded data", () => {
  for (const r of RETAILERS.filter((x) => x.syncs)) {
    for (const f of ["listedOrders", "hasNextListPage", "listPageUrl", "orderIdIn"]) assert.equal(typeof r[f], "function", `${r.code}.${f}`);
  }
  assert.equal(walmart.saves, "next_data");
});

// A stand-in in the shape of Your Payments as saved on 2026-10-02: date headings, then rows, each
// with the card, the amount and an "Order #" link. Every value invented.
const paymentRow = (order, amount) =>
  `<div class="a-section a-spacing-base apx-transactions-line-item-component-container"><div class="a-row"><div class="a-column a-span9"><span class="a-size-base a-text-bold">Visa ****1234</span></div><div class="a-column a-span3"><span class="a-size-base-plus a-text-bold">${amount}</span></div></div><div class="a-section"><a class="a-link-normal" href="https://www.amazon.com/gp/css/summary/edit.html?orderID=${order}">Order #${order}</a></div><div class="a-section"><span class="a-size-base">AMZN Mktp US</span></div></div><hr>`;
const dateHeading = (text) =>
  `<div class="a-section a-spacing-base apx-transaction-date-container pmts-portal-component"><span>${text}</span></div>`;
const paymentsPage = (...parts) => `<html><body><div class="apx-transactions">${parts.join("")}</div></body></html>`;

test("Amazon: Your Payments lists each order once, with its latest charge's date and its details page", () => {
  const page = paymentsPage(
    dateHeading("October 9, 2026"),
    paymentRow("113-0000001-0000001", "-$38.52"),
    paymentRow("113-0000002-0000002", "-$1,204.00"),
    dateHeading("September 30, 2026"),
    paymentRow("113-0000001-0000001", "-$5.00"),
    paymentRow("113-0000003-0000003", "+$5.00"),
  );

  const listed = amazon.listedOrders(page);

  assert.deepEqual(
    listed.map((o) => [o.id, o.date, o.url]),
    [
      ["113-0000001-0000001", "2026-10-09", "https://www.amazon.com/gp/your-account/order-details?orderID=113-0000001-0000001"],
      ["113-0000002-0000002", "2026-10-09", "https://www.amazon.com/gp/your-account/order-details?orderID=113-0000002-0000002"],
      ["113-0000003-0000003", "2026-09-30", "https://www.amazon.com/gp/your-account/order-details?orderID=113-0000003-0000003"],
    ],
  );
  // Every listed address is a page the app saves.
  for (const o of listed) assert.equal(amazon.captureKind(o.url), "order_detail_html");
});

// A new charge or a refund on an order is a reason to read its page again; the same rows are not.
test("Amazon: an order's fingerprint changes with its charges and with nothing else", () => {
  const once = paymentsPage(dateHeading("October 9, 2026"), paymentRow("113-0000001-0000001", "-$38.52"));
  const again = paymentsPage(`<div class="banner">New offer</div>`, dateHeading("October 9, 2026"), paymentRow("113-0000001-0000001", "-$38.52"));
  const refunded = paymentsPage(
    dateHeading("October 12, 2026"),
    paymentRow("113-0000001-0000001", "+$38.52"),
    dateHeading("October 9, 2026"),
    paymentRow("113-0000001-0000001", "-$38.52"),
  );

  const [a] = amazon.listedOrders(once);
  const [b] = amazon.listedOrders(again);
  const [c] = amazon.listedOrders(refunded);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, c.fingerprint);
});

test("Amazon: a row without an order number, or a page that is not Your Payments, lists nothing", () => {
  assert.deepEqual(amazon.listedOrders(paymentsPage(dateHeading("October 9, 2026"), paymentRow("not-an-order", "-$1.00"))), []);
  assert.deepEqual(amazon.listedOrders("<html><body>Your Orders</body></html>"), []);
  assert.deepEqual(amazon.listedOrders(""), []);
});

test("Amazon: a sync starts at Your Payments, and a details page names its order by its invoice link", () => {
  assert.equal(amazon.listPageUrl(1), "https://www.amazon.com/cpe/yourpayments/transactions");
  assert.equal(amazon.captureKind(amazon.listPageUrl(1)), "payments_html");
  // Its later pages have no address: a sync submits the page's own form, which loads a new page,
  // so there is no response to wait for as there is at Walmart.
  assert.throws(() => amazon.listPageUrl(2));
  assert.equal(typeof amazon.nextPageScript, "string");
  assert.equal(amazon.nextPageKind, undefined);

  assert.equal(amazon.orderIdIn('<a href="/gp/css/summary/print.html?orderID=113-0000001-0000001">Invoice</a>'), "113-0000001-0000001");
  assert.equal(amazon.orderIdIn('<a href="/your-orders/pop?orderId=113-0000001-0000001"><a href="/your-orders/pop?orderId=113-0000002-0000002">'), null);
});

// The shape seen on 2026-10-02: Previous is a disabled submit with no name; Next is a submit named
// for the next page's key.
test("Amazon: Your Payments has a next page while its Next button is a live, named submit", () => {
  const previous = '<input disabled="disabled" class="a-button-input" type="submit">';
  const next = '<input name="ppw-widgetEvent:DefaultNextPageNavigationEvent:{&quot;nextPageKey&quot;:&quot;k2&quot;}" class="a-button-input" type="submit">';
  const nextDisabled = '<input disabled="disabled" name="ppw-widgetEvent:DefaultNextPageNavigationEvent:{}" class="a-button-input" type="submit">';

  assert.equal(amazon.hasNextListPage(paymentsPage(previous, next)), true);
  assert.equal(amazon.hasNextListPage(paymentsPage(previous)), false);
  assert.equal(amazon.hasNextListPage(paymentsPage(nextDisabled)), false);
  assert.equal(amazon.hasNextListPage(paymentsPage()), false);
});

// The first real run: 2 of 20 details pages had no invoice link, so their orders were never
// remembered as read.
test("Amazon: a details page with no invoice link is named by its other order links, when they agree", () => {
  const tracking = '<a href="/progress-tracker/package?itemId=x&amp;orderId=113-0000001-0000001">Track package</a>';
  const returns = '<a href="/spr/returns/cart?orderId=113-0000001-0000001">Return items</a>';
  const other = '<a href="/your-orders/pop?orderId=113-0000002-0000002">';

  assert.equal(amazon.orderIdIn(`<html>${tracking}${returns}</html>`), "113-0000001-0000001");
  // Two orders linked from one page: not an answer.
  assert.equal(amazon.orderIdIn(`<html>${tracking}${other}</html>`), null);
  assert.equal(amazon.orderIdIn("<html>No links</html>"), null);

  // What SageFin's own reader takes the number from: the page's order-number element. It wins over
  // links to other orders on the page, which a replacement or a split shipment carries.
  const element = '<div data-component="orderId"><span>Order #</span> <bdi dir="ltr">113-0000003-0000003</bdi></div>';
  assert.equal(amazon.orderIdIn(`<html>${element}</html>`), "113-0000003-0000003");
  assert.equal(amazon.orderIdIn(`<html>${element}${tracking}${other}</html>`), "113-0000003-0000003");
  // A digital order's number starts D01.
  assert.equal(
    amazon.orderIdIn('<div data-component="orderId"><bdi dir="ltr">D01-0000004-0000004</bdi></div>'),
    "D01-0000004-0000004",
  );
  // No element and no links, but the page names exactly one order.
  assert.equal(amazon.orderIdIn("<html><p>Order placed. Order # 113-0000005-0000005</p></html>"), "113-0000005-0000005");
  assert.equal(amazon.orderIdIn("<html><p>113-0000005-0000005 replaces 113-0000006-0000006</p></html>"), null);
  // Part of a longer run of digits is not an order number.
  assert.equal(amazon.orderIdIn("<html><p>ref 9113-0000005-00000059</p></html>"), null);
  // The invoice link wins over anything else on the page.
  assert.equal(
    amazon.orderIdIn(`<html>${other}<a href="/gp/css/summary/print.html?orderID=113-0000001-0000001"></a></html>`),
    "113-0000001-0000001",
  );
});
