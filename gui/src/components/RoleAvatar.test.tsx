// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ROLE_META } from "../lib/roles.ts";
import { RoleAvatar } from "./RoleAvatar.tsx";

afterEach(cleanup);

describe("RoleAvatar(役割のキャラクター)", () => {
  it("名前を読み上げる絵として出す。名前を横に書くところでは飾り(読み上げない)にできる", () => {
    render(<RoleAvatar role="reviewer" />);
    expect(screen.getByRole("img", { name: "レビュワー" })).toBeTruthy();
    cleanup();
    const { container } = render(<RoleAvatar role="reviewer" decorative />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("実行中だけ、実行中の色で、役割に合った動きをする", () => {
    const { container, rerender } = render(<RoleAvatar role="reviewer" active />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("class")).toContain("text-run");
    expect(container.querySelector("[data-motion='scan']")!.getAttribute("class")).toContain("animate-role-scan");
    rerender(<RoleAvatar role="reviewer" />);
    expect(container.querySelector("svg")!.getAttribute("class")).not.toContain("text-run");
    expect(container.innerHTML).not.toContain("animate-");
  });

  it("どの役割も、それぞれの道具を持って描ける", () => {
    const tools = new Set<string>();
    for (const role of Object.keys(ROLE_META)) {
      const { container } = render(<RoleAvatar role={role} active />);
      const tool = container.querySelector("[data-tool]")!.getAttribute("data-tool")!;
      tools.add(tool);
      cleanup();
    }
    // 役割ごとに道具が違う(同じ道具を持つ役割があってもよいが、ほとんどは違う)
    expect(tools.size).toBeGreaterThanOrEqual(Object.keys(ROLE_META).length - 3);
  });
});
