import { createServer } from "node:http";
import { renderOrders } from "./render.js";

const port = Number(process.env.PORT ?? 3100);
// API の場所(複数リポジトリのつなぎ方で渡す)
const api = process.env.API_URL ?? "http://127.0.0.1:3101/";

export const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/") {
    try {
      const orders = await (await fetch(new URL("/api/orders", api))).json();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(renderOrders(orders));
    } catch (e) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      return res.end(`API に接続できません: ${e.message}`);
    }
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(port, "127.0.0.1", () => console.log(`listening on http://127.0.0.1:${port}/`));
}
