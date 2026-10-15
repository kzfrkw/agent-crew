// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PlanningReview, planningApprovalTitle } from "./PlanningQuestions.tsx";

afterEach(cleanup);

const artifacts = [
  { id: 10, kind: "strategy", fileName: "strategy.md" },
  { id: 11, kind: "strategy.slides", fileName: "strategy.slides.md" },
  { id: 12, kind: "critique-strategy", fileName: "critique-strategy.md" },
  { id: 13, kind: "research", fileName: "research.md" },
];

describe("企画の承認(何を読んで何を決めるかが分かる)", () => {
  it("見出しは段ごとに、何を承認するかを書く", () => {
    expect(planningApprovalTitle("awaiting_strategy_approval")).toBe("戦略(strategy.md)を確認して承認してください");
    expect(planningApprovalTitle("awaiting_scope_approval")).toBe("要件(scope.md)を確認して承認してください");
    expect(planningApprovalTitle("awaiting_handoff_approval")).toBe("開発のチケット(handoff.md)を確認して承認してください");
  });

  it("まず読む本文を目立たせ、スライドと批評は説明つきで並べる。問いが無くても出す", () => {
    render(<PlanningReview taskId={3} state="awaiting_strategy_approval" q={null} artifacts={artifacts} />);
    const main = screen.getByRole("link", { name: /^strategy\.md を読む/ });
    expect(main.getAttribute("href")).toBe("/tasks/3/artifacts/10");
    expect(screen.getByText("まず読むもの")).toBeTruthy();
    expect(screen.getByText(/戦略の本文/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /strategy\.slides\.md/ }).getAttribute("href")).toBe("/tasks/3/artifacts/11");
    expect(screen.getByText(/同じ内容のスライド/)).toBeTruthy();
    expect(screen.getByText(/批評担当の点検結果/)).toBeTruthy();
    expect(screen.queryByText(/決めてほしいこと/)).toBeNull();
  });

  it("問いがあれば、読むものの下に1件ずつ箇条書きにし、誰からかと、批評の must・should の件数を添える", () => {
    render(
      <PlanningReview
        taskId={3}
        state="awaiting_strategy_approval"
        q={{ stage: "strategy", questions: [{ from: "企画担当", text: "動かす先を Web にするか(推奨)" }, { from: "批評担当", text: "成功指標の目標値" }], musts: ["根拠が無い"], shoulds: 7 }}
        artifacts={artifacts}
      />,
    );
    const items = screen.getAllByRole("listitem").map((li) => li.textContent ?? "").filter((t) => t.includes("—"));
    expect(items[0]).toContain("動かす先を Web にするか(推奨)");
    expect(items[0]).toContain("企画担当");
    expect(items[1]).toContain("批評担当");
    expect(screen.getByText(/must/).textContent).toContain("根拠が無い");
    expect(screen.getByText(/should 7 件/)).toBeTruthy();
  });
});
