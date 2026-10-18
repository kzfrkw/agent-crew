import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRubrics, type Rubric } from "../src/roles/rubrics.ts";
import { checkRubric } from "../src/orchestrator/rubric-check.ts";
import { tempDir } from "./helpers/gitrepo.ts";

/** 設計メモ v0.22(フェーズ10-1b): 判定を測れるルーブリックで行う */

function rubricsDir(files: Record<string, string>): string {
  const dir = tempDir("agent-crew-rubrics-");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

const valid = `---
name: planning-research
description: 調査の段
---
項目以外の行は説明として読み飛ばす

- [must] RS1: 主張ごとに出典がある
- [should] RS2: 制約が書かれている
- [must] RS3: 示唆が3〜5点ある
`;

describe("loadRubrics", () => {
  it("frontmatter と項目(重大度、ID、文)を読む。README は読まない", () => {
    const r = loadRubrics(rubricsDir({ "planning-research.md": valid, "README.md": "# 説明" }));
    expect([...r.keys()]).toEqual(["planning-research"]);
    expect(r.get("planning-research")).toEqual({
      name: "planning-research",
      description: "調査の段",
      items: [
        { id: "RS1", severity: "must", text: "主張ごとに出典がある" },
        { id: "RS2", severity: "should", text: "制約が書かれている" },
        { id: "RS3", severity: "must", text: "示唆が3〜5点ある" },
      ],
    });
  });

  it("ファイル名と name の不一致、ID の重複、must が無い、11項目以上は拒否する", () => {
    expect(() => loadRubrics(rubricsDir({ "planning-scope.md": valid }))).toThrow(/planning-scope\.md/);
    expect(() => loadRubrics(rubricsDir({ "planning-research.md": valid.replace("RS3", "RS1") }))).toThrow(/RS1/);
    expect(() => loadRubrics(rubricsDir({ "planning-research.md": valid.replaceAll("[must]", "[should]") }))).toThrow(/must/);
    const many = Array.from({ length: 11 }, (_, i) => `- [must] X${i + 1}: 項目`).join("\n");
    expect(() => loadRubrics(rubricsDir({ "planning-research.md": `---\nname: planning-research\ndescription: d\n---\n${many}\n` }))).toThrow(/10/);
  });

  it("同梱のルーブリック: 企画の5段がそろい、どれも10項目以内で must がある", () => {
    const r = loadRubrics();
    for (const s of ["research", "strategy", "scope", "ux", "handoff"]) {
      const rub = r.get(`planning-${s}`)!;
      expect(rub, s).toBeDefined();
      expect(rub.items.length).toBeLessThanOrEqual(10);
      expect(rub.items.some((i) => i.severity === "must")).toBe(true);
    }
  });
});

describe("checkRubric(判定と項目ごとの結果の一致)", () => {
  const rubric: Rubric = {
    name: "planning-research",
    description: "",
    items: [
      { id: "RS1", severity: "must", text: "a" },
      { id: "RS2", severity: "should", text: "b" },
      { id: "RS3", severity: "must", text: "c" },
    ],
  };
  const res = (o: Record<string, "pass" | "fail"> = {}) => ["RS1", "RS2", "RS3"].map((id) => ({ id, result: o[id] ?? "pass", evidence: `research.md の ${id}` }));

  it("must がすべて合格なら approve、不合格の must と should を返す", () => {
    expect(checkRubric("approve", rubric, res({ RS2: "fail" }))).toEqual({ ok: true, mustFailed: [], shouldFailed: ["RS2"] });
    expect(checkRubric("changes_requested", rubric, res({ RS3: "fail" }))).toEqual({ ok: true, mustFailed: ["RS3"], shouldFailed: [] });
  });

  it("must の不合格があるのに approve、must の不合格が無いのに changes_requested は食い違い", () => {
    expect(checkRubric("approve", rubric, res({ RS1: "fail" }))).toMatchObject({ ok: false, reason: expect.stringMatching(/RS1/) });
    expect(checkRubric("changes_requested", rubric, res({ RS2: "fail" }))).toMatchObject({ ok: false, reason: expect.stringMatching(/must/) });
  });

  it("need_human は項目の結果を問わない(人の判断が要る論点は別にある)", () => {
    expect(checkRubric("need_human", rubric, res({ RS1: "fail" }))).toEqual({ ok: true, mustFailed: ["RS1"], shouldFailed: [] });
  });

  it("項目の抜け、重複、ルーブリックに無い ID、根拠の無い結果は不正", () => {
    expect(checkRubric("approve", rubric, res().slice(0, 2))).toMatchObject({ ok: false, reason: expect.stringMatching(/RS3/) });
    expect(checkRubric("approve", rubric, [...res(), res()[0]!])).toMatchObject({ ok: false, reason: expect.stringMatching(/RS1/) });
    expect(checkRubric("approve", rubric, [...res(), { id: "XX9", result: "pass", evidence: "e" }])).toMatchObject({ ok: false, reason: expect.stringMatching(/XX9/) });
    expect(checkRubric("approve", rubric, res().map((r) => (r.id === "RS2" ? { ...r, evidence: " " } : r)))).toMatchObject({ ok: false, reason: expect.stringMatching(/RS2/) });
  });
});
