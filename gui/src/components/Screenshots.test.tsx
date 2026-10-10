// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Screenshots } from "./Screenshots.tsx";

afterEach(cleanup);

describe("撮影した画面(4c)", () => {
  it("画面ごとにまとめ、幅と配色を添えて画像を並べる。画像は生ファイルを開くリンク", () => {
    render(
      <Screenshots
        shots={[
          { name: "s1", path: "/items", width: 1280, scheme: "light", file: "s1-1280-light.png", url: "/files/tasks/1/screens/s1-1280-light.png" },
          { name: "s1", path: "/items", width: 1280, scheme: "dark", file: "s1-1280-dark.png", url: "/files/tasks/1/screens/s1-1280-dark.png" },
          { name: "s1", path: "/items", width: 390, scheme: "light", file: "s1-390-light.png", url: "/files/tasks/1/screens/s1-390-light.png" },
        ]}
      />,
    );
    expect(screen.getByText("/items")).toBeTruthy();
    const imgs = screen.getAllByRole("img") as HTMLImageElement[];
    expect(imgs.map((i) => i.alt)).toEqual(["/items 1280px ライト", "/items 1280px ダーク", "/items 390px ライト"]);
    expect(imgs[0]!.closest("a")!.getAttribute("href")).toBe("/files/tasks/1/screens/s1-1280-light.png");
  });

  it("撮影できなかったものは理由を出す", () => {
    render(<Screenshots shots={[{ name: "s1", path: "/", width: 1280, scheme: "light", file: "s1-1280-light.png", url: null, error: "タイムアウト" }]} />);
    expect(screen.getByText(/タイムアウト/)).toBeTruthy();
  });
});
