import type { RunSpec } from "../../src/runner/types.ts";
import { answer, writeArtifact, type Script } from "./scripted-runner.ts";

/** 企画の流れ(フェーズ9)の台本。書く役は成果物を書いて ready、批評担当はルーブリックの項目に答える */
export const write = (file: string): Script => answer(file, "ready", {});
export const TICKETS = [
  { title: "注文に状態を持たせる", body: "API の各注文に status を含める", acceptanceCriteria: ["GET /api/orders の各注文に status がある"] },
  { title: "一覧に状態を表示する", body: "画面に状態の列を足す", acceptanceCriteria: ["一覧に状態の列がある"] },
];
/** 入力に載ったルーブリックの項目ごとの結果(10-1b)。failMust なら最初の must を不合格にする */
export const rubricResults = (spec: RunSpec, failMust = false) => {
  const items = [...spec.prompt.matchAll(/^- \[(must|should)\] ([A-Z]+\d+):/gm)].map((m) => ({ severity: m[1]!, id: m[2]! }));
  const failed = failMust ? items.find((i) => i.severity === "must")?.id : undefined;
  return items.map((i) => ({ id: i.id, result: i.id === failed ? "fail" : "pass", evidence: `成果物の ${i.id} の箇所` }));
};
export const critic =
  (verdicts: string[] = []): Script =>
  (spec, n) => {
    const v = verdicts[n] ?? "approve";
    writeArtifact(spec, "critique.md", v, "批評");
    return { structuredOutput: { verdict: v, summary: "s", issues: v === "changes_requested" ? [{ severity: "must", title: "ペルソナが曖昧", detail: "d" }] : [], rubric: rubricResults(spec, v === "changes_requested") } };
  };
export const planningScripts = (over: Record<string, Script> = {}): Record<string, Script> => ({
  researcher: write("research.md"),
  strategist: (spec, n) => {
    writeArtifact(spec, "strategy.slides.md", "ready");
    return write("strategy.md")(spec, n);
  },
  product: write("scope.md"),
  ux: (spec, n) => {
    writeArtifact(spec, "structure.md", "ready");
    return write("skeleton.md")(spec, n);
  },
  handoff: answer("handoff.md", "ready", { tickets: TICKETS }),
  critic: critic(),
  planner: answer("plan.md", "ready", { acceptanceCriteria: ["a"], testFirstException: false, design: { architect: false, designer: false, reason: "r" } }),
  ...over,
});

