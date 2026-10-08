import type { EventView } from "../../../src/server/api-types.ts";
import { STATE_LABELS } from "../../../src/orchestrator/states.ts";

/** イベントを1行の表示にする(docs/skeleton.md S4)。副作用なし */

export type Tone = "neutral" | "say" | "tool" | "result" | "state" | "attention" | "danger" | "success" | "human";
export type EventLine = { tone: Tone; icon: string; title: string; text: string; detail?: string };

type P = Record<string, any>;

const label = (s: unknown) => STATE_LABELS[s as keyof typeof STATE_LABELS] ?? String(s ?? "");

/** ツールの主な引数(1行で見せるもの) */
function toolArg(name: string, input: P | undefined): string {
  if (!input) return "";
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description;
  if (typeof v === "string") return v.split("\n")[0]!;
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
      return { tone: "tool", icon: "▸", title: String(p.name ?? "tool"), text: toolArg(String(p.name), p.input), detail: stringify(p.input) };
    case "tool_result":
      return {
        tone: p.isError ? "danger" : "result",
        icon: p.isError ? "✗" : "└",
        title: p.isError ? "結果(エラー)" : "結果",
        text: String(p.content ?? "").split("\n")[0]!.slice(0, 200),
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
    case "rate_limit":
      return { tone: "attention", icon: "⏱", title: "利用枠", text: stringify(p).slice(0, 200) };
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
    case "plan":
      return { tone: "neutral", icon: "📝", title: "計画", text: stringify(p).slice(0, 200), detail: stringify(p) };
    default:
      return { tone: "neutral", icon: "·", title: e.kind, text: JSON.stringify(e.payload).slice(0, 200), detail: stringify(e.payload) };
  }
}
