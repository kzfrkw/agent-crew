import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAppSandboxProfile, startSandboxedApp, type SandboxedApp } from "../src/browser/app.ts";
import { captureScreens, findChrome } from "../src/browser/chrome.ts";
import { tempDir } from "./helpers/gitrepo.ts";

const mac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

let app: SandboxedApp | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

describe("アプリのサンドボックスのプロファイル(4c)", () => {
  it("書き込みは指定の場所だけ、通信は 127.0.0.1 / localhost だけ、資格情報は読めない", () => {
    const p = buildAppSandboxProfile({ writable: ["/w/wt", "/w/tmp"], denyRead: ["/Users/me/.ssh"] });
    expect(p).toContain("(deny file-write*)");
    expect(p).toContain('(subpath "/w/wt")');
    expect(p).toContain('(subpath "/w/tmp")');
    expect(p).toContain("(deny network*)");
    expect(p).toContain('(allow network-outbound (remote ip "localhost:*"))');
    expect(p).not.toMatch(/allow network\*/);
    expect(p).toContain('(deny file-read* (subpath "/Users/me/.ssh"))');
  });

  it("パスに引用符などがあれば拒否する(プロファイルを壊さないように)", () => {
    expect(() => buildAppSandboxProfile({ writable: ['/w/"x'], denyRead: [] })).toThrow();
  });
});

describe.skipIf(!mac)("サンドボックスの中のアプリ(macOS)", () => {
  it("起動して URL に応答するまで待ち、止められる。書き込みは worktree の中だけ", async () => {
    const wt = tempDir("agent-crew-app-");
    const outside = join(homedir(), `agent-crew-sandbox-test-${Date.now()}.txt`);
    writeFileSync(
      join(wt, "server.mjs"),
      `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync("inside.txt", "ok");
let wrote = "no";
try { writeFileSync(${JSON.stringify(outside)}, "x"); wrote = "yes"; } catch {}
createServer((_, res) => res.end("<!doctype html><title>t</title><body style='background:#fef3c7'>outside=" + wrote + "</body>")).listen(Number(process.env.PORT), "127.0.0.1");
`,
    );
    app = await startSandboxedApp({ cwd: wt, command: "PORT=4391 node server.mjs", url: "http://127.0.0.1:4391/", writable: [wt], tmpDir: tempDir("agent-crew-apptmp-") });
    const body = await (await fetch("http://127.0.0.1:4391/")).text();
    expect(body).toContain("outside=no");
    expect(readFileSync(join(wt, "inside.txt"), "utf8")).toBe("ok");
    expect(existsSync(outside)).toBe(false);
    await app.stop();
    app = undefined;
    await expect(fetch("http://127.0.0.1:4391/")).rejects.toThrow();
  });

  it("外部への通信はサンドボックスが拒否する(EPERM。ネットワークの有無によらず)", async () => {
    const wt = tempDir("agent-crew-app-");
    writeFileSync(
      join(wt, "server.mjs"),
      `import { createServer, request } from "node:http";
let result = "pending";
const r = request({ host: "1.1.1.1", port: 80, path: "/" }, () => (result = "connected"));
r.on("error", (e) => (result = e.code));
r.end();
createServer((_, res) => res.end(result)).listen(4388, "127.0.0.1");
`,
    );
    app = await startSandboxedApp({ cwd: wt, command: "node server.mjs", url: "http://127.0.0.1:4388/", writable: [wt], tmpDir: tempDir("agent-crew-apptmp-") });
    await new Promise((r) => setTimeout(r, 500));
    expect(await (await fetch("http://127.0.0.1:4388/")).text()).toBe("EPERM");
  });

  it("起動しなければ、ログを添えて失敗する", async () => {
    const wt = tempDir("agent-crew-app-");
    await expect(
      startSandboxedApp({ cwd: wt, command: "echo 起動できません >&2; exit 3", url: "http://127.0.0.1:4390/", writable: [wt], tmpDir: tempDir("agent-crew-apptmp-"), timeoutMs: 3000 }),
    ).rejects.toThrow(/起動できません/);
  });
});

describe.skipIf(!mac || !findChrome())("Chrome での撮影(macOS、Chrome があるとき)", () => {
  it("幅と配色を指定して撮り、PNG を書く", async () => {
    const wt = tempDir("agent-crew-app-");
    writeFileSync(
      join(wt, "server.mjs"),
      `import { createServer } from "node:http";
createServer((_, res) => res.end("<!doctype html><meta name=viewport content='width=device-width'><style>body{background:#fff}@media (prefers-color-scheme: dark){body{background:#000}}</style><h1>撮影</h1>")).listen(4389, "127.0.0.1");
`,
    );
    app = await startSandboxedApp({ cwd: wt, command: "node server.mjs", url: "http://127.0.0.1:4389/", writable: [wt], tmpDir: tempDir("agent-crew-apptmp-") });
    const out = tempDir("agent-crew-shots-");
    const shots = await captureScreens({
      baseUrl: "http://127.0.0.1:4389",
      outDir: out,
      screens: [{ path: "/", name: "top" }],
      variants: [
        { width: 1280, scheme: "light" },
        { width: 390, scheme: "dark" },
      ],
      tmpDir: tempDir("agent-crew-chrometmp-"),
    });
    expect(shots.map((s) => s.file)).toEqual(["top-1280-light.png", "top-390-dark.png"]);
    for (const s of shots) expect(statSync(join(out, s.file)).size).toBeGreaterThan(1000);
    expect(shots.every((s) => s.error === undefined)).toBe(true);
  }, 60_000);
});
