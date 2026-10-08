import { describe, expect, it } from "vitest";
import { describeEvent } from "./events.ts";
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

  it("知らない種類も落ちずに表示する", () => {
    expect(describeEvent(ev("mystery", { a: 1 }))).toMatchObject({ title: "mystery", text: '{"a":1}' });
  });
});
