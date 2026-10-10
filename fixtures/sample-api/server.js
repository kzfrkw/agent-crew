import { createServer } from "node:http";
import { findOrder, listOrders } from "./orders.js";

const port = Number(process.env.PORT ?? 3101);

export const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && url.pathname === "/api/orders") return json(200, listOrders());
  const m = /^\/api\/orders\/(\d+)$/.exec(url.pathname);
  if (req.method === "GET" && m) {
    const order = findOrder(Number(m[1]));
    return order ? json(200, order) : json(404, { error: "not found" });
  }
  json(404, { error: "not found" });
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(port, "127.0.0.1", () => console.log(`listening on http://127.0.0.1:${port}/`));
}
