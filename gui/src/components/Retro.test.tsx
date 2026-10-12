// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RetroPanel } from "./Retro.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const retro = {
  proposals: [
    { index: 0, target: "conventions" as const, text: "日付は ISO 8601", status: "pending" as const },
    { index: 1, target: "decisions" as const, text: "在庫の判定は items.js", status: "adopted" as const },
    { index: 2, target: "decisions" as const, text: "一覧は 50 件ずつ", status: "rejected" as const },
  ],
};

describe("振り返りの提案(8-5)", () => {
  it("提案ごとに種類・内容・状態を出し、未決のものは採用・却下できる。却下したものは採用し直せる", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: "ok", task: {} }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onDone = vi.fn();
    render(<RetroPanel taskId={3} retro={retro} onDone={onDone} />);
    expect(screen.getByText("日付は ISO 8601")).toBeTruthy();
    expect(screen.getByText("採用済み")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "「日付は ISO 8601」を採用" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe("/api/tasks/3/actions");
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ action: "retro", index: 0, adopt: true });
    expect(screen.getByRole("button", { name: "「一覧は 50 件ずつ」を採用" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "「在庫の判定は items.js」を採用" })).toBeNull();
  });
});
