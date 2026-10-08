import type { ProjectDetail } from "../../../src/server/api-types.ts";
import { Crumbs } from "../components/Layout.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { RunTable } from "../components/RunTable.tsx";
import { Async } from "../components/Status.tsx";
import { TaskTable } from "../components/TaskTable.tsx";
import { useApi } from "../lib/api.ts";
import { paths } from "../lib/routes.ts";
import { PROFILE, TEST_INFRA } from "./Dashboard.tsx";

/** S5 プロジェクト */
export function ProjectPage({ id }: { id: number }) {
  const detail = useApi<ProjectDetail>(`/api/projects/${id}`);
  return <Async state={detail}>{(d) => <ProjectView d={d} />}</Async>;
}

function ProjectView({ d }: { d: ProjectDetail }) {
  const p = d.project;
  return (
    <>
      <Crumbs items={[{ label: "ダッシュボード", to: paths.dashboard() }, { label: p.name }]} />
      <h1 className="page-title">{p.name}</h1>
      <div className="meta">
        <span className={`badge ${p.profileStatus === "approved" ? "badge--done" : "badge--attention"}`}>
          プロファイル: {PROFILE[p.profileStatus] ?? p.profileStatus}
        </span>
        <span className={`badge ${p.testInfra === "present" ? "badge--done" : "badge--plain"}`}>テスト基盤: {TEST_INFRA[p.testInfra] ?? p.testInfra}</span>
        {p.allowWithoutTests && <span>テスト基盤の整備前の通常タスクを許可</span>}
      </div>
      {p.profileStatus === "draft" && (
        <div className="banner banner--attention">
          <p className="banner__title">プロファイルの確認と承認が必要です</p>
          <code>agent-crew project approve {p.name}</code>
        </div>
      )}

      <div className="grid-main section">
        <div>
          <section>
            <div className="section__head">
              <h2 className="section__title">タスク</h2>
              <span className="section__count">{d.tasks.length}</span>
            </div>
            <div className="card">
              <TaskTable tasks={[...d.tasks].sort((a, b) => b.id - a.id)} />
            </div>
          </section>
          <section className="section">
            <div className="section__head">
              <h2 className="section__title">プロファイル</h2>
              <span className="section__count">プロジェクト把握担当がまとめた前提</span>
            </div>
            <div className="card viewer__doc">
              {d.profileMd ? (
                <Markdown text={d.profileMd} />
              ) : d.profile ? (
                <pre className="pre-text">{JSON.stringify(d.profile, null, 2)}</pre>
              ) : (
                <span className="muted">まだありません</span>
              )}
            </div>
          </section>
          <section className="section">
            <div className="section__head">
              <h2 className="section__title">設計判断ログ</h2>
              <span className="section__count">decisions.md</span>
            </div>
            <div className="card viewer__doc">{d.decisionsMd ? <Markdown text={d.decisionsMd} /> : <span className="muted">まだありません</span>}</div>
          </section>
        </div>
        <aside className="side">
          <div className="card">
            <h3 className="side__title">リポジトリ</h3>
            {d.repos.map((r) => (
              <dl className="kv" key={r.id}>
                <dt>役目</dt>
                <dd>{r.role}</dd>
                <dt>パス</dt>
                <dd className="mono">{r.path}</dd>
                <dt>既定</dt>
                <dd className="mono">{r.defaultBranch}</dd>
              </dl>
            ))}
          </div>
          <div className="card" style={{ padding: 0 }}>
            <h3 className="side__title" style={{ padding: "12px 16px 0" }}>
              プロジェクト把握担当の実行
            </h3>
            <RunTable runs={d.runs} />
          </div>
        </aside>
      </div>
    </>
  );
}
