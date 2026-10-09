import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { handleApi, HttpError } from "./api.ts";
import { handleWrite, workerView, type Ops } from "./write-api.ts";
import { send, serveFile } from "./files.ts";
import { DEFAULT_GUI_DIR, serveGui } from "./static.ts";
import { StreamHub } from "./stream.ts";

/**
 * ローカルサーバー(設計メモ14章 v0.8)。読み取り専用で、127.0.0.1 だけで待ち受ける。
 * - /api/*: 読み取り API(api.ts)と SSE(stream.ts)
 * - /files/*: 成果物の置き場所のファイル(files.ts)
 * - それ以外: GUI(gui/ のビルド結果。static.ts)
 * 書き込み API(write-api.ts)は ops を渡したときだけ受け付ける(フェーズ3)。
 */

const HOST = "127.0.0.1";

export type RunningServer = { url: string; address: string; port: number; close: () => Promise<void> };

/** DNS リバインディング対策: 127.0.0.1 / localhost 宛ての要求だけを受け付ける */
function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `${HOST}:${port}` || host === `localhost:${port}`;
}

type Options = { home: string; guiDir: string; hub: StreamHub; ops?: Ops };

const MAX_BODY = 1024 * 1024;
const json = (res: ServerResponse, status: number, data: unknown) => send(res, status, JSON.stringify(data), "application/json; charset=utf-8");

/**
 * 外部のサイトからの書き込みを防ぐ(設計メモ14章 v0.10)。専用ヘッダーの付いた要求はブラウザがプリフライトを送るが、
 * CORS を許可しないので外部のサイトからは届かない。Origin も自分自身に限る
 */
function writeAllowed(req: IncomingMessage, port: number): string | null {
  if (req.headers["x-agent-crew"] !== "1") return "X-Agent-Crew ヘッダーがありません";
  const origin = req.headers.origin;
  if (origin !== `http://${HOST}:${port}` && origin !== `http://localhost:${port}`) return "Origin が違います";
  return null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "本文が大きすぎます"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handlePost(o: Options, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (!o.ops) return json(res, 405, { error: "読み取り専用で起動しています(--no-worker)。操作は CLI で行います" });
  if (!path.startsWith("/api/")) return json(res, 404, { error: "ありません" });
  const denied = writeAllowed(req, req.socket.localPort ?? 0);
  if (denied) return json(res, 403, { error: denied });
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "本文は application/json で送ってください" });
  try {
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, "本文が JSON ではありません");
    }
    const r = await handleWrite(o.ops, path.slice("/api/".length), body);
    json(res, r.status, r.data);
  } catch (e) {
    if (e instanceof HttpError) return json(res, e.status, { error: e.message });
    json(res, 500, { error: (e as Error).message });
  }
}

function handle(o: Options, req: IncomingMessage, res: ServerResponse): void {
  if (!hostAllowed(req.headers.host, req.socket.localPort ?? 0)) return send(res, 403, "127.0.0.1 または localhost で開いてください");
  // URL の正規化(.. の解決)をさせず、生のパスで振り分ける。パスの検査は各配信側で行う
  const [path = "/", search = ""] = (req.url ?? "/").split("?", 2);
  if (req.method === "POST") return void handlePost(o, req, res, path);
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("allow", o.ops ? "GET, HEAD, POST" : "GET, HEAD");
    return send(res, 405, "この操作は受け付けません");
  }
  const query = new URLSearchParams(search);
  try {
    if (path === "/api/stream") return o.hub.add(req, res);
    if (path.startsWith("/api/")) {
      try {
        return send(res, 200, JSON.stringify(handleApi(o.home, path.slice("/api/".length), query, workerView(o.ops?.worker))), "application/json; charset=utf-8");
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

/**
 * pollMs は SSE が DB の変化を調べる間隔(既定1秒)。guiDir は GUI のビルド結果(既定 dist/gui)。
 * ops を渡すと書き込み API を受け付ける(無ければ読み取り専用)
 */
export function startServer(o: { home: string; port: number; pollMs?: number; guiDir?: string; ops?: Ops }): Promise<RunningServer> {
  const hub = new StreamHub(o.home, o.pollMs ?? 1000);
  const opts: Options = { home: o.home, guiDir: o.guiDir ?? DEFAULT_GUI_DIR, hub, ops: o.ops };
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
