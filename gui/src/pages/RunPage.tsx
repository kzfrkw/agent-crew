import { useState } from "react";
import type { RunDetail } from "../../../src/server/api-types.ts";
import { EventList } from "../components/EventList.tsx";
import { Crumbs, Meta, PageTitle } from "../components/Layout.tsx";
import { RunStateBadge, VerdictBadge } from "../components/StateBadge.tsx";
import { Async, Empty } from "../components/Status.tsx";
import { useApi, useEvents } from "../lib/api.ts";
import { elapsedSec, formatCost, formatDateTime, formatDuration } from "../lib/format.ts";
import { paths } from "../lib/routes.ts";
import { Link } from "../lib/router.tsx";
import { useNow } from "../lib/useNow.ts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

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
      <PageTitle id={r.id}>{r.role}</PageTitle>
      <Meta>
        <RunStateBadge state={r.state} />
        {r.model && <span>{r.model}</span>}
        <span className="tabular-nums">時間 {formatDuration(running ? elapsedSec(r.startedAt, now) : r.durationSec)}</span>
        <span className="tabular-nums">費用 {formatCost(r.costUsd)}</span>
        <span className="inline-flex items-center gap-1.5">
          判定 <VerdictBadge verdict={r.verdict} />
        </span>
        <span className="tabular-nums">開始 {formatDateTime(r.startedAt)}</span>
      </Meta>
      {r.error && (
        <Alert variant="danger" role="status" className="mt-4">
          <AlertTitle className="font-semibold">エラー</AlertTitle>
          <AlertDescription className="break-words whitespace-pre-wrap text-foreground">{r.error}</AlertDescription>
        </Alert>
      )}
      {(r.summary || d.artifacts.length > 0 || d.streamUrl) && (
        <div className="mt-6 rounded-lg border bg-card px-4 py-3">
          <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            {r.summary && (
              <>
                <dt className="text-muted-foreground">要約</dt>
                <dd className="m-0 whitespace-pre-wrap">{r.summary}</dd>
              </>
            )}
            {d.artifacts.length > 0 && d.task && (
              <>
                <dt className="text-muted-foreground">成果物</dt>
                <dd className="m-0 flex flex-wrap gap-3">
                  {d.artifacts.map((a) => (
                    <Link key={a.id} to={paths.artifact(d.task!.id, a.id)}>
                      {a.fileName}
                    </Link>
                  ))}
                </dd>
              </>
            )}
            {d.streamUrl && (
              <>
                <dt className="text-muted-foreground">生ログ</dt>
                <dd className="m-0">
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
    <section className="mt-6">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="m-0 text-[15px] font-semibold">ログ</h2>
        <span className="text-xs text-muted-foreground">{events.length} 件</span>
        {running && (
          <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" className="accent-foreground" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            最新に追従
          </label>
        )}
      </div>
      <div className="rounded-lg border bg-card py-2">{loading && events.length === 0 ? <Empty>読み込み中…</Empty> : <EventList events={events} follow={running && follow} />}</div>
    </section>
  );
}
