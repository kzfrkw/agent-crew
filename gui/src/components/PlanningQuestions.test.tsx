// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PlanningQuestions } from "./PlanningQuestions.tsx";

afterEach(cleanup);

describe("企画の承認で人が決めること(読みやすく)", () => {
  it("問いを1件ずつ箇条書きにし、誰からかを添える。批評の must と should の件数、読むものへのリンクを出す", () => {
    render(
      <PlanningQuestions
        taskId={3}
        q={{ stage: "strategy", questions: [{ from: "書く役", text: "動かす先を Web にするか(推奨)" }, { from: "批評担当", text: "成功指標の目標値" }], musts: ["根拠が無い"], shoulds: 7 }}
        artifacts={[
          { id: 10, kind: "strategy", fileName: "strategy.md" },
          { id: 11, kind: "strategy.slides", fileName: "strategy.slides.md" },
          { id: 12, kind: "critique-strategy", fileName: "critique-strategy.md" },
          { id: 13, kind: "research", fileName: "research.md" },
        ]}
      />,
    );
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items[0]).toContain("動かす先を Web にするか(推奨)");
    expect(items[0]).toContain("書く役");
    expect(items[1]).toContain("批評担当");
    expect(screen.getByText(/must/).textContent).toContain("根拠が無い");
    expect(screen.getByText(/should 7 件/)).toBeTruthy();
    const links = screen.getAllByRole("link").map((a) => a.textContent);
    expect(links).toEqual(["strategy.md を読む", "strategy.slides.md を読む", "critique-strategy.md を読む"]);
  });
});
