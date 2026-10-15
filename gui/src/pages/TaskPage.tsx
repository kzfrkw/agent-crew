import { ChevronRightIcon } from "lucide-react";
import type { ArtifactSummary, TaskDetail } from "../../../src/server/api-types.ts";
import { ActionPanel } from "../components/ActionPanel.tsx";
import { Commands } from "../components/Commands.tsx";
import { EventList } from "../components/EventList.tsx";
import { Crumbs, Meta, PageTitle } from "../components/Layout.tsx";
import { SectionHead } from "../components/Panel.tsx";
import { Pipeline } from "../components/Pipeline.tsx";
import { RunTable } from "../components/RunTable.tsx";
import { Screenshots } from "../components/Screenshots.tsx";
import { Report } from "../components/Report.tsx";
import { RetroPanel } from "../components/Retro.tsx";
import { FinalReview } from "../components/FinalReview.tsx";
import { PlanningReview, planningApprovalTitle } from "../components/PlanningQuestions.tsx";
import { StateBadge, VerdictBadge } from "../components/StateBadge.tsx";
import { Async, Empty } from "../components/Status.tsx";
import { useApi, useEvents } from "../lib/api.ts";
import { isRunDetail } from "../lib/events.ts";
import { formatCost, formatDateTime, formatDuration } from "../lib/format.ts";
import { paths } from "../lib/routes.ts";
import { Link } from "../lib/router.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/** S2 タスク詳細 */
export function TaskPage({ id }: { id: number }) {
  const detail = useApi<TaskDetail>(`/api/tasks/${id}`);
  return <Async state={detail}>{(d) => <TaskView d={d} onDone={detail.reload} />}</Async>;
}

function TaskView({ d, onDone }: { d: TaskDetail; onDone: () => void }) {
  const t = d.task;
  return (
    <>
      <Crumbs items={[{ label: d.project.name, to: paths.project(d.project.id) }, { label: `#${t.id}` }]} />
      <PageTitle id={t.id}>{t.title}</PageTitle>
      <Meta>
        <StateBadge task={t} />
        {t.kind === "test_infra" && <span>テスト基盤整備</span>}
        {d.parent && (
          <span>
            分割の親: <Link to={paths.task(d.parent.id)}>#{d.parent.id} {d.parent.title}</Link>
          </span>
        )}
        <span>差し戻し {t.reviewRounds} 回</span>
        <span>作成 {formatDateTime(t.createdAt)}</span>
        <span>更新 {formatDateTime(t.updatedAt)}</span>
      </Meta>
      <Pipeline state={t.state} heldFrom={t.heldFromState} design={t.design} kind={t.kind} />
      <Banner d={d} onDone={onDone} />

      <div className="mt-6 grid grid-cols-1 items-start gap-6 min-[880px]:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-6">
          {d.children.length > 0 && (
            <section>
              <SectionHead title="子タスク" note="分割して順に進めます(2つ目以降は前の子のブランチがベース)" />
              <ol className="m-0 flex list-none flex-col divide-y rounded-lg border bg-card p-0">
                {d.children.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                    <span className="text-xs text-muted-foreground tabular-nums">{c.seq}</span>
                    <Link to={paths.task(c.id)} className="min-w-0 flex-1 truncate">
                      #{c.id} {c.title}
                    </Link>
                    <span className="text-xs whitespace-nowrap text-muted-foreground">{c.stateLabel}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}
          <section>
            <SectionHead title="成果物" />
            <div className="rounded-lg border bg-card">
              <ArtifactList taskId={t.id} artifacts={d.artifacts} />
            </div>
          </section>
          {d.screenshots.length > 0 && (
            <section>
              <SectionHead title="撮影した画面" note="実装後のデザインレビューの材料" />
              <div className="rounded-lg border bg-card p-4">
                <Screenshots shots={d.screenshots} />
              </div>
            </section>
          )}
          {d.retro && (
            <section>
              <SectionHead title="振り返りの提案" note="採用すると、規約か設計判断ログ(decisions.md)に書き足します" />
              <div className="rounded-lg border bg-card px-4 py-1">
                {d.operable ? (
                  <RetroPanel taskId={t.id} retro={d.retro} onDone={onDone} />
                ) : (
                  <p className="text-xs text-muted-foreground">agent-crew task retro {t.id} --adopt &lt;番号&gt; で採用します</p>
                )}
              </div>
            </section>
          )}
          <section>
            <SectionHead title="報告" note="Notion などに貼る(投稿は人が行う)" />
            <div className="rounded-lg border bg-card p-4">
              <Report report={d.report} />
            </div>
          </section>
          <section>
            <SectionHead title="実行" note={d.runs.length} />
            <div className="rounded-lg border bg-card">
              <RunTable runs={d.runs} />
            </div>
          </section>
          <Activity taskId={t.id} />
        </div>
        <aside className="flex flex-col gap-3">
          <SideCard title="費用と時間(合計)">
            <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs tabular-nums">
              <dt className="text-muted-foreground">費用</dt>
              <dd className="m-0">{formatCost(d.totals.costUsd)}</dd>
              <dt className="text-muted-foreground">時間</dt>
              <dd className="m-0">{formatDuration(d.totals.durationSec)}</dd>
            </dl>
          </SideCard>
          <SideCard title="worktree">
            {d.worktrees.length === 0 ? (
              <span className="text-xs text-muted-foreground">まだありません</span>
            ) : (
              d.worktrees.map((w) => (
                <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs" key={w.worktreePath}>
                  <dt className="text-muted-foreground">リポジトリ</dt>
                  <dd className="m-0">{w.repoRole}</dd>
                  <dt className="text-muted-foreground">パス</dt>
                  <dd className="m-0 font-mono break-all">
                    {w.removed ? <span className="font-sans text-muted-foreground">片付け済み(ブランチは残っています)</span> : w.worktreePath}
                  </dd>
                  <dt className="text-muted-foreground">ブランチ</dt>
                  <dd className="m-0 font-mono break-all">{w.branchName}</dd>
                </dl>
              ))
            )}
          </SideCard>
          <SideCard title="承認・合格">
            {d.approvals.length === 0 ? (
              <span className="text-xs text-muted-foreground">まだありません</span>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs">
                {d.approvals.map((a) => (
                  <li key={a.id} className={cn("flex items-baseline gap-2", a.invalidatedAt && "opacity-55")}>
                    <span className={a.result === "approved" ? "text-run" : "text-destructive"}>{a.result === "approved" ? "✓" : "✗"}</span>
                    <span>{APPROVAL[a.kind] ?? a.kind}</span>
                    {a.commitSha && <span className="font-mono text-subtle-foreground">{a.commitSha.slice(0, 7)}</span>}
                    {a.invalidatedAt && <span className="text-muted-foreground">失効</span>}
                  </li>
                ))}
              </ul>
            )}
          </SideCard>
          <div className="rounded-lg border bg-card px-4 py-3">
            <Collapsible defaultOpen={t.body.length < 600}>
              <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
                チケット本文
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2">
                <pre className="m-0 font-sans text-[13px] leading-relaxed break-words whitespace-pre-wrap">{t.body || "(本文なし)"}</pre>
                {t.sourceUrl && (
                  <a href={t.sourceUrl} target="_blank" rel="noreferrer noopener" className="text-xs">
                    取り込み元 ↗
                  </a>
                )}
              </CollapsibleContent>
            </Collapsible>
          </div>
        </aside>
      </div>
    </>
  );
}

function SideCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <h3 className="mt-0 mb-2 text-xs font-semibold text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

const APPROVAL: Record<string, string> = { plan: "計画", design: "デザイン", final: "最終確認", review: "レビュー", qa: "QA", tests: "テストの再実行" };

function Banner({ d, onDone }: { d: TaskDetail; onDone: () => void }) {
  const t = d.task;
  // 読み取り専用(serve --no-worker)では、ボタンの代わりに CLI のコマンドを出す
  const actions = d.operable ? (
    <ActionPanel taskId={t.id} actions={d.nextActions} onDone={onDone} />
  ) : (
    <div className="mt-2 w-full">
      <Commands actions={d.nextActions} />
    </div>
  );
  if (d.runActive && t.running) {
    return (
      <Alert variant="running" role="status" className="mt-4">
        <AlertTitle>
          エージェントが実行中です(<Link to={paths.run(t.running.id)}>{t.running.role}</Link>)
        </AlertTitle>
        <AlertDescription className="text-foreground">
          worktree を触らないでください
          {actions}
        </AlertDescription>
      </Alert>
    );
  }
  if (!t.attention) {
    if (d.nextActions.length === 0) return null;
    // 完了後の push のように、GUI から送らない操作はコマンドだけを見せる
    return (
      <Alert variant="muted" role="status" className="mt-4">
        <AlertDescription className="w-full text-foreground">{d.operable && d.nextActions.some((a) => a.request) ? actions : <Commands actions={d.nextActions} />}</AlertDescription>
      </Alert>
    );
  }
  const variant = t.attention === "failed" ? "danger" : t.attention === "human_working" ? "human" : "attention";
  const title = {
    answer: "人の回答待ちです",
    approve_plan: "計画を確認して承認してください",
    approve_design: "デザイン仕様を確認して承認してください",
    approve_final: "実装の結果を確かめて最終承認してください(承認すると PR の下書きを作ります)",
    approve_planning: planningApprovalTitle(t.state),
    failed: "失敗しました",
    human_working: "人が作業中です(エージェントは起動しません)",
  }[t.attention];
  // 承認の判断に読むもの(計画の承認は plan.md、デザイン仕様の承認は ui-spec.md と design.md)
  const toRead =
    t.attention === "approve_plan"
      ? [latestOf(d.artifacts, "plan")]
      : t.attention === "approve_design"
        ? [latestOf(d.artifacts, "ui-spec"), latestOf(d.artifacts, "design")]
        : [];
  return (
    <Alert variant={variant} role="status" className="mt-4">
      <AlertTitle className="font-semibold">{title}</AlertTitle>
      <AlertDescription className="w-full text-foreground">
        {t.attention === "approve_planning" ? (
          <PlanningReview taskId={t.id} state={t.state} q={d.planningQuestions} artifacts={d.artifacts} />
        ) : t.attention === "approve_final" ? (
          <FinalReview taskId={t.id} artifacts={d.artifacts} files={d.reviewFiles} screenshots={d.screenshots.filter((x) => x.url).length} />
        ) : (
          t.reason && <p className="m-0 break-words whitespace-pre-wrap">{t.reason}</p>
        )}
        {toRead.some(Boolean) && (
          <p className="m-0 flex flex-wrap gap-x-4 text-xs">
            {toRead.flatMap((a) =>
              a ? [<Link key={a.id} to={paths.artifact(t.id, a.id)}>{a.fileName} を読む →</Link>] : [],
            )}
          </p>
        )}
        <div className="w-full">{actions}</div>
      </AlertDescription>
    </Alert>
  );
}

const latestOf = (list: ArtifactSummary[], kind: string) => list.filter((a) => a.kind === kind).at(-1);

/** 種類ごとに最新を見せ、前の版は畳む */
function ArtifactList({ taskId, artifacts }: { taskId: number; artifacts: ArtifactSummary[] }) {
  if (artifacts.length === 0) return <Empty>成果物はまだありません</Empty>;
  const kinds = [...new Set(artifacts.map((a) => a.kind))];
  return (
    <Table>
      <TableBody>
        {kinds.map((k) => {
          const versions = artifacts.filter((a) => a.kind === k);
          const latest = versions.at(-1)!;
          return (
            <TableRow key={k}>
              <TableCell className="font-medium">
                <Link to={paths.artifact(taskId, latest.id)} className="no-underline hover:underline">
                  {latest.fileName}
                </Link>
              </TableCell>
              <TableCell>
                <VerdictBadge verdict={latest.verdict} />
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {versions.length > 1 && (
                  <span>
                    前の版:{" "}
                    {versions.slice(0, -1).map((v, i) => (
                      <Link key={v.id} to={paths.artifact(taskId, v.id)} className="mr-1.5">
                        {i + 1}
                      </Link>
                    ))}
                  </span>
                )}
              </TableCell>
              <TableCell className="text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums">{formatDateTime(latest.createdAt)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function Activity({ taskId }: { taskId: number }) {
  // タスクのイベントのうち、実行の中の細かいもの(発言・ツール)は実行ログで見る
  const { events, loading } = useEvents({ task: taskId }, 500);
  const shown = events.filter((e) => !isRunDetail(e));
  return (
    <section>
      <SectionHead title="アクティビティ" note="状態の変化と出来事" />
      <div className="rounded-lg border bg-card py-2">
        {loading && shown.length === 0 ? <Empty>読み込み中…</Empty> : <EventList events={shown} order="desc" />}
      </div>
    </section>
  );
}
