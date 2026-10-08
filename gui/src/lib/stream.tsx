import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { ChangeNotice, EventView } from "../../../src/server/api-types.ts";

/**
 * SSE(/api/stream)の接続を1本だけ張り、画面に配る(docs/structure.md「即時反映」)。
 * - version: タスク・実行が変わるたびに増える。useApi はこれで取り直す
 * - subscribe: 新しいイベントを受け取る
 * EventSource は切れても自動で再接続し、Last-Event-ID で取りこぼしを補う。
 */

export type StreamStatus = "connecting" | "open" | "reconnecting";
type Listener = (events: EventView[]) => void;

type StreamValue = { status: StreamStatus; version: number; subscribe: (l: Listener) => () => void };

const StreamContext = createContext<StreamValue>({ status: "connecting", version: 0, subscribe: () => () => {} });

export function StreamProvider({ children, url = "/api/stream" }: { children: ReactNode; url?: string }) {
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [version, setVersion] = useState(0);
  const listeners = useRef(new Set<Listener>());
  const subscribe = useRef((l: Listener) => {
    listeners.current.add(l);
    return () => void listeners.current.delete(l);
  }).current;

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource(url);
    let opened = false;
    es.addEventListener("hello", () => {
      setStatus("open");
      // 再接続のあいだに変わったかもしれないので取り直す
      if (opened) setVersion((v) => v + 1);
      opened = true;
    });
    es.addEventListener("events", (m) => {
      const list = JSON.parse((m as MessageEvent).data) as EventView[];
      for (const l of listeners.current) l(list);
    });
    es.addEventListener("change", (m) => {
      const c = JSON.parse((m as MessageEvent).data) as ChangeNotice;
      if (c.tasks || c.runs) setVersion((v) => v + 1);
    });
    es.onerror = () => setStatus("reconnecting");
    return () => es.close();
  }, [url]);

  return <StreamContext.Provider value={{ status, version, subscribe }}>{children}</StreamContext.Provider>;
}

export const useStream = () => useContext(StreamContext);
