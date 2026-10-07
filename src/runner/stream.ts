import type { PermissionDenial, RunEvent } from "./types.ts";

const MAX_STRING = 2000;

/** 長い文字列を切り詰める(DBに残すイベントを小さく保つ) */
function truncate(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…(${v.length}文字)` : v;
  if (depth > 5) return "…";
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => truncate(x, depth + 1));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, truncate(x, depth + 1)]));
  }
  return v;
}

type Json = Record<string, any>;

export type StreamSummary = {
  sessionId?: string;
  model?: string;
  resultText?: string;
  isError: boolean;
  subtype?: string;
  costUsd?: number;
  structuredOutput?: unknown;
  permissionDenials: PermissionDenial[];
  models: string[];
  numTurns?: number;
  hasResult: boolean;
};

/** stream-json を1行ずつ受け取り、DBに残すイベントへの変換と、最終結果の集約を行う */
export class StreamCollector {
  private init: Json | undefined;
  private result: Json | undefined;
  private readonly bashCalls = new Map<string, { command: string; isError?: boolean; output?: string }>();

  /** Bash の実行結果(コマンドと終了状態)。verifier の合否はモデルの申告ではなくこれで判定する */
  bashResults(): { command: string; isError: boolean; output: string }[] {
    return [...this.bashCalls.values()]
      .filter((c) => c.isError !== undefined)
      .map((c) => ({ command: c.command, isError: c.isError!, output: c.output ?? "" }));
  }

  push(line: string): RunEvent[] {
    let m: Json;
    try {
      m = JSON.parse(line);
    } catch {
      return line.trim() ? [{ kind: "raw", payload: { line: truncate(line) } }] : [];
    }
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          this.init = m;
          return [{ kind: "init", payload: { model: m.model, tools: m.tools, sessionId: m.session_id } }];
        }
        if (m.subtype === "thinking_tokens") return [];
        return [{ kind: "system", payload: truncate(m) }];
      case "assistant":
        return ((m.message?.content ?? []) as Json[]).flatMap((c): RunEvent[] => {
          if (c.type === "text") return [{ kind: "assistant_text", payload: { text: truncate(c.text) } }];
          if (c.type === "tool_use") {
            if (c.name === "Bash" && typeof c.id === "string") this.bashCalls.set(c.id, { command: String(c.input?.command ?? "") });
            return [{ kind: "tool_use", payload: { name: c.name, input: truncate(c.input) } }];
          }
          return [];
        });
      case "user":
        return ((Array.isArray(m.message?.content) ? m.message.content : []) as Json[])
          .filter((c) => c.type === "tool_result")
          .map((c) => {
            const call = this.bashCalls.get(c.tool_use_id);
            const text = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
            if (call) Object.assign(call, { isError: c.is_error === true, output: String(truncate(text)) });
            return {
            kind: "tool_result",
            payload: { isError: c.is_error === true, content: truncate(text) },
            };
          });
      case "rate_limit_event":
        return [{ kind: "rate_limit", payload: m.rate_limit_info ?? {} }];
      case "result":
        this.result = m;
        return [{
          kind: "result",
          payload: { subtype: m.subtype, isError: m.is_error, costUsd: m.total_cost_usd, numTurns: m.num_turns, durationMs: m.duration_ms },
        }];
      case "stream_event":
        return [];
      default:
        return [{ kind: "other", payload: { type: m.type } }];
    }
  }

  summary(): StreamSummary {
    const r = this.result;
    return {
      sessionId: r?.session_id ?? this.init?.session_id,
      model: this.init?.model,
      resultText: r?.result,
      isError: r?.is_error === true,
      subtype: r?.subtype,
      costUsd: r?.total_cost_usd,
      structuredOutput: r?.structured_output,
      permissionDenials: ((r?.permission_denials ?? []) as Json[]).map((d) => ({ tool: d.tool_name, input: d.tool_input })),
      models: Object.keys(r?.modelUsage ?? {}),
      numTurns: r?.num_turns,
      hasResult: r !== undefined,
    };
  }
}
