import assert from "node:assert/strict";
import { test } from "node:test";
import { findOrder, listOrders } from "../orders.js";

test("注文の一覧を返す", () => {
  assert.equal(listOrders().length, 3);
});

test("注文を id で探す", () => {
  assert.deepEqual(findOrder(2), { id: 2, item: "みかん", quantity: 1 });
  assert.equal(findOrder(99), undefined);
});
