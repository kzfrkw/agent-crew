// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventView, Overview, TaskSummary } from "../../../src/server/api-types.ts";
import { App } from "../App.tsx";
import { AttentionPanel } from "./dashboard/AttentionPanel.tsx";
import { EventList } from "./EventList.tsx";

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
  createdAt: "2026-10-09T00:00:00.000Z",
  updatedAt: "2026-10-09T00:00:00.000Z",
  attention: null,
  reason: null,
  running: null,
  primaryAction: null,
  ...o,
});

describe("AttentionPanel", () => {
  it("回答待ち → 承認待ちの順に並べ、理由と次のコマンドを出す。人が作業中は件数に数えない", () => {
    render(
      <AttentionPanel
        tasks={[
          task({ id: 1, title: "実装中のもの" }),
          task({ id: 2, title: "計画を見て", state: "awaiting_plan_approval", stateLabel: "計画の承認待ち", attention: "approve_plan", primaryAction: { kind: "approve", label: "承認する", command: "agent-crew task approve 2 --kind plan" } }),
          task({ id: 3, title: "質問あり", state: "needs_input", stateLabel: "人の回答待ち", attention: "answer", reason: "AとBどちら?" }),
          task({ id: 4, title: "手作業", state: "human_working", stateLabel: "人が作業中", attention: "human_working" }),
        ]}
      />,
    );
    const items = screen.getAllByRole("article");
    expect(items.map((i) => within(i).getByRole("link").textContent)).toEqual(["質問あり", "計画を見て", "手作業"]);
    expect(screen.getByText("AとBどちら?")).toBeTruthy();
    expect(screen.getByText("agent-crew task approve 2 --kind plan")).toBeTruthy();
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

describe("App(ダッシュボード)", () => {
  const overview: Overview = {
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
