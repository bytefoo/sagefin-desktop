import assert from "node:assert/strict";
import { test } from "node:test";
import { keyPaths, keyPattern } from "./key-paths.mjs";

const page = JSON.stringify({
  props: {
    pageProps: {
      bootstrapData: { account: { data: { profile: { ceid: "SECRET-ID-0001", emailAddress: "alex@test.invalid", firstName: "Alex" } } } },
      orders: [
        { id: "200000000000001", customer: { email: "alex@test.invalid" } },
        { id: "200000000000002", customer: { email: "alex@test.invalid" } },
      ],
    },
  },
});

test("it says where a name appears and what shape is there", () => {
  assert.deepEqual(keyPaths(page, /ceid|email/i), [
    "props.pageProps.bootstrapData.account.data.profile.ceid: string(14)",
    "props.pageProps.bootstrapData.account.data.profile.emailAddress: string(17)",
    "props.pageProps.orders[].customer.email: string(17)",
  ]);
});

test("it never prints a value, whatever is asked for", () => {
  const out = keyPaths(page, /./).join("\n");

  for (const value of ["SECRET-ID-0001", "alex@test.invalid", "Alex", "200000000000001"]) {
    assert.equal(out.includes(value), false, value);
  }
});

test("a list is one line however long it is, and the output is bounded", () => {
  const long = JSON.stringify({ orders: Array.from({ length: 500 }, (_, i) => ({ email: `m${i}@test.invalid` })) });

  assert.deepEqual(keyPaths(long, /email/), ["orders[].email: string(15)"]);
  assert.equal(keyPaths(JSON.stringify(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, 1]))), /k/, 10).length, 10);
});

test("a page that is not JSON has no keys to name", () => {
  assert.deepEqual(keyPaths("<html><body>Your Orders</body></html>", /./), []);
});

test("the setting is a pattern, and one that cannot be read asks for nothing", () => {
  assert.equal(keyPattern(undefined), null);
  assert.equal(keyPattern(""), null);
  assert.equal(keyPattern("ceid|("), null);
  assert.equal(keyPattern("CEID|email")?.test("ceid"), true);
});
