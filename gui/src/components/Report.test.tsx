// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Report } from "./Report.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const report = {
  taskId: 1,
  title: "注文の一覧に状態を表示する",
  sourceUrl: "https://www.notion.so/team/abc",
  sections: [
    { id: "summary" as const, title: "概要", markdown: "## 注文の一覧に状態を表示する\n\n- 状態: 完了" },
    { id: "qa" as const, title: "QA の結果", markdown: "### QA の結果: 合格\n\n| 1 | 合格 |" },
  ],
  markdown: "## 注文の一覧に状態を表示する\n\n- 状態: 完了\n\n### QA の結果: 合格\n\n| 1 | 合格 |",
};

describe("報告(6c、Notion に貼る)", () => {
  it("節ごとに中身を見せ、節ごと・すべてをコピーできる。元のページを開くリンクがある", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<Report report={report} />);
    expect(screen.getByText("QA の結果")).toBeTruthy();
    expect(screen.getByText(/状態: 完了/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /元のページ/ }).getAttribute("href")).toBe("https://www.notion.so/team/abc");
    fireEvent.click(screen.getByRole("button", { name: "すべてをコピー" }));
    expect(writeText).toHaveBeenLastCalledWith(report.markdown);
    fireEvent.click(screen.getByRole("button", { name: "QA の結果をコピー" }));
    expect(writeText).toHaveBeenLastCalledWith(report.sections[1]!.markdown);
  });

  it("元のページが無ければリンクを出さない", () => {
    render(<Report report={{ ...report, sourceUrl: null }} />);
    expect(screen.queryByRole("link", { name: /元のページ/ })).toBeNull();
  });
});
