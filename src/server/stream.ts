import type { IncomingMessage, ServerResponse } from "node:http";
import type { Db } from "../db/connection.ts";
import { lastEventId, queryEvents } from "../db/store.ts";
import type { ChangeNotice, EventView } from "./api-types.ts";
import { openReadOnly } from "./api.ts";

/**
 * SSE(/api/stream)。agent-crew run は別のプロセスで DB に書くため、
 * 接続があるあいだだけ DB を一定間隔で見て、変化を全接続に送る(設計メモ14章 v0.8)。
 *
 * - hello: 接続時。{ lastEventId }
 * - events: 新しいイベントの配列。id は最後のイベントの id(再接続時に Last-Event-ID で返ってくる)
 * - change: タスク・実行が変わった。GUI は該当する API を取り直す
 */

const HEARTBEAT_MS = 15_000;
const BATCH = 500;

type Marks = { tasks: string; runs: string };

export class StreamHub {
  private readonly home: string;
  private readonly pollMs: number;
  private readonly clients = new Set<ServerResponse>();
  private timer: NodeJS.Timeout | undefined;
  private lastBeat = Date.now();
  private db: Db | undefined;
  private lastId = 0;
  private marks: Marks = { tasks: "", runs: "" };

  constructor(home: string, pollMs: number) {
    this.home = home;
    this.pollMs = pollMs;
  }

  add(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-content-type-options": "nosniff",
    });
    if (this.clients.size === 0) this.start();
    this.tick();
    const since = Number(req.headers["last-event-id"]);
    if (Number.isInteger(since) && since >= 0 && since < this.lastId && this.db) {
      for (let after = since; after < this.lastId; ) {
        const list = queryEvents(this.db, { after, limit: BATCH }).filter((e) => e.id <= this.lastId);
        if (list.length === 0) break;
        after = list.at(-1)!.id;
        write(res, "events", list.map(view), after);
      }
    }
    write(res, "hello", { lastEventId: this.lastId });
    this.clients.add(res);
    req.on("close", () => {
      this.clients.delete(res);
      if (this.clients.size === 0) this.stop();
    });
  }

  close(): void {
    for (const res of this.clients) res.end();
    this.clients.clear();
    this.stop();
  }

  /** 基準をとる。DB がまだ無ければ空を基準にし、作られたら最初から送る */
  private start(): void {
    this.db = openReadOnly(this.home);
    this.lastId = this.db ? lastEventId(this.db) : 0;
    this.marks = this.db ? readMarks(this.db) : { tasks: "", runs: "" };
    this.lastBeat = Date.now();
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.timer.unref();
  }

  private stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.db?.close();
    this.db = undefined;
    this.marks = { tasks: "", runs: "" };
  }

  /** DB の変化を調べ、あれば全接続に送る */
  private tick(): void {
    try {
      this.db ??= openReadOnly(this.home);
      if (this.db) this.poll(this.db);
    } catch {
      // 書き込み中のロックなどは次の回で拾う
    }
    if (Date.now() - this.lastBeat >= HEARTBEAT_MS) {
      this.lastBeat = Date.now();
      for (const res of this.clients) res.write(": ping\n\n");
    }
  }

  private poll(db: Db): void {
    const marks = readMarks(db);
    const last = lastEventId(db);
    while (this.lastId < last) {
      const list = queryEvents(db, { after: this.lastId, limit: BATCH });
      if (list.length === 0) break;
      this.lastId = list.at(-1)!.id;
      this.broadcast("events", list.map(view), this.lastId);
    }
    const notice: ChangeNotice = { tasks: marks.tasks !== this.marks.tasks, runs: marks.runs !== this.marks.runs, lastEventId: this.lastId };
    this.marks = marks;
    if (notice.tasks || notice.runs) this.broadcast("change", notice);
  }

  private broadcast(event: string, data: unknown, id?: number): void {
    for (const res of this.clients) write(res, event, data, id);
  }
}

function readMarks(db: Db): Marks {
  const t = db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), '') AS u FROM tasks").get() as { n: number; u: string };
  const r = db
    .prepare("SELECT COUNT(*) AS n, COALESCE(MAX(ended_at), '') AS e, COALESCE(SUM(state = 'running'), 0) AS running FROM runs")
    .get() as { n: number; e: string; running: number };
  return { tasks: `${t.n}|${t.u}`, runs: `${r.n}|${r.e}|${r.running}` };
}

const view = (e: EventView): EventView => ({ id: e.id, taskId: e.taskId, runId: e.runId, kind: e.kind, payload: e.payload, createdAt: e.createdAt });

function write(res: ServerResponse, event: string, data: unknown, id?: number): void {
  res.write(`event: ${event}\n${id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`);
}
