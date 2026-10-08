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

/** 見せても役に立たないもの(実況・アクティビティから外す。実行ログでは見せる) */
export function isNoise(e: EventView): boolean {
  if (e.kind === "rate_limit") return (e.payload as P | null)?.status === "allowed";
  return e.kind === "system" || e.kind === "raw" || e.kind === "other";
}

const RUN_DETAIL = ["init", "assistant_text", "tool_use", "tool_result", "result", "rate_limit", "system", "raw", "other"];

/** 実行の中の細かい動き(タスクのアクティビティには出さず、実行ログで見る) */
export function isRunDetail(e: EventView): boolean {
  return e.runId !== null && RUN_DETAIL.includes(e.kind);
}
