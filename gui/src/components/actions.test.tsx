// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextAction, Overview } from "../../../src/server/api-types.ts";
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

  it("計画の承認: 設計者・デザイナーのチェック(初期値はプランナーの判定)を、design として送る", async () => {
    const withOptions: NextAction = {
      ...approve,
      options: [
        { key: "architect", label: "設計者を動かす", value: true },
        { key: "designer", label: "デザイナーを動かす", value: false },
      ],
      optionsNote: "プランナーの判断: モジュールを分けるため",
    };
    render(<ActionPanel taskId={1} actions={[withOptions, reject]} />);
    expect(screen.getByText("プランナーの判断: モジュールを分けるため")).toBeTruthy();
    const architect = screen.getByRole("checkbox", { name: "設計者を動かす" }) as HTMLInputElement;
    expect(architect.checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "デザイナーを動かす" }));
    fireEvent.click(screen.getByRole("button", { name: "plan.md を確認して承認する" }));
    await waitFor(() =>
      expect(posts()[0]!.body).toEqual({ action: "approve", kind: "plan", comment: "", design: { architect: true, designer: true } }),
    );
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

describe("計画の承認で分割して進める(8-2)", () => {
  it("分割の案があれば選べ、選ぶと split: true を送る", async () => {
    const { render, screen, fireEvent, waitFor } = await import("@testing-library/react");
    const { ActionPanel } = await import("./ActionPanel.tsx");
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => new Response(JSON.stringify({ message: "ok", task: {} }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ActionPanel
        taskId={1}
        actions={[
          {
            kind: "approve",
            label: "承認する",
            command: null,
            request: { action: "approve", kind: "plan" },
            primary: true,
            options: [{ key: "architect", label: "設計者", value: false }],
            split: { count: 2, titles: ["API", "画面"] },
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByLabelText(/子タスク 2 個に分割して進める/));
    fireEvent.click(screen.getByRole("button", { name: "承認する" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toMatchObject({ action: "approve", kind: "plan", split: true });
  });
});
