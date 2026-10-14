import { useState, type FormEvent } from "react";
import type { Overview, ProjectSummary, TaskSummary } from "../../../src/server/api-types.ts";
import { Crumbs, PageTitle } from "../components/Layout.tsx";
import { Async, Empty } from "../components/Status.tsx";
import { postJson, useApi } from "../lib/api.ts";
import { paths } from "../lib/routes.ts";
import { navigate } from "../lib/router.tsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

/** S6 チケット投入(G10)。Notion などから本文を貼り付け、取り込み元の URL を添えられる */
export function NewTaskPage() {
  const overview = useApi<Overview>("/api/overview");
  return <Async state={overview}>{(o) => <Form overview={o} />}</Async>;
}

function Form({ overview }: { overview: Overview }) {
  // その場で作った企画用のプロジェクトも選べるよう、一覧を手元に持つ(フェーズ9)
  const [projects, setProjects] = useState(overview.projects);
  const [projectId, setProjectId] = useState(overview.projects[0]?.id ?? 0);
  const [newProject, setNewProject] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  // 企画のタスク(フェーズ9): 調査から始め、要件の整理の後で開発のチケットに引き渡す
  const [planning, setPlanning] = useState(false);
  const [docs, setDocs] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = projects.find((p) => p.id === projectId);

  const createProject = async () => {
    setError(null);
    if (!newProject?.trim()) return setError("プロジェクトの名前を書いてください");
    setBusy(true);
    try {
      const r = await postJson<{ project: ProjectSummary }>("/api/projects", { name: newProject.trim() });
      setProjects([...projects, r.project]);
      setProjectId(r.project.id);
      setNewProject(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!title.trim()) return setError("タイトルを書いてください");
    setBusy(true);
    try {
      const r = await postJson<{ task: TaskSummary }>("/api/tasks", {
        projectId,
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

  if (projects.length === 0 && newProject === null && !planning) {
    return (
      <Empty>
        プロジェクトがまだありません。リポジトリは <code className="font-mono">agent-crew project add &lt;path&gt; --name &lt;name&gt;</code> で登録します。
        <span className="mt-3 block">
          <Button type="button" variant="outline" size="sm" onClick={() => (setPlanning(true), setNewProject(""))}>
            企画から始める(企画用のプロジェクトを作る)
          </Button>
        </span>
      </Empty>
    );
  }
  return (
    <>
      <Crumbs items={[{ label: "ダッシュボード", to: paths.dashboard() }, { label: "チケットを作る" }]} />
      <PageTitle>チケットを作る</PageTitle>
      <form className="mt-4 flex max-w-[760px] flex-col gap-5 rounded-lg border bg-card p-6 max-sm:p-4" onSubmit={submit}>
        <div className="flex flex-col gap-2">
          <Label htmlFor="project" className="text-xs text-muted-foreground">
            プロジェクト
          </Label>
          <NativeSelect id="project" className="max-w-[320px]" value={projectId} onChange={(e) => setProjectId(Number(e.target.value))} disabled={busy}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
          {project && project.profileStatus !== "approved" && !planning && <span className="text-xs text-attn">プロファイルが未承認のため、承認されるまで開始しません</span>}
          {planning &&
            (newProject === null ? (
              <Button type="button" variant="ghost" size="xs" className="self-start text-muted-foreground" onClick={() => setNewProject("")} disabled={busy}>
                企画用のプロジェクトを作る
              </Button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="max-w-[240px] bg-card"
                  aria-label="新しいプロジェクトの名前"
                  placeholder="例: kakeibo(英数字と . _ -)"
                  value={newProject}
                  onChange={(e) => setNewProject(e.target.value)}
                  disabled={busy}
                />
                <Button type="button" variant="outline" size="sm" onClick={createProject} disabled={busy}>
                  プロジェクトを作る
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setNewProject(null)} disabled={busy}>
                  やめる
                </Button>
                <span className="basis-full text-xs text-muted-foreground">リポジトリの無い、新サービスの企画用のプロジェクトです。開発に引き渡すときは、リポジトリを登録したプロジェクトを選びます</span>
              </div>
            ))}
        </div>
        <label className="inline-flex cursor-pointer items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1 accent-foreground" checked={planning} onChange={(e) => setPlanning(e.target.checked)} disabled={busy} />
          <span>
            企画として作る
            <span className="block text-xs text-muted-foreground">調査 → 戦略 → 要件 → 構造・骨格 → 開発のチケットへの引き渡し、の順に進めます(新サービス・新機能の企画)</span>
          </span>
        </label>
        <div className="flex flex-col gap-2">
          <Label htmlFor="title" className="text-xs text-muted-foreground">
            タイトル
          </Label>
          <Input id="title" className="bg-card" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} disabled={busy} placeholder="例: 在庫0のアイテムを一覧から除外する" />
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
            placeholder={"仕様・不具合の内容。Notion などから貼り付けてかまいません(Markdown)。\n受け入れ条件があれば書いてください"}
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
          <span className="text-xs text-muted-foreground">{overview.worker.state === "running" ? "作成するとすぐ計画に入ります" : "自動実行が止まっているため、作成後は待機します"}</span>
        </div>
      </form>
    </>
  );
}
