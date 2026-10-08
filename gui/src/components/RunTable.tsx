import type { RunSummary } from "../../../src/server/api-types.ts";
import { elapsedSec, formatCost, formatDateTime, formatDuration } from "../lib/format.ts";
import { paths } from "../lib/routes.ts";
import { Link, navigate } from "../lib/router.tsx";
import { useNow } from "../lib/useNow.ts";
import { RunStateBadge, VerdictBadge } from "./StateBadge.tsx";

/** 実行の一覧(S2・S5) */
export function RunTable({ runs }: { runs: RunSummary[] }) {
  const now = useNow(1000, runs.some((r) => r.state === "running"));
  if (runs.length === 0) return <div className="panel__empty">実行はまだありません</div>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>役割</th>
            <th>状態</th>
            <th>判定</th>
            <th className="right">費用</th>
            <th className="right">時間</th>
            <th className="right">開始</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} onClick={(e) => !(e.target as HTMLElement).closest("a") && navigate(paths.run(r.id))}>
              <td className="id num">
                <Link to={paths.run(r.id)}>#{r.id}</Link>
              </td>
              <td>
                <Link to={paths.run(r.id)} className="title">
                  {r.role}
                </Link>{" "}
                {r.model && <span className="muted sm">{r.model}</span>}
              </td>
              <td>
                <RunStateBadge state={r.state} />
              </td>
              <td>
                <VerdictBadge verdict={r.verdict} />
              </td>
              <td className="right num sm">{formatCost(r.costUsd)}</td>
              <td className="right num sm">{formatDuration(r.state === "running" ? elapsedSec(r.startedAt, now) : r.durationSec)}</td>
              <td className="right num sm muted nowrap">{formatDateTime(r.startedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
