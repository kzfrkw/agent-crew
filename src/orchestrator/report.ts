import { existsSync, readFileSync } from "node:fs";
import { getTask, listArtifacts, listEvents, listRepos, listRuns, listTaskRepos } from "../db/store.ts";
import { splitFrontmatter } from "../util/frontmatter.ts";
import type { AppContext } from "./context.ts";
import { STATE_LABELS } from "./states.ts";

/**
 * Notion に貼る報告(設計メモ v0.16、6c。API を使わない書き戻し)。
 * タスクの記録から Markdown を節ごとに組み立てる。投稿は人が行う(8.3)。Notion に貼ると見出し・表・チェックリストになる
 */

export type ReportSection = { id: "summary" | "criteria" | "qa" | "design" | "pr"; title: string; markdown: string };
export type TaskReport = { taskId: number; title: string; sourceUrl: string | null; sections: ReportSection[]; markdown: string };

const VERDICT_LABELS: Record<string, string> = {
  passed: "合格",
  failed: "不合格",
  need_human: "人の確認が必要",
  approve: "承認",
  changes_requested: "修正の依頼",
};

/** 成果物の本文(frontmatter と、先頭の # 見出しを除く。見出しは報告の節の見出しに置き換える) */
function artifactBody(path: string): string {
  const { body } = splitFrontmatter(readFileSync(path, "utf8"));
  return body.replace(/^\s*# [^\n]*\n+/, "").trim();
}

export function buildTaskReport(ctx: AppContext, taskId: number): TaskReport {
  const task = getTask(ctx.db, taskId);
  if (!task) throw new Error(`タスク ${taskId} がありません`);
  const latest = (kind: string) => listArtifacts(ctx.db, taskId).filter((a) => a.kind === kind && existsSync(a.path)).at(-1);
  const sections: ReportSection[] = [];

  // 概要
  const repos = listRepos(ctx.db, task.projectId);
  const branches = listTaskRepos(ctx.db, taskId).map((tr) => {
    const role = repos.find((r) => r.id === tr.repoId)?.role;
    return repos.length > 1 ? `\`${tr.branchName}\`(${role})` : `\`${tr.branchName}\``;
  });
  sections.push({
    id: "summary",
    title: "概要",
    markdown: [
      `## ${task.title}`,
      "",
      ...(task.sourceUrl ? [`- 元のページ: ${task.sourceUrl}`] : []),
      `- 状態: ${STATE_LABELS[task.state] ?? task.state}`,
      ...(branches.length ? [`- ブランチ: ${branches.join("、")}(push と PR の作成は人が行います)`] : []),
    ].join("\n"),
  });

  // 受け入れ条件(QA が合格していればチェック済み)
  const plan = listEvents(ctx.db, taskId, 1000).filter((e) => e.kind === "plan").at(-1)?.payload as { acceptanceCriteria?: unknown } | undefined;
  const criteria = Array.isArray(plan?.acceptanceCriteria) ? plan.acceptanceCriteria.map(String) : [];
  const qa = latest("qa-report");
  if (criteria.length) {
    const done = qa?.verdict === "passed";
    sections.push({ id: "criteria", title: "受け入れ条件", markdown: ["### 受け入れ条件", "", ...criteria.map((c) => `- [${done ? "x" : " "}] ${c}`)].join("\n") });
  }

  if (qa) {
    sections.push({ id: "qa", title: "QA の結果", markdown: [`### QA の結果: ${VERDICT_LABELS[qa.verdict ?? ""] ?? qa.verdict ?? ""}`, "", artifactBody(qa.path)].join("\n") });
  }

  const review = latest("design-review");
  if (review) {
    const summary = listRuns(ctx.db, { taskId }).filter((r) => r.role === "design_reviewer" && r.state === "succeeded").at(-1)?.summary;
    sections.push({ id: "design", title: "デザインレビュー", markdown: [`### デザインレビュー: ${VERDICT_LABELS[review.verdict ?? ""] ?? review.verdict ?? ""}`, "", summary ?? artifactBody(review.path)].join("\n") });
  }

  const pr = latest("pr-draft");
  if (pr) sections.push({ id: "pr", title: "PR の下書き", markdown: ["### PR の下書き", "", artifactBody(pr.path)].join("\n") });

  return { taskId, title: task.title, sourceUrl: task.sourceUrl, sections, markdown: sections.map((s) => s.markdown).join("\n\n") };
}
