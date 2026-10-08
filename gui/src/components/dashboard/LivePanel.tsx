import type { Overview } from "../../../../src/server/api-types.ts";
import { useEvents } from "../../lib/api.ts";
import { elapsedSec, formatDuration } from "../../lib/format.ts";
import { paths } from "../../lib/routes.ts";
import { Link } from "../../lib/router.tsx";
import { useNow } from "../../lib/useNow.ts";
import { EventList } from "../EventList.tsx";

/** 実況(F2): 実行中の役割と、全タスクの最新イベント */
export function LivePanel({ running }: { running: Overview["running"] }) {
  const { events, loading } = useEvents({}, 60);
  const now = useNow(1000, running.length > 0);
  return (
    <section className="card panel" aria-labelledby="live-title">
      <div className="panel__head">
        <h2 className="panel__title" id="live-title">
          実況
        </h2>
        <span className={`count-pill`}>{running.length} 実行中</span>
      </div>
      {running.length > 0 && (
        <div style={{ borderBottom: "1px solid var(--line)" }}>
          {running.map((r) => (
            <Link key={r.id} to={paths.run(r.id)} className="attn-item" style={{ textDecoration: "none" }}>
              <div className="attn-item__top">
                <span className="badge badge--running">
                  <span className="pulse" aria-hidden />
                  {r.role}
                </span>
                {r.model && <span className="muted sm">{r.model}</span>}
                <span className="ellipsis sm" style={{ flex: 1 }}>
                  {r.taskId !== null ? (
                    <>
                      <span className="subtle num">#{r.taskId}</span> {r.taskTitle}
                    </>
                  ) : (
                    <span className="muted">プロジェクトの調査</span>
                  )}
                </span>
                <span className="num sm muted">{formatDuration(elapsedSec(r.startedAt, now))}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
      <div className="panel__body">
        {loading && events.length === 0 ? (
          <div className="panel__empty">読み込み中…</div>
        ) : (
          <EventList events={events} order="desc" showTask emptyText="まだ何も起きていません" scroll />
        )}
      </div>
    </section>
  );
}
