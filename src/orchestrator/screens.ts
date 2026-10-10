import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultDenyRead, startSandboxedApp } from "../browser/app.ts";
import { captureScreens, type Shot, type Variant } from "../browser/chrome.ts";
import { getRepoProfile, listTaskRepos } from "../db/store.ts";
import type { Profile } from "../roles/schemas.ts";
import type { CaptureFn } from "./context.ts";

/**
 * 実装後のデザインレビューのための撮影(設計メモ v0.13、4c)。
 * プロファイルの起動コマンドで worktree のアプリを、ツールの sandbox-exec の中で起動し、
 * サンドボックスの外の Chrome で撮る。撮影の後は必ずアプリを止める。
 */

/** 広い画面と狭い画面の、それぞれライト・ダーク(390px のダークはデザインレビュー担当の指摘で追加) */
export const DEFAULT_VARIANTS: Variant[] = [
  { width: 1280, scheme: "light" },
  { width: 1280, scheme: "dark" },
  { width: 390, scheme: "light" },
  { width: 390, scheme: "dark" },
];

export const captureTaskScreens: CaptureFn = async (ctx, task, o) => {
  const tr = listTaskRepos(ctx.db, task.id).find((r) => r.worktreePath === o.worktree) ?? listTaskRepos(ctx.db, task.id)[0];
  const profile = tr ? (getRepoProfile(ctx.db, tr.repoId) as Profile | null) : null;
  const start = profile?.commands.start;
  const url = profile?.startUrl;
  if (!start || !url) throw new Error("プロファイルに起動コマンドと確認 URL がありません(agent-crew project set で設定してください)");

  const tmp = join(ctx.home, "tmp", `screens-${task.id}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  // 前の回の画像は残さない(今回の実装の画面だけを見せる)
  rmSync(o.outDir, { recursive: true, force: true });
  mkdirSync(o.outDir, { recursive: true });
  const app = await startSandboxedApp({
    cwd: o.worktree,
    command: start,
    url,
    writable: [o.worktree],
    tmpDir: join(tmp, "app"),
    denyRead: defaultDenyRead(homedir(), ctx.home),
  });
  try {
    const shots: Shot[] = await captureScreens({
      baseUrl: new URL(url).origin,
      outDir: o.outDir,
      screens: o.screens.map((s, i) => ({ path: s.path, name: `s${i + 1}` })),
      variants: DEFAULT_VARIANTS,
      tmpDir: join(tmp, "chrome"),
      chromePath: ctx.config.chromePath,
    });
    return shots;
  } finally {
    await app.stop();
    rmSync(tmp, { recursive: true, force: true });
  }
};
