import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EventView } from "../../../src/server/api-types.ts";
import { describeEvent, type Tone } from "../lib/events.ts";
import { formatTime } from "../lib/format.ts";
import { paths } from "../lib/routes.ts";
import { Link } from "../lib/router.tsx";
import { Empty } from "./Status.tsx";
import { cn } from "@/lib/utils";

/**
 * イベントの時系列(docs/skeleton.md S2・S4)。
 * - order="asc": 古い順で下に追記(実行ログ)。follow なら最新に追従してスクロールする
 * - order="desc": 新しい順(ダッシュボードの最近の出来事)
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

  if (events.length === 0) return <Empty>{emptyText}</Empty>;
  const list = order === "asc" ? events : [...events].reverse();
  return (
    <div ref={box} className={scroll ? "max-h-[520px] overflow-y-auto" : undefined}>
      <ul className="m-0 list-none p-0 text-xs">
        {list.map((e) => (
          <EventRow key={e.id} event={e} showTask={showTask} isNew={firstId !== null && e.id > firstId} />
        ))}
        <li ref={end} aria-hidden />
      </ul>
    </div>
  );
}

const TONE: Record<Tone, { title: string; icon: string; text: string }> = {
  neutral: { title: "text-muted-foreground", icon: "text-subtle-foreground", text: "" },
  say: { title: "text-muted-foreground", icon: "text-subtle-foreground", text: "text-foreground" },
  tool: { title: "text-muted-foreground", icon: "text-subtle-foreground", text: "font-mono" },
  result: { title: "text-muted-foreground", icon: "text-subtle-foreground", text: "font-mono text-muted-foreground" },
  state: { title: "text-muted-foreground", icon: "text-subtle-foreground", text: "" },
  attention: { title: "text-attn", icon: "text-attn", text: "" },
  danger: { title: "text-destructive", icon: "text-destructive", text: "" },
  success: { title: "text-run", icon: "text-run", text: "" },
  human: { title: "text-human", icon: "text-human", text: "" },
};

/** イベントの1行。経緯(Timeline)でも、実行・人の判断の行と並べて使う */
export function EventRow({ event, showTask = false, isNew = false }: { event: EventView; showTask?: boolean; isNew?: boolean }) {
  const [open, setOpen] = useState(false);
  const d = describeEvent(event);
  const t = TONE[d.tone];
  const expandable = d.detail !== undefined && d.detail !== d.text && d.detail.trim() !== "";
  const line = (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className={cn("font-semibold whitespace-nowrap", t.title)}>{d.title}</span>
      <span className={cn("min-w-0 truncate", t.text)} title={d.text}>
        {d.text}
      </span>
    </span>
  );
  return (
    <li
      className={cn(
        "grid items-baseline gap-x-2 px-4 py-[3px] hover:bg-muted max-sm:px-3",
        showTask ? "grid-cols-[64px_42px_18px_minmax(0,1fr)] max-sm:grid-cols-[58px_30px_16px_minmax(0,1fr)]" : "grid-cols-[64px_18px_minmax(0,1fr)] max-sm:grid-cols-[58px_16px_minmax(0,1fr)]",
        isNew && "animate-flash",
      )}
    >
      <span className="font-mono text-[11.5px] text-subtle-foreground tabular-nums">{formatTime(event.createdAt)}</span>
      {showTask &&
        (event.taskId !== null ? (
          <Link className="text-muted-foreground tabular-nums no-underline" to={event.runId !== null ? paths.run(event.runId) : paths.task(event.taskId)}>
            #{event.taskId}
          </Link>
        ) : event.runId !== null ? (
          <Link className="text-muted-foreground no-underline" to={paths.run(event.runId)} title="プロジェクトの調査">
            調査
          </Link>
        ) : (
          <span className="text-subtle-foreground">-</span>
        ))}
      <span className={cn("text-center", t.icon)} aria-hidden>
        {d.icon}
      </span>
      <span className={cn("min-w-0", d.tone === "result" && "pl-4")}>
        {expandable ? (
          <button type="button" className="w-full min-w-0 cursor-pointer text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
            {line}
          </button>
        ) : (
          line
        )}
        {open && <pre className="my-1 max-h-[360px] overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap">{d.detail}</pre>}
      </span>
    </li>
  );
}
