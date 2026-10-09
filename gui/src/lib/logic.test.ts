import { describe, expect, it } from "vitest";
import { describeEvent, isNoise, isRunDetail } from "./events.ts";
import { formatCost, formatDuration, formatTime, elapsedSec } from "./format.ts";
import { pipelineOf } from "./pipeline.ts";
import { matchRoute } from "./routes.ts";

describe("matchRoute", () => {
  it.each([
    ["/", { name: "dashboard" }],
    ["/tasks/12", { name: "task", id: 12 }],
    ["/tasks/12/artifacts/3", { name: "artifact", taskId: 12, id: 3 }],
    ["/runs/45", { name: "run", id: 45 }],
    ["/projects/1", { name: "project", id: 1 }],
    ["/tasks/x", { name: "notFound" }],
    ["/nope", { name: "notFound" }],
  ])("%s", (path, route) => {
    expect(matchRoute(path)).toEqual(route);
  });
});

describe("format", () => {
  it("時刻はローカル時刻の HH:MM:SS", () => {
    const iso = new Date(2026, 9, 9, 7, 5, 3).toISOString();
    expect(formatTime(iso)).toBe("07:05:03");
  });
  it("所要時間", () => {
    expect(formatDuration(0)).toBe("0秒");
    expect(formatDuration(42)).toBe("42秒");
    expect(formatDuration(192)).toBe("3分12秒");
    expect(formatDuration(3720)).toBe("1時間2分");
    expect(formatDuration(null)).toBe("-");
  });
  it("費用", () => {
    expect(formatCost(0.0912)).toBe("$0.091");
    expect(formatCost(1.5)).toBe("$1.50");
    expect(formatCost(null)).toBe("-");
  });
  it("経過秒", () => {
    expect(elapsedSec("2026-10-09T00:00:00.000Z", Date.parse("2026-10-09T00:03:12.000Z"))).toBe(192);
  });
});

describe("pipelineOf", () => {
  const labels = (state: Parameters<typeof pipelineOf>[0], held: Parameters<typeof pipelineOf>[1] = null) =>
    pipelineOf(state, held).map((s) => `${s.label}:${s.status}`);

  it("実装中: 計画と承認は済み、実装が現在地", () => {
    expect(labels("implementing")).toEqual([
      "計画:done",
      "計画の承認:done",
      "実装:current",
      "レビュー:todo",
      "QA:todo",
      "最終確認:todo",
      "統合:todo",
      "完了:todo",
    ]);
  });

  it("回答待ち・人が作業中・失敗は、止まる前の段に印を付ける", () => {
    expect(labels("needs_input", "reviewing")[3]).toBe("レビュー:blocked");
    expect(labels("human_working", "implementing")[2]).toBe("実装:human");
    expect(labels("failed", "qa")[4]).toBe("QA:failed");
  });

  it("承認待ちは、人の対応待ちとして印を付ける", () => {
    expect(labels("awaiting_plan_approval")[1]).toBe("計画の承認:blocked");
    expect(labels("awaiting_final_approval")[5]).toBe("最終確認:blocked");
  });

  it("完了はすべて済み。待機は何も始まっていない", () => {
    expect(labels("done").every((l) => l.endsWith(":done"))).toBe(true);
    expect(labels("queued").every((l) => l.endsWith(":todo"))).toBe(true);
  });
});

describe("describeEvent", () => {
  const ev = (kind: string, payload: unknown) => ({ id: 1, taskId: 1, runId: 2, kind, payload, createdAt: "2026-10-09T00:00:00.000Z" });

  it("ツール実行は道具の名前と主な引数", () => {
    expect(describeEvent(ev("tool_use", { name: "Bash", input: { command: "npm test" } }))).toMatchObject({ tone: "tool", title: "Bash", text: "npm test" });
    expect(describeEvent(ev("tool_use", { name: "Edit", input: { file_path: "/wt/1/src/a.ts" } })).text).toBe("/wt/1/src/a.ts");
  });

  it("状態の変化は表示名で", () => {
    expect(describeEvent(ev("state_changed", { from: "planning", to: "awaiting_plan_approval" })).text).toBe("計画中 → 計画の承認待ち");
  });

  it("失敗の結果や理由は強調する", () => {
    expect(describeEvent(ev("tool_result", { isError: true, content: "1 failed" })).tone).toBe("danger");
    expect(describeEvent(ev("needs_input", { reason: "質問" }))).toMatchObject({ tone: "attention", text: "質問" });
    expect(describeEvent(ev("run_failed", { role: "qa", reason: "時間切れ" })).tone).toBe("danger");
  });

  it("レビューの指摘は重大度ごとの件数で見せ、Must があれば強調する", () => {
    const findings = [
      { severity: "must", file: "a.ts", line: 3, title: "落ちる", detail: "d", suggestion: "s" },
      { severity: "should", file: "b.ts", line: null, title: "重複", detail: "d", suggestion: "s" },
      { severity: "should", file: "c.ts", line: 1, title: "命名", detail: "d", suggestion: "s" },
    ];
    expect(describeEvent(ev("review_findings", { verdict: "changes_requested", findings }))).toMatchObject({ tone: "attention", text: "must 1 / should 2 / nit 0" });
    const none = describeEvent(ev("review_findings", { verdict: "approve", findings: [findings[1]] }));
    expect(none).toMatchObject({ tone: "neutral", text: "must 0 / should 1 / nit 0" });
    expect(none.detail).toContain("[should] b.ts — 重複");
  });

  it("Must 指摘の監査は、却下と維持の件数で見せる", () => {
    expect(describeEvent(ev("audit", { verdict: "upheld", standing: [0], dismissed: [2, 3], judgments: [] }))).toMatchObject({ title: "Must 指摘の監査", text: "維持 1 / 却下 2" });
  });

  it("知らない種類も落ちずに表示する", () => {
    expect(describeEvent(ev("mystery", { a: 1 }))).toMatchObject({ title: "mystery", text: '{"a":1}' });
  });
});

describe("イベントの絞り込み", () => {
  const ev = (kind: string, payload: unknown, runId: number | null = 2) => ({ id: 1, taskId: 1, runId, kind, payload, createdAt: "2026-10-09T00:00:00.000Z" });

  it("利用枠が通常(allowed)のときと、system・raw・other はノイズ", () => {
    expect(isNoise(ev("rate_limit", { status: "allowed" }))).toBe(true);
    expect(isNoise(ev("rate_limit", { status: "rejected" }))).toBe(false);
    expect(isNoise(ev("system", { subtype: "commands_changed" }))).toBe(true);
    expect(isNoise(ev("tool_use", { name: "Bash" }))).toBe(false);
  });

  it("実行の中の細かい動き(発言・ツール)は実行ログで見るもの", () => {
    expect(isRunDetail(ev("tool_use", {}))).toBe(true);
    expect(isRunDetail(ev("result", {}))).toBe(true);
    expect(isRunDetail(ev("plan", {}))).toBe(false);
    expect(isRunDetail(ev("state_changed", {}, null))).toBe(false);
  });

  it("利用枠が制限中なら注意として表示し、生の JSON は見せない", () => {
    const d = describeEvent(ev("rate_limit", { status: "rejected", resetsAt: 1791510600, rateLimitType: "five_hour" }));
    expect(d.tone).toBe("attention");
    expect(d.text).toContain("five_hour");
    expect(d.text).not.toContain("{");
  });

  it("構造化出力(判定)は判定と要約で見せる", () => {
    const d = describeEvent(ev("tool_use", { name: "StructuredOutput", input: { verdict: "ready", summary: "要約です" } }));
    expect(d).toMatchObject({ title: "判定を返す", text: "ready — 要約です" });
  });
});

describe("長いパスの省略", () => {
  const ev = (kind: string, payload: unknown) => ({ id: 1, taskId: 2, runId: 3, kind, payload, createdAt: "2026-10-09T00:00:00.000Z" });
  const wt = "/private/var/folders/q9/T/agent-crew-e2e-x/home/worktrees/sample/2/main";

  it("先頭の cd <絶対パス> を省き、本体のコマンドを見せる", () => {
    expect(describeEvent(ev("tool_use", { name: "Bash", input: { command: `cd ${wt}; npm test 2>&1 | tail -40` } })).text).toBe("npm test 2>&1 | tail -40");
    expect(describeEvent(ev("tool_use", { name: "Bash", input: { command: `cd ${wt}\ncat > test/a.test.js <<'EOF'` } })).text).toBe("cat > test/a.test.js <<'EOF'");
    expect(describeEvent(ev("tool_use", { name: "Bash", input: { command: `cd "${wt}" && git status` } })).text).toBe("git status");
  });

  it("worktree の中のファイルは worktree からの相対パス、データディレクトリの成果物は tasks/ からのパス", () => {
    expect(describeEvent(ev("tool_use", { name: "Write", input: { file_path: `${wt}/test/items.test.js` } })).text).toBe("test/items.test.js");
    expect(describeEvent(ev("tool_use", { name: "Write", input: { file_path: "/x/home/tasks/2/plan.md" } })).text).toBe("tasks/2/plan.md");
  });

  it("ツールの結果の中のパスも短くする", () => {
    expect(describeEvent(ev("tool_result", { isError: false, content: `File created successfully at: ${wt}/src/a.js` })).text).toBe("File created successfully at: src/a.js");
  });

  it("計画は受け入れ条件の件数で見せ、詳細に一覧を出す", () => {
    const d = describeEvent(ev("plan", { acceptanceCriteria: ["A になる", "B になる"], testFirstException: false }));
    expect(d.text).toBe("受け入れ条件 2 件");
    expect(d.detail).toContain("- A になる");
  });
});
