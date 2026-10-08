import { useState } from "react";
import type { RunDetail } from "../../../src/server/api-types.ts";
import { EventList } from "../components/EventList.tsx";
import { Crumbs } from "../components/Layout.tsx";
import { RunStateBadge, VerdictBadge } from "../components/StateBadge.tsx";
import { Async } from "../components/Status.tsx";
import { useApi, useEvents } from "../lib/api.ts";
import { elapsedSec, formatCost, formatDateTime, formatDuration } from "../lib/format.ts";
import { paths } from "../lib/routes.ts";
import { Link } from "../lib/router.tsx";
import { useNow } from "../lib/useNow.ts";

/** S4 実行ログ */
export function RunPage({ id }: { id: number }) {
  const detail = useApi<RunDetail>(`/api/runs/${id}`);
  return <Async state={detail}>{(d) => <RunView d={d} />}</Async>;
}

function RunView({ d }: { d: RunDetail }) {
  const r = d.run;
  const running = r.state === "running";
  const now = useNow(1000, running);
  const crumbs = [
    ...(d.project ? [{ label: d.project.name, to: paths.project(d.project.id) }] : []),
    ...(d.task ? [{ label: `#${d.task.id} ${d.task.title}`, to: paths.task(d.task.id) }] : []),
    { label: `実行 #${r.id}` },
  ];
  return (
    <>
      <Crumbs items={crumbs} />
      <h1 className="page-title">
        <span className="id num">#{r.id}</span>
        {r.role}
      </h1>
      <div className="meta">
        <RunStateBadge state={r.state} />
        {r.model && <span>{r.model}</span>}
        <span className="num">時間 {formatDuration(running ? elapsedSec(r.startedAt, now) : r.durationSec)}</span>
        <span className="num">費用 {formatCost(r.costUsd)}</span>
        <span>
          判定 <VerdictBadge verdict={r.verdict} />
        </span>
        <span className="num">開始 {formatDateTime(r.startedAt)}</span>
      </div>
      {r.error && (
        <div className="banner banner--danger">
          <p className="banner__title">エラー</p>
          <p className="banner__reason" style={{ margin: 0 }}>
            {r.error}
          </p>
        </div>
      )}
      {(r.summary || d.artifacts.length > 0 || d.streamUrl) && (
        <div className="card section" style={{ padding: "12px 16px" }}>
          <dl className="kv">
            {r.summary && (
              <>
                <dt>要約</dt>
                <dd style={{ whiteSpace: "pre-wrap" }}>{r.summary}</dd>
              </>
            )}
            {d.artifacts.length > 0 && d.task && (
              <>
                <dt>成果物</dt>
                <dd>
                  {d.artifacts.map((a) => (
                    <Link key={a.id} to={paths.artifact(d.task!.id, a.id)} style={{ marginRight: 12 }}>
                      {a.fileName}
                    </Link>
                  ))}
                </dd>
              </>
            )}
            {d.streamUrl && (
              <>
                <dt>生ログ</dt>
                <dd>
                  <a href={d.streamUrl} target="_blank" rel="noreferrer">
                    stream.jsonl ↗
                  </a>
                </dd>
              </>
            )}
          </dl>
        </div>
      )}
      <Log runId={r.id} running={running} />
    </>
  );
}

function Log({ runId, running }: { runId: number; running: boolean }) {
  const { events, loading } = useEvents({ run: runId }, 1000);
  const [follow, setFollow] = useState(true);
  return (
    <section className="section">
      <div className="toolbar">
        <h2 className="section__title">ログ</h2>
        <span className="section__count">{events.length} 件</span>
        {running && (
          <label className="check follow">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            最新に追従
          </label>
        )}
      </div>
      <div className="card panel__body">
        {loading && events.length === 0 ? <div className="panel__empty">読み込み中…</div> : <EventList events={events} follow={running && follow} />}
      </div>
    </section>
  );
}
