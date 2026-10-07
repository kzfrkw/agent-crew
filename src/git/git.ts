import { execFileSync } from "node:child_process";

/** git を実行して標準出力(末尾の改行を除く)を返す。失敗時は標準エラーを含めて例外にする */
export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  try {
    return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).replace(/\n$/, "");
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`git ${args.join(" ")} が失敗しました(${cwd}): ${err.stderr?.trim() || err.message}`);
  }
}
