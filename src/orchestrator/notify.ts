import { spawn } from "node:child_process";
import type { AppContext } from "./context.ts";

/**
 * 人の対応待ちの通知(設計メモ v0.17、7-3)。macOS の通知を出す。外部のサービスには送らない。
 * 文面(タスクのタイトルを含む)は AppleScript に埋め込まず、osascript の引数で渡す(注入を防ぐ)。`--` で、- で始まる文面もオプションと取り違えない
 */

export type Notifier = (title: string, message: string) => void;

export function osascriptArgs(title: string, message: string): string[] {
  return ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "--", title, message];
}

export const macNotifier: Notifier = (title, message) => {
  if (process.platform !== "darwin") return;
  try {
    const child = spawn("/usr/bin/osascript", osascriptArgs(title, message), { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // 通知は補助。出せなくても処理は続ける
  }
};

/** 通知を出す(config の notify が false、または環境変数 AGENT_CREW_NOTIFY=0 なら出さない)。テストでは ctx.notifier を差し替える */
export function notifyHuman(ctx: AppContext, message: string): void {
  if (!ctx.config.notify) return;
  // AGENT_CREW_NOTIFY=0 は実際の通知だけを止める(差し替えた通知はテストで確かめる)
  const notifier = ctx.notifier ?? (process.env.AGENT_CREW_NOTIFY === "0" ? undefined : macNotifier);
  notifier?.("agent-crew", message);
}
