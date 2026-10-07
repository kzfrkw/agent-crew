#!/usr/bin/env node
// テスト用の偽の claude。標準入力のプロンプトに含まれる "SCENARIO:<名前>" で動作を変える。
// 受け取った引数・環境変数・cwd・プロンプトを cwd/.fake-claude-record.json に残す。
import { writeFileSync } from "node:fs";

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  writeFileSync(".fake-claude-record.json", JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), prompt: input }));
  const scenario = /SCENARIO:(\S+)/.exec(input)?.[1] ?? "ok";
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  const init = { type: "system", subtype: "init", session_id: "sess-1", model: "claude-haiku-4-5", tools: ["Read"] };

  if (scenario === "ok") {
    out(init);
    out({ type: "assistant", message: { content: [{ type: "text", text: "調べます" }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x", big: "y".repeat(5000) } }] } });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "file body" }] } });
    out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour" } });
    out({
      type: "result", subtype: "success", is_error: false, result: "完了しました", session_id: "sess-1",
      total_cost_usd: 0.25, num_turns: 3, duration_ms: 1200,
      structured_output: { verdict: "done", summary: "実装した" },
      permission_denials: [{ tool_name: "Bash", tool_input: { command: "git push" } }],
      modelUsage: { "claude-haiku-4-5": {} },
    });
    process.exit(0);
  } else if (scenario === "error") {
    out(init);
    out({ type: "result", subtype: "error_max_budget_usd", is_error: true, result: "予算超過", session_id: "sess-1", total_cost_usd: 5 });
    process.exit(1);
  } else if (scenario === "no-structured") {
    out(init);
    out({ type: "result", subtype: "success", is_error: false, result: "判定なし", session_id: "sess-1", total_cost_usd: 0.1 });
    process.exit(0);
  } else if (scenario === "crash") {
    process.stderr.write("boom: something failed\n");
    process.exit(2);
  } else if (scenario === "hang") {
    out(init);
    process.on("SIGINT", () => process.exit(130));
    setInterval(() => {}, 1000);
  } else if (scenario === "hang-ignore-sigint") {
    out(init);
    process.on("SIGINT", () => {});
    setInterval(() => {}, 1000);
  }
});
