import { useEffect, useState, type ReactNode } from "react";
import type { Overview, WorkerView } from "../../../src/server/api-types.ts";
import { postJson, useApi } from "../lib/api.ts";
import { paths } from "../lib/routes.ts";
import { Link, navigate } from "../lib/router.tsx";
import { useStream } from "../lib/stream.tsx";

const CONN = { connecting: "接続中…", open: "リアルタイム", reconnecting: "再接続中…" };

/** 共通ヘッダー(docs/skeleton.md「ナビゲーション」)。対応待ちの件数をタブのタイトルにも出す */
export function Layout({ children, projectId }: { children: ReactNode; projectId?: number }) {
  const { status } = useStream();
  const overview = useApi<Overview>("/api/overview");
  const projects = overview.data?.projects ?? [];
  const attention = overview.data?.tasks.filter((t) => t.attention && t.attention !== "human_working").length ?? 0;

  useEffect(() => {
    document.title = attention > 0 ? `(${attention}) agent-crew` : "agent-crew";
  }, [attention]);

  return (
    <>
      <header className="header">
        <div className="header__inner">
          <Link to={paths.dashboard()} className="logo">
            <img src="/favicon.svg" alt="" />
            agent-crew
          </Link>
          {projects.length > 0 && (
            <select
              className="select"
              aria-label="プロジェクト"
              value={projectId ?? ""}
              onChange={(e) => navigate(e.target.value ? paths.project(Number(e.target.value)) : paths.dashboard())}
            >
              <option value="">すべてのプロジェクト</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <Link to={paths.newTask()} className="btn btn--sm">
            + チケット
          </Link>
          <span className="header__spacer" />
          {overview.data && <WorkerSwitch worker={overview.data.worker} onChange={overview.reload} />}
          <span className={`conn conn--${status}`} role="status">
            <span className="conn__dot" aria-hidden title={CONN[status]} />
            <span className="conn__label">{CONN[status]}</span>
          </span>
          {overview.data?.worker.state === "disabled" && (
            <span className="readonly" title="serve --no-worker で起動しています。操作は CLI(agent-crew)で行います">
              読み取り専用
            </span>
          )}
        </div>
      </header>
      <main className="main">{children}</main>
    </>
  );
}

const WORKER = {
  running: { label: "自動実行中", button: "一時停止" },
  paused: { label: "一時停止中", button: "再開" },
  locked: { label: "CLI の run が実行中", button: null },
  disabled: { label: "", button: null },
};

/** 常駐ワーカーの状態と、一時停止・再開(G1・G2) */
function WorkerSwitch({ worker, onChange }: { worker: WorkerView; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  if (worker.state === "disabled") return null;
  const w = WORKER[worker.state];
  const toggle = async () => {
    setBusy(true);
    try {
      await postJson("/api/worker", { paused: worker.state === "running" });
      onChange();
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className={`worker worker--${worker.state}`}>
      <span className="worker__dot" aria-hidden />
      <span className="worker__label">
        {w.label}
        {worker.active.length > 0 && <span className="muted">({worker.active.length})</span>}
      </span>
      {w.button && (
        <button type="button" className="btn btn--sm" onClick={toggle} disabled={busy} title={worker.state === "running" ? "新しい役割を起動しません(実行中のものは最後まで動きます)" : undefined}>
          {w.button}
        </button>
      )}
    </span>
  );
}

export function Crumbs({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <nav className="crumbs" aria-label="パンくず">
      {items.map((it, i) => (
        <span key={i}>
          {i > 0 && <span className="subtle">/ </span>}
          {it.to ? <Link to={it.to}>{it.label}</Link> : <span>{it.label}</span>}
        </span>
      ))}
    </nav>
  );
}
