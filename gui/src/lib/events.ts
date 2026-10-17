import type { EventView } from "../../../src/server/api-types.ts";
import { STATE_LABELS } from "../../../src/orchestrator/states.ts";
import { formatTime } from "./format.ts";

/** イベントを1行の表示にする(docs/skeleton.md S4)。副作用なし */

export type Tone = "neutral" | "say" | "tool" | "result" | "state" | "attention" | "danger" | "success" | "human";
export type EventLine = { tone: Tone; icon: string; title: string; text: string; detail?: string };

type P = Record<string, any>;

const label = (s: unknown) => STATE_LABELS[s as keyof typeof STATE_LABELS] ?? String(s ?? "");

const SEG = String.raw`[^\s/'"]+`;
const WORKTREE = new RegExp(String.raw`(?:/${SEG})*/worktrees/${SEG}/${SEG}/${SEG}(/|(?=[\s'"]|$))`, "g");
const DATA_DIR = new RegExp(String.raw`(?:/${SEG})*?/((?:tasks|projects|runs)/\d+/)`, "g");

/** 表示用に長い絶対パスを短くする(worktree の中は相対パス、データディレクトリの成果物は tasks/<id>/ から) */
export function shortenPaths(s: string): string {
  return s.replace(WORKTREE, (_m, slash: string) => (slash ? "" : ".")).replace(DATA_DIR, "$1");
}

/** 先頭の cd <場所> は省く(エージェントは毎回 worktree へ cd してから実行する) */
const stripCd = (cmd: string) => cmd.replace(/^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*(?:&&|;|\n)\s*/, "");

/** ツールの主な引数(1行で見せるもの) */
function toolArg(name: string, input: P | undefined): string {
  if (!input) return "";
  if (typeof input.command === "string") return shortenPaths(stripCd(input.command)).split("\n")[0]!;
  const v = input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description;
  if (typeof v === "string") return shortenPaths(v).split("\n")[0]!;
  return name === "TodoWrite" ? "TODO を更新" : JSON.stringify(input).slice(0, 200);
}

const stringify = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

export function describeEvent(e: EventView): EventLine {
  const p = (e.payload ?? {}) as P;
  switch (e.kind) {
    case "init":
      return { tone: "neutral", icon: "⚙", title: "開始", text: `model=${p.model ?? "?"}`, detail: Array.isArray(p.tools) ? `tools: ${p.tools.join(", ")}` : undefined };
    case "assistant_text":
      return { tone: "say", icon: "💬", title: "発言", text: String(p.text ?? "").split("\n")[0]!, detail: String(p.text ?? "") };
    case "tool_use":
      if (p.name === "StructuredOutput") {
        return { tone: "success", icon: "◎", title: "判定を返す", text: [p.input?.verdict, p.input?.summary].filter(Boolean).join(" — "), detail: stringify(p.input) };
      }
      return { tone: "tool", icon: "▸", title: String(p.name ?? "tool"), text: toolArg(String(p.name), p.input), detail: stringify(p.input) };
    case "tool_result":
      return {
        tone: p.isError ? "danger" : "result",
        icon: p.isError ? "✗" : "└",
        title: p.isError ? "結果(エラー)" : "結果",
        text: shortenPaths(String(p.content ?? "").split("\n")[0]!).slice(0, 200),
        detail: String(p.content ?? ""),
      };
    case "result":
      return {
        tone: p.isError ? "danger" : "success",
        icon: p.isError ? "✗" : "✓",
        title: "終了",
        text: [p.subtype, p.numTurns !== undefined ? `${p.numTurns}ターン` : "", p.costUsd !== undefined ? `$${Number(p.costUsd).toFixed(3)}` : ""].filter(Boolean).join(" / "),
      };
    case "state_changed":
      return { tone: "state", icon: "→", title: "状態", text: `${label(p.from)} → ${label(p.to)}`, detail: p.reason };
    case "needs_input":
      return { tone: "attention", icon: "◆", title: "人の回答待ち", text: String(p.reason ?? "") };
    case "failed":
      return { tone: "danger", icon: "✗", title: "失敗", text: String(p.reason ?? "") };
    case "run_failed":
      return { tone: "danger", icon: "✗", title: `${p.role ?? "実行"}が失敗`, text: String(p.reason ?? "") };
    case "warning":
      return { tone: "attention", icon: "!", title: "警告", text: String(p.message ?? "") };
    case "rate_limit": {
      const resets = typeof p.resetsAt === "number" ? `リセット ${formatTime(new Date(p.resetsAt * 1000).toISOString())}` : "";
      const ok = p.status === "allowed";
      return {
        tone: ok ? "neutral" : "attention",
        icon: "⏱",
        title: ok ? "利用枠" : "利用枠の制限",
        text: [p.status, p.rateLimitType, resets].filter(Boolean).join(" / "),
        detail: stringify(p),
      };
    }
    case "human_takeover":
      return { tone: "human", icon: "✋", title: "人が引き取り", text: "worktree で手作業中" };
    case "human_returned":
      return { tone: "human", icon: "↩", title: "エージェントに戻した", text: Array.isArray(p.commits) ? `人のコミット ${p.commits.length} 件` : "" };
    case "implemented":
      return {
        tone: "success",
        icon: "●",
        title: "実装のコミット",
        text: Array.isArray(p.commits) ? p.commits.map((c: P) => c.subject).join(" / ") : "",
      };
    case "review_findings": {
      const findings: P[] = Array.isArray(p.findings) ? p.findings : [];
      const count = (sev: string) => findings.filter((f) => f.severity === sev).length;
      return {
        tone: count("must") > 0 ? "attention" : "neutral",
        icon: "🔎",
        title: "レビューの指摘",
        text: `must ${count("must")} / should ${count("should")} / nit ${count("nit")}`,
        detail: findings.map((f) => `[${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""} — ${f.title}`).join("\n") || undefined,
      };
    }
    case "audit": {
      const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
      return { tone: "neutral", icon: "⚖", title: "Must 指摘の監査", text: `維持 ${n(p.standing)} / 却下 ${n(p.dismissed)}`, detail: stringify(p.judgments ?? []) };
    }
    case "decisions": {
      const list: string[] = Array.isArray(p.decisions) ? p.decisions.map(String) : [];
      return {
        tone: "neutral",
        icon: "📌",
        title: `設計判断(${p.role === "designer" ? "デザイナー" : "設計者"})`,
        text: list.length > 1 ? `${list[0]} ほか${list.length - 1}件` : (list[0] ?? ""),
        detail: list.map((x) => `- ${x}`).join("\n"),
      };
    }
    case "cleanup": {
      const list: P[] = Array.isArray(p.processes) ? p.processes : [];
      return {
        tone: "attention",
        icon: "🧹",
        title: `後片付け(${p.role ?? "役割"})`,
        text: `残っていたプロセスを ${list.length} 件止めました`,
        detail: list.map((x) => `${x.pid} ${x.command}`).join("\n"),
      };
    }
    case "screens": {
      const shots: P[] = Array.isArray(p.shots) ? p.shots : [];
      const failed = shots.filter((s) => s.error).length;
      return {
        tone: failed ? "attention" : "neutral",
        icon: "📷",
        title: "画面の撮影",
        text: `${shots.length} 枚${failed ? `(撮れなかったもの ${failed} 枚)` : ""}`,
        detail: shots.map((s) => `${s.file}${s.error ? `: ${s.error}` : ""}`).join("\n"),
      };
    }
    case "auto_approved":
      return { tone: "success", icon: "✓", title: "計画の自動承認", text: "小さなタスクの条件を満たしたため、計画を自動で承認しました" };
    case "auto_approve_skipped":
      return { tone: "neutral", icon: "i", title: "自動承認しない", text: Array.isArray(p.reasons) ? p.reasons.join("、") : "" };
    case "waiting_overlap":
      return { tone: "neutral", icon: "⏳", title: "重なりの待ち", text: String(p.reason ?? "") };
    case "retro": {
      const list: P[] = Array.isArray(p.proposals) ? p.proposals : [];
      return { tone: "neutral", icon: "💡", title: "振り返り", text: list.length ? `提案 ${list.length} 件` : "提案なし", detail: list.map((x) => `${x.target}: ${x.text}`).join("\n") };
    }
    case "retro_decision":
      return { tone: p.adopt ? "success" : "neutral", icon: p.adopt ? "✓" : "×", title: p.adopt ? "振り返りの提案を採用" : "振り返りの提案を却下", text: String(p.text ?? "") };
    case "quota_wait":
      return { tone: "attention", icon: "⏱", title: "利用枠の待ち", text: [p.reason, p.until ? `${formatTime(String(p.until))} まで` : ""].filter(Boolean).join(" / ") };
    case "quota_paused":
      return { tone: "attention", icon: "⏱", title: "利用枠で一時停止", text: [p.reason, p.until ? `${formatTime(String(p.until))} に再開` : ""].filter(Boolean).join(" / ") };
    case "quota_resumed":
      return { tone: "neutral", icon: "⏱", title: "利用枠の回復で再開", text: "" };
    case "bounce":
      return { tone: "attention", icon: "↩", title: "差し戻し", text: String(p.summary ?? "") };
    case "tool_command": {
      const sec = Math.round(Number(p.durationMs ?? 0) / 1000);
      const ok = p.exitCode === 0 && !p.timedOut;
      const outcome = p.timedOut ? `時間切れ(${sec}秒)` : ok ? `成功(${sec}秒)` : `失敗(終了コード ${p.exitCode}、${sec}秒)`;
      return {
        tone: ok ? "success" : "danger",
        icon: "▸",
        title: p.purpose === "verify" ? "テストの再実行(ツール)" : "コマンドの実行(ツール)",
        text: `${p.command ?? ""} — ${outcome}`,
      };
    }
    case "test_command":
      return { tone: "neutral", icon: "▸", title: "テストのコマンド", text: String(p.command ?? "") };
    case "integrated":
      return { tone: "success", icon: "⇢", title: "統合", text: `${p.branch ?? ""}(push は人が行います)` };
    case "plan": {
      const criteria = Array.isArray(p.acceptanceCriteria) ? (p.acceptanceCriteria as unknown[]).map(String) : [];
      return {
        tone: "neutral",
        icon: "📝",
        title: "計画",
        text: criteria.length ? `受け入れ条件 ${criteria.length} 件${p.testFirstException ? "(テスト先行の例外)" : ""}` : stringify(p).slice(0, 200),
        detail: criteria.length ? criteria.map((c) => `- ${c}`).join("\n") : stringify(p),
      };
    }
    default:
      return { tone: "neutral", icon: "·", title: e.kind, text: JSON.stringify(e.payload).slice(0, 200), detail: stringify(e.payload) };
  }
}

/**
 * 経緯(S2)と最近の出来事(S1)に出す種類(docs/skeleton.md「経緯に出す出来事」)。API の kinds で絞るのに使う。
 * 状態の変化は、完了と取り消しだけを isMilestone で残す(ほかはパイプラインと重なる)
 */
export const MILESTONE_KINDS = [
  "bounce",
  "review_findings",
  "audit",
  "auto_approved",
  "auto_approve_skipped",
  "needs_input",
  "failed",
  "warning",
  "waiting_overlap",
  "human_takeover",
  "human_returned",
  "integrated",
  "decisions",
  "retro_decision",
  "quota_wait",
  "quota_paused",
  "quota_resumed",
  "state_changed",
];

const MILESTONE_STATES = ["done", "cancelled"];

/** 「なぜそうなったか」が分かる出来事か。細かい動き・記録だけの出来事・ほとんどの状態の変化は外す */
export function isMilestone(e: EventView): boolean {
  if (!MILESTONE_KINDS.includes(e.kind)) return false;
  if (e.kind === "state_changed") return MILESTONE_STATES.includes(String((e.payload as P | null)?.to));
  return true;
}

const ACTION_KINDS = ["assistant_text", "tool_use"];

/** 実行の今の動き(最新の発言かツール実行)。無ければ null */
export function latestAction(events: EventView[]): EventView | null {
  return events.findLast((e) => ACTION_KINDS.includes(e.kind)) ?? null;
}
