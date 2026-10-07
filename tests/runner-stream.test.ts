import { describe, expect, it } from "vitest";
import { StreamCollector } from "../src/runner/stream.ts";

describe("StreamCollector", () => {
  it("init と result から必要な値を取り出す", () => {
    const c = new StreamCollector();
    c.push(JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "claude-opus", tools: ["Read"] }));
    c.push(JSON.stringify({
      type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s1", total_cost_usd: 0.5,
      structured_output: { verdict: "approve" }, permission_denials: [{ tool_name: "Bash", tool_input: { command: "git push" } }],
      modelUsage: { "claude-opus": {} }, num_turns: 4,
    }));
    expect(c.summary()).toEqual({
      sessionId: "s1", model: "claude-opus", resultText: "ok", isError: false, subtype: "success", costUsd: 0.5,
      structuredOutput: { verdict: "approve" }, permissionDenials: [{ tool: "Bash", input: { command: "git push" } }],
      models: ["claude-opus"], numTurns: 4, hasResult: true,
    });
  });

  it("DBに残すイベントは要約し、長い文字列を切り詰める", () => {
    const c = new StreamCollector();
    const ev = c.push(JSON.stringify({ type: "assistant", message: { content: [
      { type: "text", text: "a".repeat(5000) },
      { type: "tool_use", name: "Bash", input: { command: "npm test" } },
    ] } }));
    expect(ev).toHaveLength(2);
    expect(ev[0]!.kind).toBe("assistant_text");
    expect(String((ev[0]!.payload as { text: string }).text).length).toBeLessThan(2100);
    expect(ev[1]).toEqual({ kind: "tool_use", payload: { name: "Bash", input: { command: "npm test" } } });
  });

  it("利用枠のイベントを残す。思考トークンの途中経過は捨てる", () => {
    const c = new StreamCollector();
    expect(c.push(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }))).toEqual([
      { kind: "rate_limit", payload: { status: "allowed" } },
    ]);
    expect(c.push(JSON.stringify({ type: "system", subtype: "thinking_tokens", estimated_tokens: 5 }))).toEqual([]);
  });

  it("JSONでない行は raw として残し、落ちない", () => {
    const c = new StreamCollector();
    expect(c.push("not json")).toEqual([{ kind: "raw", payload: { line: "not json" } }]);
    expect(c.summary().hasResult).toBe(false);
  });
});
