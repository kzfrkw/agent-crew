import { useState, type FormEvent } from "react";
import type { Overview, ProjectSummary, TaskSummary } from "../../../src/server/api-types.ts";
import { Crumbs, PageTitle } from "../components/Layout.tsx";
import { Async, Empty } from "../components/Status.tsx";
import { postJson, useApi } from "../lib/api.ts";
import { paths } from "../lib/routes.ts";
import { Link, navigate } from "../lib/router.tsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * S6 チケットを作る / S6' 企画を作る(G10・G13)。プロジェクトの画面から開く(docs/structure.md「フェーズ9: プロジェクトから作る」)。
 * プロジェクトはフォームで選ばず、見出しに出す
 */
export function NewTaskPage({ projectId, kind }: { projectId: number; kind: "normal" | "planning" }) {
  const overview = useApi<Overview>("/api/overview");
  return (
    <Async state={overview}>
      {(o) => {
        const project = o.projects.find((p) => p.id === projectId);
        if (!project) return <Empty>プロジェクトが見つかりません</Empty>;
        return <Form project={project} kind={kind} running={o.worker.state === "running"} />;
      }}
    </Async>
  );
}

function Form({ project, kind, running }: { project: ProjectSummary; kind: "normal" | "planning"; running: boolean }) {
  const planning = kind === "planning";
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [docs, setDocs] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = planning ? "企画を作る" : "チケットを作る";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!title.trim()) return setError("タイトルを書いてください");
    setBusy(true);
    try {
      const r = await postJson<{ task: TaskSummary }>("/api/tasks", {
        projectId: project.id,
        title,
        body,
        ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
        ...(planning ? { kind: "planning", docs: docs.split("\n").map((d) => d.trim()).filter(Boolean) } : {}),
      });
      navigate(paths.task(r.task.id));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const crumbs = <Crumbs items={[{ label: "ダッシュボード", to: paths.dashboard() }, { label: project.name, to: paths.project(project.id) }, { label: heading }]} />;
  // 開発のチケットにはリポジトリが要る。企画用のプロジェクトでは企画を案内する
  if (!planning && project.repoCount === 0) {
    return (
      <>
        {crumbs}
        <Empty>
          {project.name} にはリポジトリがありません(企画用のプロジェクト)。<Link to={paths.newPlan(project.id)}>企画を作る</Link>
          か、リポジトリを登録してください(<code className="font-mono">agent-crew project add-repo {project.name} &lt;パス&gt; --role &lt;名前&gt;</code>)
        </Empty>
      </>
    );
  }
  return (
    <>
      {crumbs}
      <PageTitle>
        {heading} — {project.name}
      </PageTitle>
      {planning && <p className="mt-0 text-sm text-muted-foreground">調査 → 戦略 → 要件 → 構造・骨格 → 開発のチケットへの引き渡し、の順に進めます(新サービス・新機能の企画)</p>}
      {!planning && project.profileStatus !== "approved" && <p className="mt-0 text-xs text-attn">プロファイルが未承認のため、承認されるまで開始しません</p>}
      <form className="mt-4 flex max-w-[760px] flex-col gap-5 rounded-lg border bg-card p-6 max-sm:p-4" onSubmit={submit}>
        <div className="flex flex-col gap-2">
          <Label htmlFor="title" className="text-xs text-muted-foreground">
            タイトル
          </Label>
          <Input
            id="title"
            className="bg-card"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            disabled={busy}
            placeholder={planning ? "例: 共働き夫婦の家計簿" : "例: 在庫0のアイテムを一覧から除外する"}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="body" className="text-xs text-muted-foreground">
            本文
          </Label>
          <Textarea
            id="body"
            className="min-h-60 bg-card"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={busy}
            placeholder={
              planning
                ? "作りたいもの、背景、想定するユーザーとその困りごと。思いつきの解決案があれば書いてください(数行で十分です)"
                : "仕様・不具合の内容。Notion などから貼り付けてかまいません(Markdown)。\n受け入れ条件があれば書いてください"
            }
          />
        </div>
        {planning && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="docs" className="text-xs text-muted-foreground">
              読ませる資料(任意。手元のファイルかフォルダの絶対パスを、1行に1つ)
            </Label>
            <Textarea id="docs" className="min-h-20 bg-card font-mono text-xs" value={docs} onChange={(e) => setDocs(e.target.value)} disabled={busy} placeholder="/Users/me/Documents/企画メモ" />
          </div>
        )}
        <div className="flex flex-col gap-2">
          <Label htmlFor="source" className="text-xs text-muted-foreground">
            取り込み元の URL(任意)
          </Label>
          <Input id="source" className="bg-card" type="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} disabled={busy} placeholder="https://www.notion.so/..." />
        </div>
        {error && (
          <p className="m-0 text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy}>
            作成する
          </Button>
          <span className="text-xs text-muted-foreground">
            {running ? (planning ? "作成するとすぐ調査に入ります" : "作成するとすぐ計画に入ります") : "自動実行が止まっているため、作成後は待機します"}
          </span>
        </div>
      </form>
    </>
  );
}
