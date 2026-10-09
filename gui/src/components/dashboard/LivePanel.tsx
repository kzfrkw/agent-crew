import type { Overview } from "../../../../src/server/api-types.ts";
import { useEvents } from "../../lib/api.ts";
import { isNoise } from "../../lib/events.ts";
import { elapsedSec, formatDuration } from "../../lib/format.ts";
import { paths } from "../../lib/routes.ts";
import { Link } from "../../lib/router.tsx";
import { useNow } from "../../lib/useNow.ts";
import { EventList } from "../EventList.tsx";
import { Panel } from "../Panel.tsx";
import { PulseDot } from "../StateBadge.tsx";
import { Empty } from "../Status.tsx";
import { Badge } from "@/components/ui/badge";

/** 実況(F2): 実行中の役割と、全タスクの最新イベント */
export function LivePanel({ running }: { running: Overview["running"] }) {
  const { events, loading } = useEvents({}, 60);
  const now = useNow(1000, running.length > 0);
  return (
    <Panel title="実況" count={`${running.length} 実行中`} id="live-title">
      {running.length > 0 && (
        <div className="border-b">
          {running.map((r) => (
            <Link key={r.id} to={paths.run(r.id)} className="flex min-w-0 items-center gap-2 px-4 py-3 no-underline hover:bg-muted max-sm:px-3">
              <Badge variant="running">
                <PulseDot />
                {r.role}
              </Badge>
              {r.model && <span className="text-xs text-muted-foreground">{r.model}</span>}
              <span className="min-w-0 flex-1 truncate text-xs">
                {r.taskId !== null ? (
                  <>
                    <span className="text-subtle-foreground tabular-nums">#{r.taskId}</span> {r.taskTitle}
                  </>
                ) : (
                  <span className="text-muted-foreground">プロジェクトの調査</span>
                )}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">{formatDuration(elapsedSec(r.startedAt, now))}</span>
            </Link>
          ))}
        </div>
      )}
      <div className="py-2">
        {loading && events.length === 0 ? <Empty>読み込み中…</Empty> : <EventList events={events.filter((e) => !isNoise(e))} order="desc" showTask emptyText="まだ何も起きていません" scroll />}
      </div>
    </Panel>
  );
}
