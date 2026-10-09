// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventView, Overview, TaskSummary } from "../../../src/server/api-types.ts";
import { App } from "../App.tsx";
import { AttentionPanel } from "./dashboard/AttentionPanel.tsx";
import { EventList } from "./EventList.tsx";
import { TaskTable } from "./TaskTable.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const task = (o: Partial<TaskSummary>): TaskSummary => ({
  id: 1,
  projectId: 1,
  title: "t",
  kind: "normal",
  state: "implementing",
  stateLabel: "実装中",
  heldFromState: null,
  assignee: null,
  reviewRounds: 0,
  design: { architect: false, designer: false },
  createdAt: "2026-10-09T00:00:00.000Z",
  updatedAt: "2026-10-09T00:00:00.000Z",
  attention: null,
  reason: null,
  running: null,
  primaryAction: null,
  costUsd: null,
  ...o,
});

describe("AttentionPanel", () => {
  it("回答待ち → 承認待ちの順に並べ、理由と次のコマンドを出す。人が作業中は件数に数えない", () => {
    render(
      <AttentionPanel
        tasks={[
          task({ id: 1, title: "実装中のもの" }),
          task({ id: 2, title: "計画を見て", state: "awaiting_plan_approval", stateLabel: "計画の承認待ち", attention: "approve_plan", primaryAction: { kind: "approve", label: "承認する", command: "agent-crew task approve 2 --kind plan", request: { action: "approve", kind: "plan" } } }),
          task({ id: 3, title: "質問あり", state: "needs_input", stateLabel: "人の回答待ち", attention: "answer", reason: "AとBどちら?" }),
          task({ id: 4, title: "手作業", state: "human_working", stateLabel: "人が作業中", attention: "human_working" }),
        ]}
      />,
    );
    const items = screen.getAllByRole("article");
    expect(items.map((i) => within(i).getByRole("link").textContent)).toEqual(["質問あり", "計画を見て", "手作業"]);
    expect(screen.getByText("AとBどちら?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "承認する" })).toBeTruthy(); // 主な操作はボタン(フェーズ3)
    expect(screen.getByRole("heading", { name: "対応待ち" }).nextSibling?.textContent).toBe("2");
  });

  it("無ければそう表示する", () => {
    render(<AttentionPanel tasks={[task({})]} />);
    expect(screen.getByText("あなたの対応が必要なタスクはありません")).toBeTruthy();
  });
});

describe("EventList", () => {
  const ev = (id: number, kind: string, payload: unknown): EventView => ({ id, taskId: 1, runId: 2, kind, payload, createdAt: "2026-10-09T00:00:00.000Z" });

  it("1行に畳み、押すと詳細を開く", () => {
    render(<EventList events={[ev(1, "tool_use", { name: "Bash", input: { command: "npm test", description: "テスト" } })]} />);
    expect(screen.getByText("npm test")).toBeTruthy();
    const toggle = screen.getByRole("button");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/"description": "テスト"/)).toBeTruthy();
  });

  it("desc なら新しい順", () => {
    render(<EventList order="desc" events={[ev(1, "warning", { message: "古い" }), ev(2, "warning", { message: "新しい" })]} />);
    expect(screen.getAllByText(/古い|新しい/).map((e) => e.textContent)).toEqual(["新しい", "古い"]);
  });
});

describe("TaskTable の費用の列", () => {
  const tasks = [task({ id: 1, title: "あり", costUsd: 0.18 }), task({ id: 2, title: "大きい", costUsd: 1.234 }), task({ id: 3, title: "なし", costUsd: null })];

  it("「差し戻し」と「更新」のあいだに「費用」があり、formatCost で整形する。null は「-」", () => {
    render(<TaskTable tasks={tasks} />);
    const heads = screen.getAllByRole("columnheader").map((h) => h.textContent);
    const i = heads.indexOf("費用");
    expect(i).toBeGreaterThan(-1);
    expect(heads[i - 1]).toBe("差し戻し");
    expect(heads[i + 1]).toBe("更新");
    const cost = (title: string) => within(screen.getByText(title).closest("tr")!).getAllByRole("cell")[i]!;
    expect(cost("あり").textContent).toBe("$0.180");
    expect(cost("大きい").textContent).toBe("$1.23");
    expect(cost("なし").textContent).toBe("-");
  });

  it("見出しとセルの両方が狭い画面で隠れる", () => {
    render(<TaskTable tasks={tasks} />);
    const heads = screen.getAllByRole("columnheader");
    const i = heads.findIndex((h) => h.textContent === "費用");
    expect(heads[i]!.className).toContain("max-sm:hidden");
    for (const row of screen.getAllByRole("row").slice(1)) expect(within(row).getAllByRole("cell")[i]!.className).toContain("max-sm:hidden");
  });
});

describe("TaskTable の狭い画面", () => {
  it("狭い画面では状態の列を隠し、状態のバッジをタイトルの上に置く(長い状態名で表が広がらないように。自己適用で発見)", () => {
    render(<TaskTable tasks={[task({ id: 1, title: "t", state: "awaiting_design_approval", stateLabel: "デザイン仕様の承認待ち", attention: "approve_design" })]} />);
    const heads = screen.getAllByRole("columnheader");
    const stateCol = heads.findIndex((h) => h.textContent === "状態");
    const titleCol = heads.findIndex((h) => h.textContent === "タイトル");
    expect(heads[stateCol]!.className).toContain("max-sm:hidden");
    const cells = within(screen.getAllByRole("row")[1]!).getAllByRole("cell");
    expect(cells[stateCol]!.className).toContain("max-sm:hidden");
    // タイトルの欄の中のバッジは、狭い画面だけで見える要素の中にある
    const inTitle = within(cells[titleCol]!).getByText("デザイン仕様の承認待ち");
    expect(inTitle.closest(".sm\\:hidden")).not.toBeNull();
  });
});

describe("App(ダッシュボード)", () => {
  const overview: Overview = {
    worker: { state: "disabled", active: [] },
    projects: [{ id: 1, name: "shop", profileStatus: "approved", testInfra: "present", allowWithoutTests: false }],
    tasks: [
      task({ id: 7, title: "検索を追加", running: { id: 9, role: "implementer", model: "sonnet", startedAt: "2026-10-09T00:00:00.000Z" } }),
      task({ id: 8, title: "質問あり", state: "needs_input", stateLabel: "人の回答待ち", attention: "answer", reason: "どちら?" }),
      task({ id: 6, title: "終わった", state: "done", stateLabel: "完了" }),
    ],
    running: [],
    stateLabels: {} as Overview["stateLabels"],
  };

  beforeEach(() => {
    window.history.pushState(null, "", "/");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = url.startsWith("/api/overview") ? overview : url.startsWith("/api/events") ? { events: [], lastId: 0 } : {};
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
  });

  it("対応待ち・実況・タスク一覧を表示し、完了は既定で隠す。件数をタブのタイトルに出す", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "対応待ち" });
    expect(screen.getByRole("heading", { name: "実況" })).toBeTruthy();
    const table = screen.getByRole("table");
    expect(within(table).getByText("検索を追加")).toBeTruthy();
    expect(within(table).getByText("implementer")).toBeTruthy();
    expect(within(table).queryByText("終わった")).toBeNull();
    fireEvent.click(screen.getByLabelText("完了・取り消しも表示"));
    expect(within(screen.getByRole("table")).getByText("終わった")).toBeTruthy();
    await waitFor(() => expect(document.title).toBe("(1) agent-crew"));
  });

  it("行のリンクでタスク詳細へ遷移する(ページの再読み込みなし)", async () => {
    render(<App />);
    const link = await within(await screen.findByRole("table")).findByText("検索を追加");
    fireEvent.click(link);
    expect(window.location.pathname).toBe("/tasks/7");
  });
});
