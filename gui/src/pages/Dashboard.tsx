import { useState } from "react";
import type { Overview, TaskSummary } from "../../../src/server/api-types.ts";
import { AttentionPanel } from "../components/dashboard/AttentionPanel.tsx";
import { LivePanel } from "../components/dashboard/LivePanel.tsx";
import { Async } from "../components/Status.tsx";
import { TaskTable } from "../components/TaskTable.tsx";
import { useApi } from "../lib/api.ts";
import { paths } from "../lib/routes.ts";
import { Link } from "../lib/router.tsx";

type Filter = "all" | "active" | "attention";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "active", label: "進行中" },
  { value: "attention", label: "対応待ち" },
];

const CLOSED = ["done", "cancelled"];

/** S1 ダッシュボード: 対応待ちと実況を同じ重さで並べ、その下にタスク一覧 */
export function Dashboard() {
  const overview = useApi<Overview>("/api/overview");
  return (
    <Async state={overview}>
      {(o) => (
        <>
          <div className="grid-2">
            <AttentionPanel tasks={o.tasks} />
            <LivePanel running={o.running} />
          </div>
          <TaskSection overview={o} />
        </>
      )}
    </Async>
  );
}

function TaskSection({ overview }: { overview: Overview }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [showClosed, setShowClosed] = useState(false);
  const pick = (t: TaskSummary) =>
    (showClosed || !CLOSED.includes(t.state)) &&
    (filter === "all" || (filter === "attention" ? t.attention !== null : !CLOSED.includes(t.state) && t.attention === null));
  const sort = (a: TaskSummary, b: TaskSummary) => Number(b.attention !== null) - Number(a.attention !== null) || b.id - a.id;

  if (overview.projects.length === 0) {
    return (
      <section className="section card">
        <div className="state-msg">
          プロジェクトがまだありません。<code>agent-crew project add &lt;path&gt; --name &lt;name&gt;</code> で登録します
        </div>
      </section>
    );
  }
  return (
    <section className="section">
      <div className="toolbar">
        <h2 className="section__title">タスク</h2>
        <div className="seg" role="group" aria-label="絞り込み">
          {FILTERS.map((f) => (
            <button key={f.value} type="button" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
              {f.label}
            </button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          完了・取り消しも表示
        </label>
      </div>
      {overview.projects.map((p) => {
        const tasks = overview.tasks.filter((t) => t.projectId === p.id);
        const shown = tasks.filter(pick).sort(sort);
        const hidden = tasks.length - shown.length;
        return (
          <div className="card" key={p.id} style={{ marginBottom: 16 }}>
            <div className="project-head">
              <Link to={paths.project(p.id)} className="project-head__name">
                {p.name}
              </Link>
              <span className="muted sm">
                プロファイル: {PROFILE[p.profileStatus] ?? p.profileStatus} ・ テスト基盤: {TEST_INFRA[p.testInfra] ?? p.testInfra}
              </span>
              {hidden > 0 && <span className="subtle sm">ほか {hidden} 件は非表示</span>}
            </div>
            <TaskTable tasks={shown} empty="該当するタスクはありません" />
          </div>
        );
      })}
    </section>
  );
}

export const PROFILE: Record<string, string> = { none: "未作成", draft: "承認待ち", approved: "承認済み" };
export const TEST_INFRA: Record<string, string> = { unknown: "未確認", present: "あり", insufficient: "不十分", none: "なし" };
