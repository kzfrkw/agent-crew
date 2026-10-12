import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultDenyRead, startSandboxedApp, type SandboxedApp } from "../browser/app.ts";
import { captureScreens, type Shot, type Variant } from "../browser/chrome.ts";
import { addEvent, getRepoProfile, listRepos, listTaskRepos, type Task } from "../db/store.ts";
import type { Profile } from "../roles/schemas.ts";
import type { AppContext, CaptureFn } from "./context.ts";
import { platformOf, protectedPathsFor, resolveServiceEnv } from "./projects.ts";
import { captureFlutterScreens, captureIosScreens } from "../mobile/capture.ts";

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

type ScreenTarget = { role: string; url: string; platform: "web" } | { role: string; url: null; platform: "flutter" | "ios" };

/**
 * 撮る相手: 画面を持つリポジトリ(確認 URL のあるもの、または Flutter のアプリ)のうち、計画の順で最後のもの(API → 画面なら画面)。
 * 無ければ登録の順で画面を持つもの
 */
export function pickScreenTarget(ctx: AppContext, task: Task): ScreenTarget | undefined {
  const repos = listRepos(ctx.db, task.projectId);
  const withScreen = repos.flatMap((r): ScreenTarget[] => {
    const p = getRepoProfile(ctx.db, r.id) as Profile | null;
    const platform = platformOf(p);
    if (platform !== "web") return [{ role: r.role, url: null, platform }];
    return p?.startUrl ? [{ role: r.role, url: p.startUrl, platform: "web" }] : [];
  });
  const planned = (task.repos ?? []).map((role) => withScreen.find((x) => x.role === role)).filter((x): x is ScreenTarget => !!x);
  return planned.at(-1) ?? withScreen[0];
}

export const captureTaskScreens: CaptureFn = async (ctx, task, o) => {
  const target = pickScreenTarget(ctx, task);
  // Flutter とネイティブ iOS のアプリは iOS シミュレータで撮る(設計メモ v0.15 / v0.16)
  if (target && target.platform !== "web") {
    const repoId = listRepos(ctx.db, task.projectId).find((r) => r.role === target.role)!.id;
    const worktree = listTaskRepos(ctx.db, task.id).find((x) => x.repoId === repoId)?.worktreePath ?? o.worktree;
    const onNote = (message: string) => addEvent(ctx.db, { taskId: task.id, kind: "warning", payload: { message } });
    if (target.platform === "ios") {
      const profile = getRepoProfile(ctx.db, repoId) as Profile | null;
      const scheme = /-scheme\s+('([^']+)'|"([^"]+)"|(\S+))/.exec(profile?.commands.test ?? profile?.commands.build ?? "");
      if (!scheme) throw new Error("テストのコマンドからスキーム(-scheme)を読めません(agent-crew project set で直してください)");
      return captureIosScreens({
        home: ctx.home,
        taskId: task.id,
        worktree,
        outDir: o.outDir,
        scheme: scheme[2] ?? scheme[3] ?? scheme[4]!,
        screens: profile?.commands.screens ?? null,
        simctl: ctx.simctl,
        slots: ctx.config.concurrency,
        deviceType: ctx.config.simulatorDevice,
        onNote,
        denyRead: protectedPathsFor(ctx, { taskId: task.id }),
      });
    }
    return captureFlutterScreens({
      home: ctx.home,
      taskId: task.id,
      worktree,
      outDir: o.outDir,
      slots: ctx.config.concurrency,
      deviceType: ctx.config.simulatorDevice,
      onNote,
      denyRead: protectedPathsFor(ctx, { taskId: task.id }),
    });
  }
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
          denyRead: [...defaultDenyRead(homedir(), ctx.home), ...protectedPathsFor(ctx, { taskId: task.id })],
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
