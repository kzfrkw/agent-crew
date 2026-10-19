import { describe, expect, it } from "vitest";
import { roleMeta } from "./roles.ts";

/** 役割の見せ方(すべての役割を覆っているかは tests/gui-roles.test.ts) */
describe("roleMeta", () => {
  it("名前と今していることを返す。知らない役割は名前をそのまま使う", () => {
    expect(roleMeta("reviewer")).toMatchObject({ label: "レビュワー", doing: "差分を読んでいます" });
    expect(roleMeta("someone")).toMatchObject({ label: "someone", doing: "作業しています" });
  });
});
