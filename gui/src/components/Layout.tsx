import { useEffect, type ReactNode } from "react";
import type { Overview } from "../../../src/server/api-types.ts";
import { useApi } from "../lib/api.ts";
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
          <span className="header__spacer" />
          <span className={`conn conn--${status}`} role="status">
            <span className="conn__dot" aria-hidden />
            {CONN[status]}
          </span>
          <span className="readonly" title="操作は CLI(agent-crew)で行います">読み取り専用</span>
        </div>
      </header>
      <main className="main">{children}</main>
    </>
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
