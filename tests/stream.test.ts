import { request, type IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { appDbPath } from "../src/app.ts";
import { openDb } from "../src/db/connection.ts";
import { addEvent, createProject, createTask, startRun, updateTaskState } from "../src/db/store.ts";
import { startServer, type RunningServer } from "../src/server/server.ts";
import { tempDir } from "./helpers/gitrepo.ts";

let server: RunningServer | undefined;
const open: IncomingMessage[] = [];
afterEach(async () => {
  for (const r of open.splice(0)) r.destroy();
  await server?.close();
  server = undefined;
});

type Sse = { event: string; id?: string; data: string };

/** SSE に接続し、受け取ったメッセージをためる */
function connect(url: string, headers: Record<string, string> = {}): Promise<{ status: number; type?: string; messages: Sse[]; waitFor: (pred: (m: Sse) => boolean) => Promise<Sse> }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      open.push(res);
      const messages: Sse[] = [];
      const waiters: { pred: (m: Sse) => boolean; resolve: (m: Sse) => void }[] = [];
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const m: Sse = { event: "message", data: "" };
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) m.event = line.slice(7);
            else if (line.startsWith("id: ")) m.id = line.slice(4);
            else if (line.startsWith("data: ")) m.data += line.slice(6);
          }
          if (block.startsWith(":")) continue;
          messages.push(m);
          for (const w of [...waiters]) if (w.pred(m)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(m));
        }
      });
      resolve({
        status: res.statusCode!,
        type: res.headers["content-type"],
        messages,
        waitFor: (pred) =>
          new Promise((r, j) => {
            const found = messages.find(pred);
            if (found) return r(found);
            waiters.push({ pred, resolve: r });
            setTimeout(() => j(new Error(`待ちきれませんでした: ${JSON.stringify(messages)}`)), 3000);
          }),
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function seed() {
  const home = tempDir("agent-crew-home-");
  const db = openDb(appDbPath(home));
  const p = createProject(db, { name: "shop" });
  const t = createTask(db, { projectId: p.id, title: "t", body: "" });
  addEvent(db, { taskId: t.id, kind: "state_changed", payload: { from: "queued", to: "planning" } });
  return { home, db, t };
}

describe("SSE /api/stream", () => {
  it("接続すると hello で現在の最後のイベント id を返す", async () => {
    const { home, db } = seed();
    server = await startServer({ home, port: 0, pollMs: 30 });
    const s = await connect(`${server.url}api/stream`);
    expect(s.status).toBe(200);
    expect(s.type).toContain("text/event-stream");
    const hello = await s.waitFor((m) => m.event === "hello");
    expect(JSON.parse(hello.data)).toEqual({ lastEventId: 1 });
    db.close();
  });

  it("新しいイベントと、タスク・実行の変化を送る", async () => {
    const { home, db, t } = seed();
    server = await startServer({ home, port: 0, pollMs: 30 });
    const s = await connect(`${server.url}api/stream`);
    await s.waitFor((m) => m.event === "hello");

    addEvent(db, { taskId: t.id, kind: "assistant_text", payload: { text: "こんにちは" } });
    const ev = await s.waitFor((m) => m.event === "events");
    expect(ev.id).toBe("2");
    expect(JSON.parse(ev.data)).toEqual([expect.objectContaining({ id: 2, kind: "assistant_text", payload: { text: "こんにちは" } })]);

    updateTaskState(db, t.id, { state: "implementing" });
    const ch = await s.waitFor((m) => m.event === "change" && JSON.parse(m.data).tasks);
    expect(JSON.parse(ch.data)).toMatchObject({ tasks: true });

    startRun(db, { taskId: t.id, role: "implementer" });
    await s.waitFor((m) => m.event === "change" && JSON.parse(m.data).runs);
    db.close();
  });

  it("Last-Event-ID があれば、その後のイベントを先に送る(再接続時の取りこぼし防止)", async () => {
    const { home, db, t } = seed();
    addEvent(db, { taskId: t.id, kind: "tool_use", payload: { name: "Bash" } });
    server = await startServer({ home, port: 0, pollMs: 30 });
    const s = await connect(`${server.url}api/stream`, { "last-event-id": "1" });
    const ev = await s.waitFor((m) => m.event === "events");
    expect(JSON.parse(ev.data).map((e: { id: number }) => e.id)).toEqual([2]);
    db.close();
  });

  it("DB がまだ無くても接続でき、作られたら通知する", async () => {
    const home = tempDir("agent-crew-empty-");
    server = await startServer({ home, port: 0, pollMs: 30 });
    const s = await connect(`${server.url}api/stream`);
    expect(JSON.parse((await s.waitFor((m) => m.event === "hello")).data)).toEqual({ lastEventId: 0 });
    const db = openDb(appDbPath(home));
    createProject(db, { name: "x" });
    const p = createTask(db, { projectId: 1, title: "t", body: "" });
    addEvent(db, { taskId: p.id, kind: "x", payload: {} });
    await s.waitFor((m) => m.event === "events");
    db.close();
  });

  it("接続中でも close で終われる", async () => {
    const { home, db } = seed();
    server = await startServer({ home, port: 0, pollMs: 30 });
    await connect(`${server.url}api/stream`);
    await server.close();
    server = undefined;
    db.close();
  });
});
