import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EventView } from "../../../src/server/api-types.ts";
import { describeEvent } from "../lib/events.ts";
import { formatTime } from "../lib/format.ts";
import { paths } from "../lib/routes.ts";
import { Link } from "../lib/router.tsx";

/**
 * イベントの時系列(docs/skeleton.md S2・S4)。
 * - order="asc": 古い順で下に追記(実行ログ)。follow なら最新に追従してスクロールする
 * - order="desc": 新しい順(ダッシュボードの実況)
 */
export function EventList({
  events,
  order = "asc",
  showTask = false,
  follow = false,
  emptyText = "イベントはまだありません",
  scroll = false,
}: {
  events: EventView[];
  order?: "asc" | "desc";
  showTask?: boolean;
  follow?: boolean;
  emptyText?: string;
  scroll?: boolean;
}) {
  // 最初に見えていたものより新しいイベントを、短くハイライトする
  const seen = useRef<number | null>(null);
  const firstId = seen.current;
  useEffect(() => {
    if (events.length) seen.current = Math.max(seen.current ?? 0, events.at(-1)!.id);
  }, [events]);

  const box = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    if (!follow) return;
    if (scroll && box.current) box.current.scrollTop = box.current.scrollHeight;
    else end.current?.scrollIntoView({ block: "nearest" });
  }, [events, follow, scroll]);

  if (events.length === 0) return <div className="panel__empty">{emptyText}</div>;
  const list = order === "asc" ? events : [...events].reverse();
  return (
    <div ref={box} className={scroll ? "events-scroll" : undefined}>
      <ul className="events">
        {list.map((e) => (
          <EventRow key={e.id} event={e} showTask={showTask} isNew={firstId !== null && e.id > firstId} />
        ))}
        <li ref={end} aria-hidden />
      </ul>
    </div>
  );
}

function EventRow({ event, showTask, isNew }: { event: EventView; showTask: boolean; isNew: boolean }) {
  const [open, setOpen] = useState(false);
  const d = describeEvent(event);
  const expandable = d.detail !== undefined && d.detail !== d.text && d.detail.trim() !== "";
  const line = (
    <span className="ev__line">
      <span className="ev__title">{d.title}</span>
      <span className="ev__text" title={d.text}>
        {d.text}
      </span>
    </span>
  );
  return (
    <li className={`ev ev--${d.tone} ${showTask ? "ev--with-task" : ""} ${isNew ? "ev--new" : ""}`}>
      <span className="ev__time">{formatTime(event.createdAt)}</span>
      {showTask &&
        (event.taskId !== null ? (
          <Link className="ev__task num" to={event.runId !== null ? paths.run(event.runId) : paths.task(event.taskId)}>
            #{event.taskId}
          </Link>
        ) : event.runId !== null ? (
          <Link className="ev__task" to={paths.run(event.runId)} title="プロジェクトの調査">
            調査
          </Link>
        ) : (
          <span className="ev__task subtle">-</span>
        ))}
      <span className="ev__icon" aria-hidden>
        {d.icon}
      </span>
      <span className="ev__body">
        {expandable ? (
          <button type="button" className="ev__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            {line}
          </button>
        ) : (
          line
        )}
        {open && <pre className="ev__detail">{d.detail}</pre>}
      </span>
    </li>
  );
}
