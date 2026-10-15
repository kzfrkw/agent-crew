import { FileTextIcon } from "lucide-react";
import type { TaskDetail, TaskState } from "../../../src/server/api-types.ts";
import { paths } from "../lib/routes.ts";
import { Link } from "../lib/router.tsx";
import { Button } from "@/components/ui/button";

type Doc = { kind: string; what: string };
/** 承認の段ごとの、何を承認するか(見出し)と、読むもの(先頭が本文) */
const STAGES: Partial<Record<TaskState, { title: string; docs: Doc[] }>> = {
  awaiting_strategy_approval: {
    title: "戦略(strategy.md)を確認して承認してください",
    docs: [
      { kind: "strategy", what: "戦略の本文(誰の・何の課題を・どう解くか、ペルソナ、成功の指標)" },
      { kind: "strategy.slides", what: "同じ内容のスライド(Marp)" },
      { kind: "critique-strategy", what: "批評担当の点検結果" },
    ],
  },
  awaiting_scope_approval: {
    title: "要件(scope.md)を確認して承認してください",
    docs: [
      { kind: "scope", what: "要件の本文(機能一覧、ユーザーストーリー、スコープ外、優先度)" },
      { kind: "scope.slides", what: "同じ内容のスライド(Marp)" },
      { kind: "critique-scope", what: "批評担当の点検結果" },
    ],
  },
  awaiting_handoff_approval: {
    title: "開発のチケット(handoff.md)を確認して承認してください",
    docs: [
      { kind: "handoff", what: "開発のチケットの一覧と順番(承認するとこのとおりにタスクを作る)" },
      { kind: "skeleton", what: "画面のワイヤーフレーム" },
      { kind: "structure", what: "画面一覧・画面遷移・データモデル" },
      { kind: "critique-handoff", what: "批評担当の点検結果" },
    ],
  },
};

export const planningApprovalTitle = (state: TaskState): string => STAGES[state]?.title ?? "企画の成果物を確認して承認してください";

/**
 * 企画の承認の欄(フェーズ9)。まず読む本文を目立たせ、補助の資料(スライド、批評)を説明つきで並べる。
 * 人に決めてほしいことがあれば、その下に1件ずつ箇条書きにする(誰からの問いか、批評の must・should の件数つき)
 */
export function PlanningReview({
  taskId,
  state,
  q,
  artifacts,
}: {
  taskId: number;
  state: TaskState;
  q: TaskDetail["planningQuestions"];
  artifacts: Pick<TaskDetail["artifacts"][number], "id" | "kind" | "fileName">[];
}) {
  const docs = (STAGES[state]?.docs ?? []).flatMap((d) => {
    const a = artifacts.filter((x) => x.kind === d.kind).at(-1);
    return a ? [{ ...d, a }] : [];
  });
  const [main, ...rest] = docs;
  return (
    <div className="mt-1 flex flex-col gap-3">
      {main && (
        <div className="flex flex-col gap-1.5">
          <p className="m-0 text-xs font-semibold text-muted-foreground">まず読むもの</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm">
              <Link to={paths.artifact(taskId, main.a.id)} className="no-underline">
                <FileTextIcon />
                {main.a.fileName} を読む
              </Link>
            </Button>
            <span className="text-xs text-muted-foreground">{main.what}</span>
          </div>
          {rest.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs">
              {rest.map((d) => (
                <li key={d.a.id}>
                  <Link to={paths.artifact(taskId, d.a.id)}>{d.a.fileName}</Link>
                  <span className="ml-2 text-muted-foreground">{d.what}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {q && (
        <div className="flex flex-col gap-1.5">
          <p className="m-0 text-xs font-semibold text-muted-foreground">決めてほしいこと(承認のコメントで答えるか、却下して書き直させてください)</p>
          <ol className="m-0 flex flex-col gap-1.5 pl-5">
            {q.questions.map((x, i) => (
              <li key={i} className="text-sm leading-relaxed">
                {x.text}
                <span className="ml-2 text-xs text-muted-foreground">— {x.from}</span>
              </li>
            ))}
          </ol>
          {(q.musts.length > 0 || q.shoulds > 0) && (
            <p className="m-0 text-xs text-muted-foreground">
              {q.musts.length > 0 && <span>批評の must: {q.musts.join(" / ")}。</span>}
              {q.shoulds > 0 && <span>批評の should {q.shoulds} 件(参考。点検結果に詳しく書いてあります)</span>}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
