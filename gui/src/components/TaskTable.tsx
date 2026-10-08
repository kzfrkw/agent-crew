import type { TaskSummary } from "../../../src/server/api-types.ts";
import { formatDateTime } from "../lib/format.ts";
import { paths } from "../lib/routes.ts";
import { Link, navigate } from "../lib/router.tsx";
import { StateBadge } from "./StateBadge.tsx";

/** タスクの一覧表(F3)。行のどこを押しても詳細へ */
export function TaskTable({ tasks, empty = "タスクはありません" }: { tasks: TaskSummary[]; empty?: string }) {
  if (tasks.length === 0) return <div className="panel__empty">{empty}</div>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>ID</th>
            <th>状態</th>
            <th>タイトル</th>
            <th>実行中</th>
            <th className="right">差し戻し</th>
            <th className="right">更新</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id} onClick={(e) => !(e.target as HTMLElement).closest("a") && navigate(paths.task(t.id))}>
              <td className="id num">#{t.id}</td>
              <td>
                <StateBadge task={t} />
              </td>
              <td className="title">
                <Link to={paths.task(t.id)}>{t.title}</Link>
                {t.kind === "test_infra" && <span className="muted sm"> (テスト基盤整備)</span>}
              </td>
              <td className="sm">
                {t.running ? (
                  <Link to={paths.run(t.running.id)} className="nowrap">
                    {t.running.role}
                    {t.running.model && <span className="muted">({t.running.model})</span>}
                  </Link>
                ) : (
                  <span className="subtle">-</span>
                )}
              </td>
              <td className="right num sm">{t.reviewRounds}</td>
              <td className="right num sm muted nowrap">{formatDateTime(t.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
