import type { TaskDetail } from "../../../src/server/api-types.ts";
import { paths } from "../lib/routes.ts";
import { Link } from "../lib/router.tsx";

/** 段ごとに、承認の前に読むもの(本文・スライド・批評) */
const TO_READ: Record<string, string[]> = {
  strategy: ["strategy", "strategy.slides", "critique-strategy"],
  scope: ["scope", "scope.slides", "critique-scope"],
  handoff: ["handoff", "critique-handoff"],
};

/**
 * 企画の承認で人が決めること(フェーズ9)。問いを1件ずつ箇条書きにし、誰からの問いかを添える。
 * 批評の must と should の件数、読むものへのリンクも出す。答えは承認のコメントに書く
 */
export function PlanningQuestions({
  taskId,
  q,
  artifacts,
}: {
  taskId: number;
  q: NonNullable<TaskDetail["planningQuestions"]>;
  artifacts: Pick<TaskDetail["artifacts"][number], "id" | "kind" | "fileName">[];
}) {
  const reads = (TO_READ[q.stage] ?? []).flatMap((kind) => {
    const a = artifacts.filter((x) => x.kind === kind).at(-1);
    return a ? [a] : [];
  });
  return (
    <div className="mt-1 flex flex-col gap-2">
      <p className="m-0 text-sm">決めてほしいこと(承認のコメントで答えるか、却下して書き直させてください):</p>
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
          {q.shoulds > 0 && <span>批評の should {q.shoulds} 件(参考)</span>}
        </p>
      )}
      {reads.length > 0 && (
        <p className="m-0 flex flex-wrap gap-x-4 text-xs">
          {reads.map((a) => (
            <Link key={a.id} to={paths.artifact(taskId, a.id)}>
              {a.fileName} を読む
            </Link>
          ))}
        </p>
      )}
    </div>
  );
}
