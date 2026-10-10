import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * インストール済みの Google Chrome をヘッドレスで動かし、画面を撮る(設計メモ v0.13、4c)。
 * エージェントのサンドボックスの中では Chrome が動かないため(docs/safety.md 7章)、ツールがサンドボックスの外で動かす。
 * 安全のため: 毎回新しい一時プロファイル、127.0.0.1 / localhost 以外の名前解決を止める、撮影が終われば必ず終了する。
 * DevTools Protocol は Node 標準の WebSocket で扱う(依存を増やさない)。
 */

const CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

export function findChrome(configured?: string): string | undefined {
  if (configured) return existsSync(configured) ? configured : undefined;
  return CANDIDATES.find((p) => existsSync(p));
}

export type Variant = { width: number; scheme: "light" | "dark" };
export type Shot = { name: string; path: string; width: number; scheme: "light" | "dark"; file: string; error?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function captureScreens(o: {
  baseUrl: string;
  outDir: string;
  screens: { path: string; name: string }[];
  variants: Variant[];
  tmpDir: string;
  chromePath?: string;
  settleMs?: number;
}): Promise<Shot[]> {
  const chrome = findChrome(o.chromePath);
  if (!chrome) throw new Error("Google Chrome が見つかりません(config.json の chromePath で指定できます)");
  mkdirSync(o.outDir, { recursive: true });
  const profile = join(o.tmpDir, "chrome-profile");
  mkdirSync(profile, { recursive: true });

  const proc = spawn(
    chrome,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      // 127.0.0.1 / localhost 以外には繋がない(外部の資源を読まない)
      "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 127.0.0.1",
      // macOS のキーチェーンを使わない(新しいプロファイルで起動すると許可のダイアログを待って止まることがある)
      "--use-mock-keychain",
      "--password-store=basic",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--disable-background-networking",
      "--hide-scrollbars",
      "--mute-audio",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  try {
    // DevToolsActivePort の1行目が待ち受けのポート
    const portFile = join(profile, "DevToolsActivePort");
    let port = 0;
    for (let i = 0; i < 100 && !port; i++) {
      await sleep(100);
      if (existsSync(portFile)) port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
    }
    if (!port) throw new Error("Chrome の DevTools に接続できませんでした");
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("Chrome のページが見つかりません");
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    try {
      await cdp.send("Page.enable");
      const shots: Shot[] = [];
      for (const s of o.screens) {
        for (const v of o.variants) {
          const file = `${s.name}-${v.width}-${v.scheme}.png`;
          const shot: Shot = { name: s.name, path: s.path, width: v.width, scheme: v.scheme, file };
          try {
            const mobile = v.width < 600;
            await cdp.send("Emulation.setDeviceMetricsOverride", { width: v.width, height: 900, deviceScaleFactor: mobile ? 2 : 1, mobile });
            await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: v.scheme }] });
            const loaded = cdp.once("Page.loadEventFired", 15_000);
            await cdp.send("Page.navigate", { url: new URL(s.path, o.baseUrl).href });
            await loaded;
            await sleep(o.settleMs ?? 1200); // データの取得と描画を待つ
            const m = (await cdp.send("Runtime.evaluate", { expression: "document.documentElement.scrollHeight", returnByValue: true })) as { result: { value: number } };
            const height = Math.min(Math.max(Number(m.result.value) || 900, 300), 4000);
            await cdp.send("Emulation.setDeviceMetricsOverride", { width: v.width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
            await sleep(200);
            const png = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data: string };
            writeFileSync(join(o.outDir, file), Buffer.from(png.data, "base64"));
          } catch (e) {
            shot.error = (e as Error).message;
          }
          shots.push(shot);
        }
      }
      return shots;
    } finally {
      cdp.close();
    }
  } finally {
    proc.kill("SIGTERM");
    await sleep(300);
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }
}

type Cdp = {
  send: (method: string, params?: object) => Promise<unknown>;
  once: (event: string, timeoutMs: number) => Promise<unknown>;
  close: () => void;
};

/** DevTools Protocol に接続する。接続を受け付けたまま応答しない相手(画面の無いときの Chrome など)で止まらないよう、上限を設ける */
export async function connectCdp(url: string, timeoutMs = 10_000): Promise<Cdp> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      ws.close();
      reject(new Error("DevTools に接続できませんでした(応答がありません)"));
    }, timeoutMs);
    ws.addEventListener("open", () => (clearTimeout(t), resolve()), { once: true });
    ws.addEventListener("error", () => (clearTimeout(t), reject(new Error("DevTools に接続できませんでした"))), { once: true });
  });
  let id = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const waiters = new Map<string, ((v: unknown) => void)[]>();
  ws.addEventListener("message", (m) => {
    const d = JSON.parse(String(m.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown };
    if (d.id !== undefined && pending.has(d.id)) {
      const p = pending.get(d.id)!;
      pending.delete(d.id);
      if (d.error) p.reject(new Error(d.error.message));
      else p.resolve(d.result);
    } else if (d.method && waiters.has(d.method)) {
      for (const w of waiters.get(d.method)!.splice(0)) w(d.params);
    }
  });
  return {
    // 命令が返ってこないときに止まったままにならないよう、上限を設ける
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const i = ++id;
        const t = setTimeout(() => {
          pending.delete(i);
          reject(new Error(`${method} が応答しませんでした`));
        }, 20_000);
        pending.set(i, {
          resolve: (v) => (clearTimeout(t), resolve(v)),
          reject: (e) => (clearTimeout(t), reject(e)),
        });
        ws.send(JSON.stringify({ id: i, method, params }));
      }),
    once: (event, timeoutMs) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${event} を待ちきれませんでした`)), timeoutMs);
        const list = waiters.get(event) ?? [];
        list.push((v) => {
          clearTimeout(t);
          resolve(v);
        });
        waiters.set(event, list);
      }),
    close: () => ws.close(),
  };
}
