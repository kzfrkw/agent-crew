import { describe, expect, it } from "vitest";
import { describeEvent, isNoise, isRunDetail } from "./events.ts";
import { formatCost, formatDuration, formatTime, elapsedSec } from "./format.ts";
import { pipelineOf } from "./pipeline.ts";
import { countByFilter, matchesFilter } from "./taskFilter.ts";
import { matchRoute } from "./routes.ts";

describe("matchRoute", () => {
  it.each([
    ["/", { name: "dashboard" }],
    ["/tasks/12", { name: "task", id: 12 }],
    ["/tasks/new", { name: "chooseProject" }],
    ["/projects/new", { name: "newProject" }],
    ["/projects/3/tasks/new", { name: "newTask", projectId: 3 }],
    ["/projects/3/plans/new", { name: "newPlan", projectId: 3 }],
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

  it("実装中: 計画と承認は済み、実装が現在地(設計の段を動かさないタスクでは、設計の段は飛ばした扱い)", () => {
    expect(labels("implementing")).toEqual([
      "計画:done",
      "計画の承認:done",
      "設計:skipped",
      "デザインの承認:skipped",
      "実装:current",
      "レビュー:todo",
      "QA:todo",
      "デザインレビュー:skipped",
      "最終確認:todo",
      "統合:todo",
      "完了:todo",
    ]);
  });

  it("回答待ち・人が作業中・失敗は、止まる前の段に印を付ける", () => {
    expect(labels("needs_input", "reviewing")[5]).toBe("レビュー:blocked");
    expect(labels("human_working", "implementing")[4]).toBe("実装:human");
    expect(labels("failed", "qa")[6]).toBe("QA:failed");
  });

  it("承認待ちは、人の対応待ちとして印を付ける", () => {
    expect(labels("awaiting_plan_approval")[1]).toBe("計画の承認:blocked");
    expect(labels("awaiting_final_approval")[8]).toBe("最終確認:blocked");
  });

  it("設計の段: 動かす段は通常どおり、デザイナーを動かさなければデザインの承認は飛ばす", () => {
    const both = { architect: true, designer: true };
    expect(pipelineOf("designing", null, both).map((s) => s.status).slice(0, 5)).toEqual(["done", "done", "current", "todo", "todo"]);
    expect(pipelineOf("awaiting_design_approval", null, both)[3]!.status).toBe("blocked");
    expect(pipelineOf("implementing", null, { architect: true, designer: false }).map((s) => s.status).slice(2, 5)).toEqual(["done", "skipped", "current"]);
    expect(pipelineOf("needs_input", "designing", both)[2]!.status).toBe("blocked");
    // デザインレビュー(QA の後)は、デザイナーを動かしたタスクだけ
    expect(pipelineOf("design_reviewing", null, both)[7]).toMatchObject({ label: "デザインレビュー", status: "current" });
    expect(pipelineOf("awaiting_final_approval", null, { architect: true, designer: false })[7]!.status).toBe("skipped");
  });

  it("完了はすべて済み(飛ばした段は飛ばしたまま)。待機は何も始まっていない", () => {
    expect(labels("done").every((l) => l.endsWith(":done") || l.endsWith(":skipped"))).toBe(true);
    expect(labels("queued").every((l) => l.endsWith(":todo") || l.endsWith(":skipped"))).toBe(true);
  });
});

describe("パイプライン(企画。9a)", () => {
  it("企画のタスクは企画の段を出す。承認待ちは人の対応待ち", async () => {
    const { pipelineOf } = await import("./pipeline.ts");
    const st = pipelineOf("awaiting_scope_approval", null, undefined, "planning");
    expect(st.map((s) => s.label).slice(0, 5)).toEqual(["調査", "戦略", "戦略の承認", "要件", "要件の承認"]);
    expect(st.map((s) => s.status).slice(0, 6)).toEqual(["done", "done", "done", "done", "blocked", "todo"]);
    expect(pipelineOf("split", null, undefined, "planning").find((s) => s.state === "split")!.status).toBe("current");
  });
});

describe("パイプライン(分割済み。8-2)", () => {
  it("分割済みの親は、計画の承認までが済み、その先は未着手", async () => {
    const { pipelineOf } = await import("./pipeline.ts");
    const st = pipelineOf("split", null).map((s) => s.status);
    expect(st.slice(0, 2)).toEqual(["done", "done"]);
    expect(st.slice(2).every((x) => x === "todo" || x === "skipped")).toBe(true);
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
    // 差し戻しの理由(8-3)
    expect(describeEvent(ev("bounce", { source: "tests", key: "k", summary: "テストの再実行の失敗: × 在庫" }))).toMatchObject({ tone: "attention", title: "差し戻し", text: "テストの再実行の失敗: × 在庫" });
    // ツールが代わりに実行したコマンド(フェーズ6)
    expect(describeEvent(ev("tool_command", { purpose: "verify", command: "flutter test", exitCode: 0, timedOut: false, durationMs: 5300 }))).toMatchObject({ tone: "success", title: "テストの再実行(ツール)", text: "flutter test — 成功(5秒)" });
    expect(describeEvent(ev("tool_command", { purpose: "verify", command: "flutter test", exitCode: 1, timedOut: false, durationMs: 800 }))).toMatchObject({ tone: "danger", text: "flutter test — 失敗(終了コード 1、1秒)" });
    expect(describeEvent(ev("tool_command", { purpose: "agent", command: "flutter analyze", exitCode: 0, timedOut: true, durationMs: 900000 }))).toMatchObject({ tone: "danger", title: "コマンドの実行(ツール)", text: "flutter analyze — 時間切れ(900秒)" });
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

  it("設計判断の追記は、件数と最初の判断で見せる", () => {
    const d = describeEvent(ev("decisions", { role: "architect", decisions: ["A は B に閉じ込める", "C は使わない"] }));
    expect(d).toMatchObject({ title: "設計判断(設計者)", text: "A は B に閉じ込める ほか1件" });
    expect(d.detail).toContain("- C は使わない");
  });

  it("後片付けは、止めたプロセスの件数で見せる", () => {
    const d = describeEvent(ev("cleanup", { role: "qa", processes: [{ pid: 1, command: "node serve --port 4310" }] }));
    expect(d).toMatchObject({ tone: "attention", title: "後片付け(qa)", text: "残っていたプロセスを 1 件止めました" });
    expect(d.detail).toContain("node serve --port 4310");
  });

  it("撮影は枚数と、撮れなかった数で見せる", () => {
    const d = describeEvent(ev("screens", { shots: [{ file: "a.png" }, { file: "b.png", error: "x" }] }));
    expect(d).toMatchObject({ title: "画面の撮影", text: "2 枚(撮れなかったもの 1 枚)" });
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

describe("taskFilter(絞り込みの条件と件数)", () => {
  const t = (state: string, attention: string | null = null) => ({ state, attention }) as never;
  const tasks = [t("implementing"), t("needs_input", "answer"), t("human_working", "human_working"), t("done"), t("cancelled")];

  it.each([
    ["all", false, "implementing", null, true],
    ["all", false, "done", null, false],
    ["all", false, "cancelled", null, false],
    ["all", true, "done", null, true],
    ["all", true, "cancelled", null, true],
    ["active", false, "implementing", null, true],
    ["active", true, "done", null, false],
    ["active", true, "cancelled", null, false],
    ["active", false, "needs_input", "answer", false],
    ["attention", false, "needs_input", "answer", true],
    ["attention", false, "human_working", "human_working", true],
    ["attention", true, "done", null, false],
  ] as const)("%s / showClosed=%s / %s / %s → %s", (filter, showClosed, state, attention, expected) => {
    expect(matchesFilter(t(state, attention), filter, showClosed)).toBe(expected);
  });

  it("件数は matchesFilter で一覧に出る行の数と一致し、showClosed で「すべて」だけが変わる", () => {
    expect(countByFilter(tasks, false)).toEqual({ all: 3, active: 1, attention: 2 });
    expect(countByFilter(tasks, true)).toEqual({ all: 5, active: 1, attention: 2 });
    for (const showClosed of [false, true])
      for (const [f, n] of Object.entries(countByFilter(tasks, showClosed))) expect(tasks.filter((x) => matchesFilter(x, f as never, showClosed)).length).toBe(n);
  });

  it("空なら全部 0", () => {
    expect(countByFilter([], false)).toEqual({ all: 0, active: 0, attention: 0 });
  });
});
