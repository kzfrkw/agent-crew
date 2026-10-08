import { useEffect, useRef, useState } from "react";
import type { EventView, EventsPage } from "../../../src/server/api-types.ts";
import { useStream } from "./stream.tsx";

/** 読み取り API の取得(docs/structure.md)。変化の通知(SSE)で自動的に取り直す */

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  return (await res.json()) as T;
}

export type ApiState<T> = { data: T | undefined; error: ApiError | Error | undefined; loading: boolean };

/** path が変わったとき、SSE で変化を受けたときに取り直す。取り直しのあいだは前のデータを見せる */
export function useApi<T>(path: string | null): ApiState<T> {
  const { version } = useStream();
  const [state, setState] = useState<ApiState<T>>({ data: undefined, error: undefined, loading: path !== null });
  const current = useRef(path);

  useEffect(() => {
    if (current.current !== path) {
      current.current = path;
      setState({ data: undefined, error: undefined, loading: path !== null });
    }
    if (path === null) return;
    let alive = true;
    getJson<T>(path).then(
      (data) => alive && setState({ data, error: undefined, loading: false }),
      (error: Error) => alive && setState((s) => ({ data: s.data, error, loading: false })),
    );
    return () => {
      alive = false;
    };
  }, [path, version]);

  return state;
}

/**
 * イベントの一覧。最初に API で最新の limit 件を取り、以後は SSE で届いたものを足す。
 * filter に合うものだけを、id 昇順で最大 limit 件持つ。
 */
export function useEvents(filter: { task?: number; run?: number }, limit = 200): { events: EventView[]; loading: boolean } {
  const { subscribe } = useStream();
  const [events, setEvents] = useState<EventView[]>([]);
  const [loading, setLoading] = useState(true);
  const key = `${filter.task ?? ""}:${filter.run ?? ""}:${limit}`;

  useEffect(() => {
    let alive = true;
    const pending: EventView[] = [];
    let loaded = false;
    const match = (e: EventView) => (filter.task === undefined || e.taskId === filter.task) && (filter.run === undefined || e.runId === filter.run);
    const merge = (base: EventView[], add: EventView[]) => {
      const last = base.at(-1)?.id ?? 0;
      const next = [...base, ...add.filter((e) => e.id > last && match(e))];
      return next.length > limit ? next.slice(next.length - limit) : next;
    };
    setEvents([]);
    setLoading(true);
    const unsubscribe = subscribe((list) => {
      if (!loaded) pending.push(...list);
      else setEvents((cur) => merge(cur, list));
    });
    const q = new URLSearchParams({ limit: String(limit) });
    if (filter.task !== undefined) q.set("task", String(filter.task));
    if (filter.run !== undefined) q.set("run", String(filter.run));
    getJson<EventsPage>(`/api/events?${q}`).then(
      (page) => {
        if (!alive) return;
        loaded = true;
        setEvents(merge(page.events, pending));
        setLoading(false);
      },
      () => alive && setLoading(false),
    );
    return () => {
      alive = false;
      unsubscribe();
    };
    // filter は key に含めている
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, subscribe]);

  return { events, loading };
}
