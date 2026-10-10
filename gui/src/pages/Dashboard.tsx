import { useState } from "react";
import type { Overview, TaskSummary } from "../../../src/server/api-types.ts";
import { AttentionPanel } from "../components/dashboard/AttentionPanel.tsx";
import { LivePanel } from "../components/dashboard/LivePanel.tsx";
import { Async, Empty } from "../components/Status.tsx";
import { TaskTable } from "../components/TaskTable.tsx";
import { useApi } from "../lib/api.ts";
import { paths } from "../lib/routes.ts";
import { Link } from "../lib/router.tsx";
import { countByFilter, matchesFilter, type Filter } from "../lib/taskFilter.ts";
import { cn } from "@/lib/utils";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "active", label: "進行中" },
  { value: "attention", label: "対応待ち" },
];

/** S1 ダッシュボード: 対応待ちと実況を同じ重さで並べ、その下にタスク一覧 */
export function Dashboard() {
  const overview = useApi<Overview>("/api/overview");
  return (
    <Async state={overview}>
      {(o) => (
        <>
          <div className="grid grid-cols-1 gap-4 min-[880px]:grid-cols-2">
            <AttentionPanel tasks={o.tasks} onDone={overview.reload} operable={o.worker.state !== "disabled"} />
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
  const pick = (t: TaskSummary) => matchesFilter(t, filter, showClosed);
  const counts = countByFilter(overview.tasks, showClosed);
  const sort = (a: TaskSummary, b: TaskSummary) => Number(b.attention !== null) - Number(a.attention !== null) || b.id - a.id;

  if (overview.projects.length === 0) {
    return (
      <section className="mt-6 rounded-lg border bg-card">
        <Empty>
          プロジェクトがまだありません。<code className="font-mono">agent-crew project add &lt;path&gt; --name &lt;name&gt;</code> で登録します
        </Empty>
      </section>
    );
  }
  return (
    <section className="mt-6">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="m-0 text-[15px] font-semibold">タスク</h2>
        <div className="inline-flex shrink-0 overflow-hidden rounded-md border bg-card" role="group" aria-label="絞り込み">
          {FILTERS.map((f, i) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
              className={cn(
                "cursor-pointer whitespace-nowrap px-3 py-0.5 text-xs text-muted-foreground",
                i > 0 && "border-l",
                filter === f.value && "bg-muted font-semibold text-foreground",
              )}
            >
              {f.label}{" "}
              <span className="ml-1 tabular-nums">
                {counts[f.value]}
                <span className="sr-only">件</span>
              </span>
            </button>
          ))}
        </div>
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" className="accent-foreground" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          完了・取り消しも表示
        </label>
      </div>
      <div className="flex flex-col gap-4">
        {overview.projects.map((p) => {
          const tasks = overview.tasks.filter((t) => t.projectId === p.id);
          const shown = tasks.filter(pick).sort(sort);
          const hidden = tasks.length - shown.length;
          return (
            <div className="rounded-lg border bg-card" key={p.id}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-4 py-3 max-sm:px-3">
                <Link to={paths.project(p.id)} className="font-semibold no-underline hover:underline">
                  {p.name}
                </Link>
                <span className="text-xs text-muted-foreground">
                  プロファイル: {PROFILE[p.profileStatus] ?? p.profileStatus} ・ テスト基盤: {TEST_INFRA[p.testInfra] ?? p.testInfra}
                </span>
                {hidden > 0 && <span className="text-xs text-subtle-foreground">ほか {hidden} 件は非表示</span>}
              </div>
              <TaskTable tasks={shown} empty="該当するタスクはありません" />
            </div>
          );
        })}
      </div>
    </section>
  );
}

export const PROFILE: Record<string, string> = { none: "未作成", draft: "承認待ち", approved: "承認済み" };
export const TEST_INFRA: Record<string, string> = { unknown: "未確認", present: "あり", insufficient: "不十分", none: "なし" };
