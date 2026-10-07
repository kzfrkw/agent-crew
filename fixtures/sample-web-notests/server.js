import { createServer } from "node:http";
import { findItem, listItems } from "./items.js";

const port = Number(process.env.PORT ?? 3000);

export const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return res.end("sample-web\n");
  }
  if (req.method === "GET" && url.pathname === "/api/items") return json(200, listItems());
  const m = /^\/api\/items\/(\d+)$/.exec(url.pathname);
  if (req.method === "GET" && m) {
    const item = findItem(Number(m[1]));
    return item ? json(200, item) : json(404, { error: "not found" });
  }
  json(404, { error: "not found" });
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(port, "127.0.0.1", () => console.log(`listening on http://127.0.0.1:${port}/`));
}
