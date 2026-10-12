// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UsageMeter } from "./Usage.tsx";

const wrap = (el: React.ReactElement) => render(<TooltipProvider>{el}</TooltipProvider>);

afterEach(cleanup);

const usage = {
  status: "allowed",
  updatedAt: 0,
  windows: [
    { key: "five_hour", label: "5時間", utilization: 0.32, resetsAt: Date.UTC(2026, 9, 12, 6, 0) },
    { key: "seven_day", label: "7日", utilization: 0.71, resetsAt: Date.UTC(2026, 9, 15, 0, 0) },
  ],
};

describe("利用枠の表示(7-1)", () => {
  it("いちばん高い使用率を出す", () => {
    wrap(<UsageMeter usage={usage} />);
    expect(screen.getByText("利用枠 71%")).toBeTruthy();
  });

  it("自動の一時停止中は、理由と再開の時刻を出す", () => {
    wrap(<UsageMeter usage={usage} quota={{ until: Date.UTC(2026, 9, 12, 6, 0), window: "five_hour", reason: "利用枠(5時間)の使用率が 96% です" }} />);
    expect(screen.getByText(/利用枠のため停止中/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/\d{1,2}:\d{2}/);
  });

  it("記録が無ければ何も出さない", () => {
    const { container } = wrap(<UsageMeter usage={null} />);
    expect(container.textContent).toBe("");
  });
});
