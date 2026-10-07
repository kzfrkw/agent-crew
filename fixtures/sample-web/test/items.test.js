import assert from "node:assert/strict";
import { test } from "node:test";
import { findItem, listItems } from "../items.js";

test("listItems は全アイテムを返す", () => {
  assert.equal(listItems().length, 3);
});

test("findItem は id で1件を返し、無ければ undefined", () => {
  assert.equal(findItem(1).name, "りんご");
  assert.equal(findItem(99), undefined);
});
