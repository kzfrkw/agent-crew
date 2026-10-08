import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

/** 配信してよいのは成果物の置き場所だけ(DB・設定・worktree は配信しない) */
const SERVABLE_DIRS = ["tasks", "projects", "runs"];

export const TYPES: Record<string, string> = {
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".patch": "text/plain; charset=utf-8",
  ".diff": "text/plain; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
};

export function send(res: ServerResponse, status: number, text: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "content-type": type, "x-content-type-options": "nosniff" });
  res.end(text);
}

/** データディレクトリ内のファイルを /files/ の URL にする。配信できない場所や、無いファイルなら null */
export function fileUrl(home: string, path: string): string | null {
  if (!path.startsWith(home + sep) || !existsSync(path)) return null;
  const rel = path.slice(home.length + 1);
  if (!SERVABLE_DIRS.includes(rel.split(sep)[0]!)) return null;
  return `/files/${rel.split(sep).map(encodeURIComponent).join("/")}`;
}

/** /files/<相対パス> を配信する。データディレクトリの成果物の置き場所の外には出さない */
export function serveFile(home: string, rawPath: string, res: ServerResponse): void {
  let rel: string;
  try {
    rel = decodeURIComponent(rawPath);
  } catch {
    return send(res, 400, "不正なパスです");
  }
  const normalized = normalize(rel);
  if (rel.includes("\0") || normalized.startsWith("..") || normalized.split(sep).includes("..") || !SERVABLE_DIRS.includes(normalized.split(sep)[0]!)) {
    return send(res, 403, "配信できない場所です");
  }
  const target = join(home, normalized);
  if (!existsSync(target) || !statSync(target).isFile()) return send(res, 404, "ありません");
  const real = realpathSync(target);
  const allowed = SERVABLE_DIRS.map((d) => join(realpathSync(home), d) + sep);
  if (!allowed.some((dir) => real.startsWith(dir))) return send(res, 403, "配信できない場所です");
  res.writeHead(200, { "content-type": TYPES[extname(real).toLowerCase()] ?? "application/octet-stream", "x-content-type-options": "nosniff" });
  res.end(readFileSync(real));
}
