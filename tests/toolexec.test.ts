import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSandboxedCommand, toolchainRules, toolchainWritable } from "../src/toolexec/command.ts";
import { buildAppSandboxProfile } from "../src/browser/app.ts";
import { inAgentSandbox } from "./helpers/env.ts";
import { tempDir } from "./helpers/gitrepo.ts";

const mac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") && !inAgentSandbox;

describe("ツールが使う道具の書き込み先(フェーズ6)", () => {
  it("web は何も足さない。flutter は SDK のキャッシュと、ホームの Dart / Flutter のキャッシュ", () => {
    expect(toolchainWritable("web", { home: "/Users/me", flutterRoot: "/sdk/flutter" })).toEqual([]);
    expect(toolchainWritable("flutter", { home: "/Users/me", flutterRoot: "/sdk/flutter" })).toEqual([
      "/sdk/flutter/bin/cache",
      "/Users/me/.pub-cache",
      "/Users/me/.dartServer",
      "/Users/me/.dart-tool",
      "/Users/me/.flutter",
      "/Users/me/.flutter-devtools",
    ]);
    expect(toolchainWritable("flutter", { home: "/Users/me", flutterRoot: null })).toEqual(["/Users/me/.pub-cache", "/Users/me/.dartServer", "/Users/me/.dart-tool", "/Users/me/.flutter", "/Users/me/.flutter-devtools"]);
  });
});

describe("ネイティブ iOS の許可(6b)", () => {
  it("ios はユーザーの一時ディレクトリに書け、testmanagerd のソケットと /dev/ptmx を許す。ほかの種類には足さない", () => {
    expect(toolchainWritable("ios", { home: "/Users/me", flutterRoot: "/sdk", userTmp: "/var/folders/x/T/" })).toEqual(["/var/folders/x/T/"]);
    expect(toolchainRules("ios").join("\n")).toContain("testmanagerd");
    expect(toolchainRules("ios").join("\n")).toContain('(literal "/dev/ptmx")');
    expect(toolchainRules("web")).toEqual([]);
    expect(toolchainRules("flutter")).toEqual([]);
    const profile = buildAppSandboxProfile({ writable: ["/w"], denyRead: [], extraRules: toolchainRules("ios") });
    expect(profile.trimEnd().endsWith(toolchainRules("ios").at(-1)!)).toBe(true); // 後ろの規則が優先されるので最後に置く
  });
});

describe.skipIf(!mac)("ツールによるコマンドの実行(sandbox-exec、フェーズ6)", () => {
  it("終了コードと出力を返す。書き込みは指定の場所だけ", async () => {
    const wt = tempDir("agent-crew-toolexec-wt-");
    const outside = tempDir("agent-crew-toolexec-out-");
    const tmp = tempDir("agent-crew-toolexec-tmp-");
    const r = await runSandboxedCommand({
      cwd: wt,
      command: `echo hello; touch inside.txt; touch '${join(outside, "x.txt")}' 2>/dev/null || echo denied; exit 3`,
      writable: [wt],
      tmpDir: tmp,
    });
    expect(r).toMatchObject({ exitCode: 3, timedOut: false });
    expect(r.output).toContain("hello");
    expect(r.output).toContain("denied");
    expect(existsSync(join(wt, "inside.txt"))).toBe(true);
    expect(existsSync(join(outside, "x.txt"))).toBe(false);
  });

  it("上限の時間を過ぎたら、プロセスごと止めて timedOut", async () => {
    const wt = tempDir("agent-crew-toolexec-wt-");
    const started = Date.now();
    const r = await runSandboxedCommand({ cwd: wt, command: "sleep 30", writable: [wt], tmpDir: tempDir("agent-crew-toolexec-tmp-"), timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("外への通信はできない(localhost だけ)", async () => {
    const wt = tempDir("agent-crew-toolexec-wt-");
    const r = await runSandboxedCommand({ cwd: wt, command: "curl -s -m 5 -o /dev/null https://example.com && echo reached || echo blocked", writable: [wt], tmpDir: tempDir("agent-crew-toolexec-tmp-") });
    expect(r.output).toContain("blocked");
  });
});
