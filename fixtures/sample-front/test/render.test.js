import assert from "node:assert/strict";
import { test } from "node:test";
import { renderOrders } from "../render.js";

test("注文を表の行にする", () => {
  const html = renderOrders([{ id: 1, item: "りんご", quantity: 3 }]);
  assert.match(html, /<td>りんご<\/td><td>3<\/td>/);
});

test("値はエスケープする", () => {
  assert.match(renderOrders([{ id: 1, item: "<b>", quantity: 1 }]), /&lt;b&gt;/);
});
