import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultDenyRead, startSandboxedApp, type SandboxedApp } from "../browser/app.ts";
import { captureScreens, type Shot, type Variant } from "../browser/chrome.ts";
import { getRepoProfile, listRepos, listTaskRepos, type Task } from "../db/store.ts";
import type { Profile } from "../roles/schemas.ts";
import type { AppContext, CaptureFn } from "./context.ts";
import { resolveServiceEnv } from "./projects.ts";

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

type Service = { role: string; cwd: string; command: string; url: string | null; env: Record<string, string>; inTask: boolean };

/** 起動するリポジトリ(登録の順)。変更したものは worktree から、それ以外は本体から。起動コマンドの無いものは起動しない */
function servicesFor(ctx: AppContext, task: Task): Service[] {
  const trs = listTaskRepos(ctx.db, task.id);
  const repos = listRepos(ctx.db, task.projectId);
  return repos.flatMap((r) => {
    const p = getRepoProfile(ctx.db, r.id) as Profile | null;
    if (!p?.commands.start) return [];
    const tr = trs.find((x) => x.repoId === r.id);
    // 1リポジトリのプロジェクトでは、変更していないものは無い。複数リポジトリでは本体からも起動する
    if (!tr && repos.length === 1) return [];
    return [{ role: r.role, cwd: tr?.worktreePath ?? r.path, command: p.commands.start, url: p.startUrl, env: resolveServiceEnv(ctx.db, task.projectId, r.role), inTask: !!tr }];
  });
}

/** 撮る相手: 確認 URL のあるリポジトリのうち、計画の順で最後のもの(API → 画面なら画面)。無ければ登録の順で確認 URL のあるもの */
export function pickScreenTarget(ctx: AppContext, task: Task): { role: string; url: string } | undefined {
  const repos = listRepos(ctx.db, task.projectId);
  const withUrl = repos.flatMap((r) => {
    const url = (getRepoProfile(ctx.db, r.id) as Profile | null)?.startUrl;
    return url ? [{ role: r.role, url }] : [];
  });
  const planned = (task.repos ?? []).map((role) => withUrl.find((x) => x.role === role)).filter((x): x is { role: string; url: string } => !!x);
  return planned.at(-1) ?? withUrl[0];
}

export const captureTaskScreens: CaptureFn = async (ctx, task, o) => {
  const target = pickScreenTarget(ctx, task);
  const services = servicesFor(ctx, task);
  if (!target || services.length === 0) throw new Error("プロファイルに起動コマンドと確認 URL がありません(agent-crew project set で設定してください)");

  const tmp = join(ctx.home, "tmp", `screens-${task.id}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  // 前の回の画像は残さない(今回の実装の画面だけを見せる)
  rmSync(o.outDir, { recursive: true, force: true });
  mkdirSync(o.outDir, { recursive: true });
  // 書き込みは、このタスクの worktree だけ(本体から起動するリポジトリには書かせない)
  const writable = listTaskRepos(ctx.db, task.id).map((x) => x.worktreePath);
  const apps: SandboxedApp[] = [];
  try {
    for (const s of services) {
      apps.push(
        await startSandboxedApp({
          cwd: s.cwd,
          command: s.command,
          url: s.url ?? "",
          waitForUrl: !!s.url,
          env: s.env,
          writable,
          tmpDir: join(tmp, `app-${s.role}`),
          denyRead: defaultDenyRead(homedir(), ctx.home),
        }),
      );
    }
    return await captureScreens({
      baseUrl: new URL(target.url).origin,
      outDir: o.outDir,
      screens: o.screens.map((s, i) => ({ path: s.path, name: `s${i + 1}` })),
      variants: DEFAULT_VARIANTS,
      tmpDir: join(tmp, "chrome"),
      chromePath: ctx.config.chromePath,
    });
  } finally {
    for (const app of apps.reverse()) await app.stop();
    rmSync(tmp, { recursive: true, force: true });
  }
};
