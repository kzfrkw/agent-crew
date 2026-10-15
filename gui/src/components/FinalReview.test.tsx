// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FinalReview } from "./FinalReview.tsx";

afterEach(cleanup);

const artifacts = [
  { id: 1, kind: "plan", fileName: "plan.md" },
  { id: 2, kind: "impl-notes", fileName: "impl-notes.md" },
  { id: 3, kind: "review", fileName: "review.md" },
  { id: 4, kind: "qa-report", fileName: "qa-report.md" },
  { id: 5, kind: "qa-report", fileName: "qa-report.md" },
];

describe("最終確認(何を見て何を確かめるかが分かる)", () => {
  it("QA の結果を先頭に目立たせ、差分・テストの変更・レビュー・実装のメモを、確かめることつきで順に並べる", () => {
    render(<FinalReview taskId={7} artifacts={artifacts} files={{ diff: "/files/tasks/7/diff.patch", testChanges: "/files/tasks/7/test-changes.md" }} screenshots={0} />);
    const qa = screen.getByRole("link", { name: /^qa-report\.md を読む/ });
    expect(qa.getAttribute("href")).toBe("/tasks/7/artifacts/5");
    expect(screen.getByText(/受け入れ条件ごとの結果/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "diff.patch" }).getAttribute("href")).toBe("/files/tasks/7/diff.patch");
    expect(screen.getByRole("link", { name: "test-changes.md" }).getAttribute("href")).toBe("/files/tasks/7/test-changes.md");
    expect(screen.getByText(/テストを弱めたり消したりしていないか/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "review.md" }).getAttribute("href")).toBe("/tasks/7/artifacts/3");
    expect(screen.getByRole("link", { name: "impl-notes.md" })).toBeTruthy();
    expect(screen.queryByText(/デザインレビュー/)).toBeNull();
    expect(screen.getByText(/承認すると.*pr-draft\.md.*push と PR は人/)).toBeTruthy();
  });

  it("デザインレビューがあれば、その結果と撮影した画面も並べる", () => {
    render(
      <FinalReview taskId={7} artifacts={[...artifacts, { id: 6, kind: "design-review", fileName: "design-review.md" }]} files={{ diff: null, testChanges: null }} screenshots={4} />,
    );
    expect(screen.getByRole("link", { name: "design-review.md" })).toBeTruthy();
    expect(screen.getByText(/撮影した画面 4 枚/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "diff.patch" })).toBeNull();
  });
});
