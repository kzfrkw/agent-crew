import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { sep } from "node:path";
import type { Db } from "../db/connection.ts";
import { handleApi, HttpError, openReadOnly } from "./api.ts";
import { send, serveFile } from "./files.ts";
import { StreamHub } from "./stream.ts";
import { getTask, listArtifacts, listEvents, listProjects, listRepos, listTaskRepos, listTasks } from "../db/store.ts";
import { latestNeedsInputReason, runActive } from "../orchestrator/engine.ts";
import { NEEDS_HUMAN, STATE_LABELS } from "../orchestrator/states.ts";

/**
 * 簡易な見える化ページ(フェーズ1、設計メモ13章)。読み取り専用で、127.0.0.1 だけで待ち受ける。
 * 操作は CLI のまま。UIの作り込みはフェーズ2で行う。
 */

const HOST = "127.0.0.1";

export type RunningServer = { url: string; address: string; port: number; close: () => Promise<void> };

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string, refresh = true): string {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? '<meta http-equiv="refresh" content="5">' : ""}
<title>${esc(title)}</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--card:#fff;--attn:#b45309;--attn-bg:#fef3c7;--human:#1d4ed8;--human-bg:#dbeafe;--run:#047857}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--line:#44403c;--card:#292524;--attn:#fbbf24;--attn-bg:#451a03;--human:#93c5fd;--human-bg:#1e3a8a;--run:#34d399}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif}
main{max-width:1040px;margin:0 auto;padding:16px}
h1{font-size:18px;margin:8px 0 16px}h2{font-size:15px;margin:24px 0 8px}
a{color:inherit}.muted{color:var(--muted)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line)}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:12px}
.badge{display:inline-block;padding:0 8px;border-radius:10px;font-size:12px;white-space:nowrap}
.attention{background:var(--attn-bg);color:var(--attn);font-weight:600}
.human{background:var(--human-bg);color:var(--human);font-weight:600}
.running{color:var(--run)}
.box{background:var(--card);border:1px solid var(--line);padding:8px 12px;margin:8px 0}
code,pre{font-family:ui-monospace,Menlo,monospace;font-size:12px}pre{white-space:pre-wrap;word-break:break-all;margin:0}
.scroll{overflow-x:auto}
</style></head><body><main>${body}
<p class="muted">読み取り専用・5秒ごとに更新・操作は CLI(agent-crew)で行います</p></main></body></html>`;
}

function stateBadge(state: keyof typeof STATE_LABELS): string {
  const cls = NEEDS_HUMAN.includes(state) ? "attention" : state === "human_working" ? "human" : "";
  return `<span class="badge ${cls}">${esc(STATE_LABELS[state])}</span>`;
}

function runningRole(db: Db, taskId: number): string | undefined {
  const r = db.prepare("SELECT role, model FROM runs WHERE task_id = ? AND state = 'running' ORDER BY id DESC LIMIT 1").get(taskId) as
    | { role: string; model: string | null }
    | undefined;
  return r ? `${r.role}${r.model ? `(${r.model})` : ""}` : undefined;
}

function indexPage(home: string): string {
  const db = openReadOnly(home);
  if (!db) return page("agent-crew", "<h1>agent-crew</h1><p>まだデータがありません(agent-crew project add で登録します)</p>");
  try {
    const sections = listProjects(db).map((p) => {
      const rows = listTasks(db, { projectId: p.id })
        .filter((t) => t.state !== "cancelled")
        .sort((a, b) => Number(NEEDS_HUMAN.includes(b.state)) - Number(NEEDS_HUMAN.includes(a.state)) || b.id - a.id)
        .map((t) => {
          const running = runningRole(db, t.id);
          return `<tr><td><a href="/tasks/${t.id}">#${t.id}</a></td><td>${stateBadge(t.state)}</td><td><a href="/tasks/${t.id}">${esc(t.title)}</a>${t.kind === "test_infra" ? ' <span class="muted">(テスト基盤整備)</span>' : ""}</td><td>${running ? `<span class="running">● ${esc(running)}</span>` : '<span class="muted">-</span>'}</td><td>${t.reviewRounds}</td><td class="muted">${esc(t.updatedAt.slice(0, 16).replace("T", " "))}</td></tr>`;
        })
        .join("");
      return `<h2>${esc(p.name)} <span class="muted">プロファイル: ${esc(p.profileStatus)} / テスト基盤: ${esc(p.testInfra)}</span></h2>
<div class="scroll"><table><tr><th>ID</th><th>状態</th><th>タイトル</th><th>実行中</th><th>差し戻し</th><th>更新</th></tr>${rows || '<tr><td colspan="6" class="muted">タスクはありません</td></tr>'}</table></div>`;
    });
    return page("agent-crew", `<h1>agent-crew タスク一覧</h1>${sections.join("") || "<p>プロジェクトがありません</p>"}`);
  } finally {
    db.close();
  }
}

function taskPage(home: string, id: number): string | undefined {
  const db = openReadOnly(home);
  if (!db) return undefined;
  try {
    const t = getTask(db, id);
    if (!t) return undefined;
    const fileLink = (path: string) => {
      const rel = path.startsWith(home + sep) ? path.slice(home.length + 1) : undefined;
      return rel ? `<a href="/files/${rel.split(sep).map(encodeURIComponent).join("/")}">${esc(rel)}</a>` : esc(path);
    };
    const roles = new Map(listRepos(db, t.projectId).map((r) => [r.id, r.role]));
    const artifacts = [...new Map(listArtifacts(db, t.id).map((a) => [a.kind, a])).values()];
    const runs = db.prepare("SELECT id, role, model, state, verdict, cost_usd, started_at FROM runs WHERE task_id = ? ORDER BY id").all(t.id) as {
      id: number; role: string; model: string | null; state: string; verdict: string | null; cost_usd: number | null; started_at: string;
    }[];
    const events = listEvents(db, t.id, 50).reverse();
    const body = `<p><a href="/">← 一覧</a></p>
<h1>#${t.id} ${esc(t.title)}</h1>
<p>${stateBadge(t.state)} ${t.heldFromState ? `<span class="muted">← ${esc(STATE_LABELS[t.heldFromState])}から</span>` : ""} <span class="muted">差し戻し ${t.reviewRounds} 回</span></p>
${runActive(db, t.id) ? `<div class="box attention">エージェントが実行中です(${esc(runningRole(db, t.id))})。worktree を触らないでください</div>` : ""}
${t.state === "needs_input" ? `<div class="box attention">人の回答待ち: ${esc(latestNeedsInputReason(db, t.id) ?? "")}<br><code>agent-crew task answer ${t.id} --message "..."</code></div>` : ""}
${t.state === "human_working" ? `<div class="box human">人が作業中です。終わったら <code>agent-crew task return ${t.id}</code></div>` : ""}
<h2>チケット本文</h2><div class="box"><pre>${esc(t.body || "(本文なし)")}</pre></div>
<h2>worktree</h2>${listTaskRepos(db, t.id).map((tr) => `<div class="box">[${esc(roles.get(tr.repoId))}] <code>${esc(tr.worktreePath)}</code> <span class="muted">${esc(tr.branchName)}</span></div>`).join("") || '<p class="muted">まだありません</p>'}
<h2>成果物</h2>${artifacts.map((a) => `<div class="box">${esc(a.kind)}: ${fileLink(a.path)} <span class="muted">${esc(a.verdict ?? "")}</span></div>`).join("") || '<p class="muted">まだありません</p>'}
<h2>実行</h2><div class="scroll"><table><tr><th>#</th><th>役割</th><th>モデル</th><th>状態</th><th>判定</th><th>費用</th><th>開始</th></tr>${runs.map((r) => `<tr><td>${r.id}</td><td>${esc(r.role)}</td><td>${esc(r.model)}</td><td>${esc(r.state)}</td><td>${esc(r.verdict)}</td><td>${r.cost_usd == null ? "-" : `$${r.cost_usd.toFixed(3)}`}</td><td class="muted">${esc(r.started_at.slice(11, 19))}</td></tr>`).join("")}</table></div>
<h2>直近のイベント</h2><div class="scroll"><table><tr><th>時刻</th><th>種類</th><th>内容</th></tr>${events.map((e) => `<tr><td class="muted">${esc(e.createdAt.slice(11, 19))}</td><td>${esc(e.kind)}</td><td><pre>${esc(JSON.stringify(e.payload).slice(0, 400))}</pre></td></tr>`).join("")}</table></div>`;
    return page(`#${t.id} ${t.title}`, body);
  } finally {
    db.close();
  }
}

/** DNS リバインディング対策: 127.0.0.1 / localhost 宛ての要求だけを受け付ける */
function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `${HOST}:${port}` || host === `localhost:${port}`;
}

function handle(home: string, hub: StreamHub, req: IncomingMessage, res: ServerResponse): void {
  const port = (req.socket.localPort ?? 0);
  if (!hostAllowed(req.headers.host, port)) return send(res, 403, "127.0.0.1 または localhost で開いてください");
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("allow", "GET, HEAD");
    return send(res, 405, "読み取り専用です(操作は CLI で行います)");
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  try {
    if (path === "/api/stream") return hub.add(req, res);
    if (path.startsWith("/api/")) {
      try {
        return send(res, 200, JSON.stringify(handleApi(home, path.slice("/api/".length), url.searchParams)), "application/json; charset=utf-8");
      } catch (e) {
        if (e instanceof HttpError) return send(res, e.status, JSON.stringify({ error: e.message }), "application/json; charset=utf-8");
        throw e;
      }
    }
    if (path === "/") return send(res, 200, indexPage(home), "text/html; charset=utf-8");
    const task = /^\/tasks\/(\d+)$/.exec(path);
    if (task) {
      const html = taskPage(home, Number(task[1]));
      return html ? send(res, 200, html, "text/html; charset=utf-8") : send(res, 404, "タスクがありません");
    }
    if (path.startsWith("/files/")) return serveFile(home, path.slice("/files/".length), res);
    send(res, 404, "ありません");
  } catch (e) {
    send(res, 500, `エラー: ${(e as Error).message}`);
  }
}

/** pollMs は SSE が DB の変化を調べる間隔(既定1秒) */
export function startServer(o: { home: string; port: number; pollMs?: number }): Promise<RunningServer> {
  const hub = new StreamHub(o.home, o.pollMs ?? 1000);
  const server = createServer((req, res) => handle(o.home, hub, req, res));
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
