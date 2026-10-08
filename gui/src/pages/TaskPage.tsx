import type { ArtifactSummary, TaskDetail } from "../../../src/server/api-types.ts";
import { Commands } from "../components/Commands.tsx";
import { EventList } from "../components/EventList.tsx";
import { Crumbs } from "../components/Layout.tsx";
import { Pipeline } from "../components/Pipeline.tsx";
import { RunTable } from "../components/RunTable.tsx";
import { StateBadge, VerdictBadge } from "../components/StateBadge.tsx";
import { Async } from "../components/Status.tsx";
import { useApi, useEvents } from "../lib/api.ts";
import { isRunDetail } from "../lib/events.ts";
import { formatCost, formatDateTime, formatDuration } from "../lib/format.ts";
import { paths } from "../lib/routes.ts";
import { Link } from "../lib/router.tsx";

/** S2 タスク詳細 */
export function TaskPage({ id }: { id: number }) {
  const detail = useApi<TaskDetail>(`/api/tasks/${id}`);
  return <Async state={detail}>{(d) => <TaskView d={d} />}</Async>;
}

function TaskView({ d }: { d: TaskDetail }) {
  const t = d.task;
  return (
    <>
      <Crumbs items={[{ label: d.project.name, to: paths.project(d.project.id) }, { label: `#${t.id}` }]} />
      <h1 className="page-title">
        <span className="id num">#{t.id}</span>
        {t.title}
      </h1>
      <div className="meta">
        <StateBadge task={t} />
        {t.kind === "test_infra" && <span>テスト基盤整備</span>}
        <span>差し戻し {t.reviewRounds} 回</span>
        <span>作成 {formatDateTime(t.createdAt)}</span>
        <span>更新 {formatDateTime(t.updatedAt)}</span>
      </div>
      <Pipeline state={t.state} heldFrom={t.heldFromState} />
      <Banner d={d} />

      <div className="grid-main section">
        <div>
          <section>
            <div className="section__head">
              <h2 className="section__title">成果物</h2>
            </div>
            <div className="card">
              <ArtifactList taskId={t.id} artifacts={d.artifacts} />
            </div>
          </section>
          <section className="section">
            <div className="section__head">
              <h2 className="section__title">実行</h2>
              <span className="section__count">{d.runs.length}</span>
            </div>
            <div className="card">
              <RunTable runs={d.runs} />
            </div>
          </section>
          <Activity taskId={t.id} />
        </div>
        <aside className="side">
          <div className="card">
            <h3 className="side__title">費用と時間(合計)</h3>
            <dl className="kv num">
              <dt>費用</dt>
              <dd>{formatCost(d.totals.costUsd)}</dd>
              <dt>時間</dt>
              <dd>{formatDuration(d.totals.durationSec)}</dd>
            </dl>
          </div>
          <div className="card">
            <h3 className="side__title">worktree</h3>
            {d.worktrees.length === 0 ? (
              <span className="muted sm">まだありません</span>
            ) : (
              d.worktrees.map((w) => (
                <dl className="kv" key={w.worktreePath}>
                  <dt>リポジトリ</dt>
                  <dd>{w.repoRole}</dd>
                  <dt>パス</dt>
                  <dd className="mono">{w.worktreePath}</dd>
                  <dt>ブランチ</dt>
                  <dd className="mono">{w.branchName}</dd>
                </dl>
              ))
            )}
          </div>
          <div className="card">
            <h3 className="side__title">承認・合格</h3>
            {d.approvals.length === 0 ? (
              <span className="muted sm">まだありません</span>
            ) : (
              <ul className="events" style={{ fontSize: 12 }}>
                {d.approvals.map((a) => (
                  <li key={a.id} style={{ display: "flex", gap: 8, alignItems: "baseline", opacity: a.invalidatedAt ? 0.55 : 1 }}>
                    <span style={{ color: a.result === "approved" ? "var(--run)" : "var(--danger)" }}>{a.result === "approved" ? "✓" : "✗"}</span>
                    <span>{APPROVAL[a.kind] ?? a.kind}</span>
                    {a.commitSha && <span className="mono subtle">{a.commitSha.slice(0, 7)}</span>}
                    {a.invalidatedAt && <span className="muted">失効</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="card">
            <details open={t.body.length < 600}>
              <summary>チケット本文</summary>
              <pre className="pre-text" style={{ fontFamily: "var(--font)", fontSize: 13 }}>
                {t.body || "(本文なし)"}
              </pre>
              {t.sourceUrl && (
                <a href={t.sourceUrl} target="_blank" rel="noreferrer noopener" className="sm">
                  取り込み元 ↗
                </a>
              )}
            </details>
          </div>
        </aside>
      </div>
    </>
  );
}

const APPROVAL: Record<string, string> = { plan: "計画", design: "デザイン", final: "最終確認", review: "レビュー", qa: "QA", tests: "テストの再実行" };

function Banner({ d }: { d: TaskDetail }) {
  const t = d.task;
  if (d.runActive && t.running) {
    return (
      <div className="banner banner--running">
        <p className="banner__title">
          エージェントが実行中です(<Link to={paths.run(t.running.id)}>{t.running.role}</Link>)
        </p>
        <span className="sm">worktree を触らないでください</span>
      </div>
    );
  }
  if (!t.attention) {
    return d.nextActions.length > 0 ? (
      <div className="banner" style={{ background: "var(--surface-2)" }}>
        <Commands actions={d.nextActions} />
      </div>
    ) : null;
  }
  const tone = t.attention === "failed" ? "danger" : t.attention === "human_working" ? "human" : "attention";
  const title = {
    answer: "人の回答待ちです",
    approve_plan: "計画を確認して承認してください",
    approve_final: "成果物を確認して最終承認してください",
    failed: "失敗しました",
    human_working: "人が作業中です(エージェントは起動しません)",
  }[t.attention];
  const plan = t.attention === "approve_plan" ? latestOf(d.artifacts, "plan") : undefined;
  return (
    <div className={`banner banner--${tone}`} role="status">
      <p className="banner__title">{title}</p>
      {t.reason && <p className="banner__reason">{t.reason}</p>}
      {plan && (
        <p className="sm" style={{ margin: "0 0 4px" }}>
          <Link to={paths.artifact(t.id, plan.id)}>plan.md を読む →</Link>
        </p>
      )}
      <Commands actions={d.nextActions} />
    </div>
  );
}

const latestOf = (list: ArtifactSummary[], kind: string) => list.filter((a) => a.kind === kind).at(-1);

/** 種類ごとに最新を見せ、前の版は畳む */
function ArtifactList({ taskId, artifacts }: { taskId: number; artifacts: ArtifactSummary[] }) {
  if (artifacts.length === 0) return <div className="panel__empty">成果物はまだありません</div>;
  const kinds = [...new Set(artifacts.map((a) => a.kind))];
  return (
    <table className="table">
      <tbody>
        {kinds.map((k) => {
          const versions = artifacts.filter((a) => a.kind === k);
          const latest = versions.at(-1)!;
          return (
            <tr key={k}>
              <td className="title">
                <Link to={paths.artifact(taskId, latest.id)}>{latest.fileName}</Link>
              </td>
              <td>
                <VerdictBadge verdict={latest.verdict} />
              </td>
              <td className="sm muted">
                {versions.length > 1 && (
                  <span>
                    前の版:{" "}
                    {versions.slice(0, -1).map((v, i) => (
                      <Link key={v.id} to={paths.artifact(taskId, v.id)} style={{ marginRight: 6 }}>
                        {i + 1}
                      </Link>
                    ))}
                  </span>
                )}
              </td>
              <td className="right num sm muted nowrap">{formatDateTime(latest.createdAt)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Activity({ taskId }: { taskId: number }) {
  // タスクのイベントのうち、実行の中の細かいもの(発言・ツール)は実行ログで見る
  const { events } = useEvents({ task: taskId }, 500);
  const shown = events.filter((e) => !isRunDetail(e));
  return (
    <section className="section">
      <div className="section__head">
        <h2 className="section__title">アクティビティ</h2>
        <span className="section__count">状態の変化と出来事</span>
      </div>
      <div className="card panel__body">
        <EventList events={shown} order="desc" />
      </div>
    </section>
  );
}
