// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextAction, Overview } from "../../../src/server/api-types.ts";
import { NewTaskPage } from "../pages/NewTaskPage.tsx";
import { ActionPanel } from "./ActionPanel.tsx";

type Call = { url: string; init: RequestInit };
let calls: Call[];
let reply: (url: string, init: RequestInit) => { status: number; body: unknown };

beforeEach(() => {
  calls = [];
  reply = () => ({ status: 200, body: { message: "承認しました", task: {} } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const r = reply(url, init);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const posts = () => calls.filter((c) => c.init.method === "POST").map((c) => ({ url: c.url, body: JSON.parse(String(c.init.body)), headers: c.init.headers }));

const approve: NextAction = {
  kind: "approve",
  label: "plan.md を確認して承認する",
  command: "agent-crew task approve 1 --kind plan",
  request: { action: "approve", kind: "plan" },
  input: { field: "comment", required: false, placeholder: "コメント(任意)" },
  primary: true,
};
const reject: NextAction = {
  kind: "reject",
  label: "却下して差し戻す",
  command: 'agent-crew task reject 1 --kind plan --comment "..."',
  request: { action: "reject", kind: "plan", comment: "" },
  input: { field: "comment", required: true, placeholder: "却下の理由(次の役割への入力になります)" },
};
const stop: NextAction = { kind: "stop", label: "実行中の役割を停止する", command: null, request: { action: "stop" }, confirm: "実行中の claude を止めます" };

describe("ActionPanel", () => {
  it("承認: コメントを添えて、専用ヘッダーつきで送る", async () => {
    const done = vi.fn();
    render(<ActionPanel taskId={1} actions={[approve, reject]} onDone={done} />);
    fireEvent.change(screen.getByPlaceholderText("コメント(任意)"), { target: { value: "進めて" } });
    fireEvent.click(screen.getByRole("button", { name: "plan.md を確認して承認する" }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(posts()).toEqual([
      { url: "/api/tasks/1/actions", body: { action: "approve", kind: "plan", comment: "進めて" }, headers: expect.objectContaining({ "x-agent-crew": "1", "content-type": "application/json" }) },
    ]);
    expect(screen.getByRole("status").textContent).toContain("承認しました");
  });

  it("却下: 理由が空なら送らずに知らせる", async () => {
    render(<ActionPanel taskId={1} actions={[approve, reject]} />);
    fireEvent.click(screen.getByRole("button", { name: "却下して差し戻す" }));
    expect(screen.getByRole("alert").textContent).toBe("却下の理由を書いてください");
    expect(posts()).toEqual([]);
  });

  it("停止: 確認のダイアログを出し、確定で送る。やめれば送らない", async () => {
    render(<ActionPanel taskId={1} actions={[stop]} />);
    fireEvent.click(screen.getByRole("button", { name: "実行中の役割を停止する" }));
    let dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("実行中の claude を止めます")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "やめる" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(posts()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "実行中の役割を停止する" }));
    dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "実行中の役割を停止する" }));
    await waitFor(() => expect(posts()).toEqual([expect.objectContaining({ body: { action: "stop" } })]));
  });

  it("サーバーが断った理由(409 など)をそのまま見せる", async () => {
    reply = () => ({ status: 409, body: { error: "未コミットの変更があります" } });
    const ret: NextAction = { kind: "return", label: "エージェントに戻す", command: "agent-crew task return 1", request: { action: "return" }, primary: true };
    render(<ActionPanel taskId={1} actions={[ret]} />);
    fireEvent.click(screen.getByRole("button", { name: "エージェントに戻す" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("未コミットの変更があります"));
  });

  it("CLI のコマンドは折りたたんで残す", () => {
    render(<ActionPanel taskId={1} actions={[approve, reject, stop]} />);
    expect(screen.getByText("CLI で操作する")).toBeTruthy();
    expect(screen.getByText("agent-crew task approve 1 --kind plan")).toBeTruthy();
  });
});

describe("チケット投入", () => {
  const overview: Partial<Overview> = {
    worker: { state: "running", active: [] },
    projects: [
      { id: 1, name: "shop", profileStatus: "approved", testInfra: "present", allowWithoutTests: false },
      { id: 2, name: "notes", profileStatus: "approved", testInfra: "present", allowWithoutTests: false },
    ],
    tasks: [],
  };

  it("プロジェクト・タイトル・本文・取り込み元を送り、作ったタスクへ移る", async () => {
    reply = (url, init) =>
      init.method === "POST" ? { status: 201, body: { task: { id: 42 } } } : { status: 200, body: overview };
    window.history.pushState(null, "", "/tasks/new");
    render(<NewTaskPage />);
    fireEvent.change(await screen.findByLabelText("プロジェクト"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "検索を追加" } });
    fireEvent.change(screen.getByLabelText("本文"), { target: { value: "部分一致で" } });
    fireEvent.change(screen.getByLabelText(/取り込み元/), { target: { value: "https://www.notion.so/x" } });
    fireEvent.click(screen.getByRole("button", { name: "作成する" }));
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/42"));
    expect(posts()[0]).toMatchObject({ url: "/api/tasks", body: { projectId: 2, title: "検索を追加", body: "部分一致で", sourceUrl: "https://www.notion.so/x" } });
  });

  it("タイトルが空なら送らない", async () => {
    reply = () => ({ status: 200, body: overview });
    render(<NewTaskPage />);
    await screen.findByLabelText("プロジェクト");
    fireEvent.click(screen.getByRole("button", { name: "作成する" }));
    expect(screen.getByRole("alert").textContent).toContain("タイトル");
    expect(posts()).toEqual([]);
  });
});
