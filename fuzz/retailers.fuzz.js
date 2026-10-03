// What a retailer's page says is not the app's to choose: these run the code that reads it against
// pages nobody wrote. Each property is a promise the readme makes, held for any input rather than
// for the examples lib/retailers.test.mjs has.
//
// Kept out of lib/ because fast-check has to be installed, and `npm test` runs with nothing
// installed. `npm run fuzz` runs these.

import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { RETAILERS, amazon, listSignature, walmart, windowTitle } from "../lib/retailers.mjs";

// A hundred pages, the default, is too few to reach the code behind the first pattern: with it,
// three deliberate breaks of lib/retailers.mjs went unreported. Two thousand takes under a second.
fc.configureGlobal({ numRuns: 2000 });

// The pieces a real page is made of, so a generated one gets past the first pattern often enough to
// reach the code behind it. Order numbers here are made up.
const AMAZON_PIECES = [
  'apx-transaction-date-container"><span>October 9, 2026</span>',
  'apx-transaction-date-container"><span>',
  "</span>",
  "apx-transactions-line-item-component-container",
  "Order #",
  "111-0000001-0000001",
  "D01-0000002-0000002",
  "$12.34",
  "-$1,234.56",
  "/gp/css/summary/print.html?orderID=",
  'data-component="orderId">',
  "?orderID=",
  "&amp;orderId=",
  '<input type="submit" name="ppw-widgetEvent:DefaultNextPageNavigationEvent',
  " disabled ",
  'action="/errors/validateCaptcha"',
  'id="ap_email"',
  "<",
  ">",
  '"',
  " ",
  "\n",
];

const amazonPiece = fc.oneof(fc.constantFrom(...AMAZON_PIECES), fc.string(), fc.stringMatching(/^\d{3}-\d{7}-\d{7}$/));
// A row of Your Payments with something unexpected where its order number or its amount should be.
const amazonRow = fc
  .tuple(amazonPiece, amazonPiece, amazonPiece, amazonPiece)
  .map(([before, number, between, amount]) => `apx-transactions-line-item-component-container${before}Order #${number}${between}${amount}$12.34`);
const amazonPage = fc.array(fc.oneof(amazonPiece, amazonRow), { maxLength: 40 }).map((parts) => parts.join(""));

// Purchase history as Walmart shapes it, with anything at all where the app expects a value.
// JSON can carry an object named like the methods a value is turned into text with, and one of
// those where text is expected throws rather than reads as "[object Object]".
const anything = fc.oneof(
  { weight: 4, arbitrary: fc.jsonValue() },
  { weight: 1, arbitrary: fc.constantFrom({ toString: 1 }, { toString: null, valueOf: 0 }, [{ toString: 1 }]) },
);
const walmartOrder = fc.oneof(
  anything,
  fc.record(
    {
      id: fc.oneof(anything, fc.string(), fc.stringMatching(/^\d{6,30}$/)),
      version: anything,
      itemCount: anything,
      orderDate: fc.oneof(anything, fc.constant("2026-10-03T10:00:00.000-0500")),
      priceDetails: anything,
      groups: fc.oneof(
        anything,
        fc.array(
          fc.oneof(
            anything,
            fc.record(
              {
                groupId: fc.oneof(anything, fc.string(), fc.stringMatching(/^[0-9a-f]{16,64}$/)),
                items: fc.oneof(anything, fc.array(fc.oneof(anything, fc.record({ id: anything, statusCode: anything, isUnavailable: anything })))),
              },
              { requiredKeys: [] },
            ),
          ),
        ),
      ),
    },
    { requiredKeys: [] },
  ),
);
const walmartHistory = fc.oneof(
  anything,
  fc.record({ orders: fc.oneof(anything, fc.array(walmartOrder)), pageInfo: anything }, { requiredKeys: [] }),
);
const walmartPage = fc.oneof(
  fc.string(),
  anything.map((v) => JSON.stringify(v)),
  walmartHistory.map((purchaseHistory) => JSON.stringify({ props: { pageProps: { phRedesignInitialData: { data: { purchaseHistory } } } } })),
  walmartHistory.map((purchaseHistory) => JSON.stringify({ data: { purchaseHistory } })),
);

const page = fc.oneof(amazonPage, walmartPage);

// Addresses that are nearly the retailer's as well as ones that are nothing like it.
const address = fc.oneof(
  fc.string(),
  fc.webUrl({ withQueryParameters: true, withFragments: true }),
  fc
    .tuple(
      fc.constantFrom("https:", "http:", "file:", "javascript:", ""),
      fc.constantFrom("www.walmart.com", "walmart.com", "www.amazon.com", "amazon.com", "www.walmart.com.example.com", "example.com", "www.amazon.com@example.com", ""),
      fc.constantFrom("/orders", "/orders/200000000000001", "/blocked", "/your-orders/orders", "/gp/your-account/order-details", "/cpe/yourpayments/transactions", "/errors/validateCaptcha", "/orchestra/cph/graphql/PurchaseHistoryV2/abc", "/orchestra/orders/graphql/getOrder/abc", "/"),
      fc.oneof(fc.constant(""), fc.string(), fc.string().map((s) => `/${s}`), fc.string().map((s) => `?${s}`)),
    )
    .map(([scheme, host, path, rest]) => `${scheme}//${host}${path}${rest}`),
);

const HOSTS = {
  walmart: ["www.walmart.com", "walmart.com"],
  amazon: ["www.amazon.com", "amazon.com"],
};
const ORDER_PAGE = { walmart: "order_detail_next_data", amazon: "order_detail_html" };
const ORDER_NUMBER = { walmart: /^\d{6,30}$/, amazon: /^\d{3}-\d{7}-\d{7}$/ };
// The whole address, not only where it points: what follows the order number is the list's too.
const ORDER_URL = {
  walmart: /^https:\/\/www\.walmart\.com\/orders\/\d{6,30}(\?groupId=[0-9a-f]{16,64})?$/i,
  amazon: /^https:\/\/www\.amazon\.com\/gp\/your-account\/order-details\?orderID=\d{3}-\d{7}-\d{7}$/,
};

for (const retailer of RETAILERS) {
  test(`${retailer.name}: no page a retailer could send makes a reader throw`, () => {
    fc.assert(
      fc.property(page, fc.constantFrom("order_list_next_data", "order_detail_next_data", "order_list_html", "payments_html", ""), (payload, kind) => {
        retailer.listedOrders?.(payload);
        retailer.hasNextListPage?.(payload);
        retailer.orderIdIn?.(payload);
        retailer.isChallengePayload?.(payload);
        retailer.isSignedOut(kind, payload);
        listSignature(retailer, payload);
      }),
    );
  });

  test(`${retailer.name}: no address makes a reader throw`, () => {
    fc.assert(
      fc.property(address, fc.boolean(), (url, anyHost) => {
        retailer.captureKind(url, { anyHost });
        retailer.isChallenge(url, { anyHost });
        retailer.responseKind(url, { anyHost });
        retailer.needsReload(url);
        assert.equal(typeof windowTitle(retailer, url), "string");
      }),
    );
  });

  // "Nothing else in the account is read", and nothing anywhere else either.
  test(`${retailer.name}: a page or a response is only ever saved from the retailer itself, over https`, () => {
    fc.assert(
      fc.property(address, (url) => {
        const saved = retailer.captureKind(url) ?? retailer.responseKind(url);
        if (saved === null && !retailer.isChallenge(url)) return;
        const u = new URL(url);
        assert.equal(u.protocol, "https:");
        assert.ok(HOSTS[retailer.code].includes(u.hostname), u.hostname);
      }),
    );
  });

  // A sync loads the address a list gave it. Whatever the list said, that address is the
  // retailer's own order page and nothing else.
  test(`${retailer.name}: every order a list names is opened at the retailer's own order page`, () => {
    fc.assert(
      fc.property(page, (payload) => {
        const listed = retailer.listedOrders?.(payload) ?? [];
        for (const order of listed) {
          assert.match(order.id, ORDER_NUMBER[retailer.code]);
          assert.equal(retailer.captureKind(order.url), ORDER_PAGE[retailer.code], order.url);
          assert.match(order.url, ORDER_URL[retailer.code]);
          assert.ok(order.url.includes(order.id));
          assert.match(order.fingerprint, /^[0-9a-f]{64}$/);
          assert.ok(order.date === null || /^\d{4}-\d{2}-\d{2}$/.test(order.date), String(order.date));
        }
        assert.equal(new Set(listed.map((o) => o.url)).size, new Set(listed.map((o) => o.id)).size);
      }),
    );
  });
}

test("Amazon: the order a details page is placed under is a number the page itself carries", () => {
  fc.assert(
    fc.property(amazonPage, (payload) => {
      const id = amazon.orderIdIn?.(payload) ?? null;
      if (id === null) return;
      assert.match(id, /^(?:\d{3}|D\d{2})-\d{7}-\d{7}$/);
      assert.ok(payload.includes(id));
    }),
  );
});

test("Amazon: each order is listed once, however many charges it has", () => {
  fc.assert(
    fc.property(amazonPage, (payload) => {
      const ids = (amazon.listedOrders?.(payload) ?? []).map((o) => o.id);
      assert.equal(new Set(ids).size, ids.length);
    }),
  );
});

// Walmart reorders parts of an order on every load. The fingerprint is there to ignore that.
test("Walmart: an order's fingerprint does not change with the order its items come in", () => {
  const item = fc.record({ id: fc.string(), statusCode: fc.string(), isUnavailable: fc.boolean() });
  const order = fc.record({
    id: fc.stringMatching(/^\d{6,30}$/),
    version: fc.integer(),
    itemCount: fc.nat(),
    groups: fc.array(fc.record({ groupId: fc.stringMatching(/^[0-9a-f]{16}$/), items: fc.array(item, { maxLength: 6 }) }), { minLength: 1, maxLength: 3 }),
  });
  const list = (/** @type {any} */ o) => JSON.stringify({ data: { purchaseHistory: { orders: [o] } } });

  fc.assert(
    fc.property(order, (o) => {
      const reversed = { ...o, groups: o.groups.map((g) => ({ ...g, items: [...g.items].reverse() })) };
      const [a] = walmart.listedOrders?.(list(o)) ?? [];
      const [b] = walmart.listedOrders?.(list(reversed)) ?? [];
      assert.ok(a && b);
      assert.equal(a.fingerprint, b.fingerprint);
    }),
  );
});
