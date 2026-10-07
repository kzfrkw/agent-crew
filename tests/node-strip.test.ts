import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// vitest は独自にTypeScriptを変換するため、Nodeの型除去で動かない構文(enum など)を見逃す。
// 実行時と同じく Node で src/ の全ファイルを読み込めることを確かめる。
const srcDir = new URL("../src/", import.meta.url).pathname;
const files = (readdirSync(srcDir, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));

describe("Node の型除去で src/ を読み込める", () => {
  it("全ファイル", () => {
    const script = files.map((f) => `await import(${JSON.stringify(join(srcDir, f))});`).join("\n");
    expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" })).not.toThrow();
    expect(files.length).toBeGreaterThan(0);
  });
});
