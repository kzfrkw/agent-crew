import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { handleApi, HttpError } from "./api.ts";
import { send, serveFile } from "./files.ts";
import { DEFAULT_GUI_DIR, serveGui } from "./static.ts";
import { StreamHub } from "./stream.ts";

/**
 * ローカルサーバー(設計メモ14章 v0.8)。読み取り専用で、127.0.0.1 だけで待ち受ける。
 * - /api/*: 読み取り API(api.ts)と SSE(stream.ts)
 * - /files/*: 成果物の置き場所のファイル(files.ts)
 * - それ以外: GUI(gui/ のビルド結果。static.ts)
 * 操作は CLI のまま(操作できる GUI はフェーズ3)。
 */

const HOST = "127.0.0.1";

export type RunningServer = { url: string; address: string; port: number; close: () => Promise<void> };

/** DNS リバインディング対策: 127.0.0.1 / localhost 宛ての要求だけを受け付ける */
function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `${HOST}:${port}` || host === `localhost:${port}`;
}

type Options = { home: string; guiDir: string; hub: StreamHub };

function handle(o: Options, req: IncomingMessage, res: ServerResponse): void {
  if (!hostAllowed(req.headers.host, req.socket.localPort ?? 0)) return send(res, 403, "127.0.0.1 または localhost で開いてください");
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("allow", "GET, HEAD");
    return send(res, 405, "読み取り専用です(操作は CLI で行います)");
  }
  // URL の正規化(.. の解決)をさせず、生のパスで振り分ける。パスの検査は各配信側で行う
  const [path = "/", search = ""] = (req.url ?? "/").split("?", 2);
  const query = new URLSearchParams(search);
  try {
    if (path === "/api/stream") return o.hub.add(req, res);
    if (path.startsWith("/api/")) {
      try {
        return send(res, 200, JSON.stringify(handleApi(o.home, path.slice("/api/".length), query)), "application/json; charset=utf-8");
      } catch (e) {
        if (e instanceof HttpError) return send(res, e.status, JSON.stringify({ error: e.message }), "application/json; charset=utf-8");
        throw e;
      }
    }
    if (path.startsWith("/files/")) return serveFile(o.home, path.slice("/files/".length), res);
    serveGui(o.guiDir, path, res);
  } catch (e) {
    send(res, 500, `エラー: ${(e as Error).message}`);
  }
}

/** pollMs は SSE が DB の変化を調べる間隔(既定1秒)。guiDir は GUI のビルド結果(既定 dist/gui) */
export function startServer(o: { home: string; port: number; pollMs?: number; guiDir?: string }): Promise<RunningServer> {
  const hub = new StreamHub(o.home, o.pollMs ?? 1000);
  const opts: Options = { home: o.home, guiDir: o.guiDir ?? DEFAULT_GUI_DIR, hub };
  const server = createServer((req, res) => handle(opts, req, res));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, HOST, () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://${HOST}:${addr.port}/`,
        address: addr.address,
        port: addr.port,
        close: () =>
          new Promise((r) => {
            hub.close();
            server.close(() => r());
            server.closeAllConnections();
          }),
      });
    });
  });
}
