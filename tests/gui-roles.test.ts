import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROLE_META } from "../gui/src/lib/roles.ts";

/** GUI の役割の見せ方(日本語の名前、キャラクター)が、roles/ の役割をすべて覆っているか */
describe("GUI の役割の見せ方", () => {
  it("roles/ にあるすべての役割に、日本語の名前・今していること・道具・動きがある", () => {
    const names = readdirSync(new URL("../roles/", import.meta.url)).filter((f) => f.endsWith(".md") && f !== "_common.md").map((f) => f.replace(/\.md$/, ""));
    expect(names.length).toBeGreaterThan(10);
    for (const n of names) {
      const m = ROLE_META[n];
      expect(m, n).toBeDefined();
      expect(m!.label).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(m!.doing).toMatch(/います$/);
    }
  });
});
