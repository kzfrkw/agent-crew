import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { send } from "./files.ts";

/** GUI(gui/)のビルド結果の置き場所 */
export const DEFAULT_GUI_DIR = fileURLToPath(new URL("../../dist/gui", import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

/** 成果物の Markdown は react-markdown が生の HTML を通さないが、念のため外部への読み込みも止める */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * GUI を配信する。ファイルがあればそれを、無ければ画面の URL とみなして index.html を返す(SPA)。
 * 拡張子つきで見つからないもの(assets/xxx.js など)は 404。
 */
export function serveGui(guiDir: string, path: string, res: ServerResponse): void {
  let rel: string;
  try {
    rel = decodeURIComponent(path).replace(/^\/+/, "");
  } catch {
    return send(res, 400, "不正なパスです");
  }
  const normalized = normalize(rel);
  if (rel.includes("\0") || normalized.split(sep).includes("..")) return send(res, 403, "配信できない場所です");
  const index = join(guiDir, "index.html");
  if (!existsSync(index)) {
    if (extname(normalized)) return send(res, 404, "ありません");
    return send(
      res,
      503,
      "GUI がビルドされていません。リポジトリで npm run build:gui を実行してください(agent-crew serve は起動時に自動でビルドします)",
    );
  }

  if (normalized && normalized !== ".") {
    const target = join(guiDir, normalized);
    if (existsSync(target) && statSync(target).isFile()) {
      const real = realpathSync(target);
      if (!real.startsWith(realpathSync(guiDir) + sep)) return send(res, 403, "配信できない場所です");
      return sendFile(res, real, normalized.startsWith(`assets${sep}`));
    }
    if (extname(normalized)) return send(res, 404, "ありません");
  }
  sendFile(res, index, false);
}

function sendFile(res: ServerResponse, path: string, immutable: boolean): void {
  const type = TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "x-content-type-options": "nosniff",
    // ビルドの assets はファイル名にハッシュが付くので長く持たせる。index.html は毎回取り直す
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    ...(type.startsWith("text/html") ? { "content-security-policy": CSP, "referrer-policy": "no-referrer" } : {}),
  });
  res.end(readFileSync(path));
}
