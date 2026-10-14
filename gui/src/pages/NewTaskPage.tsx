import { useState, type FormEvent } from "react";
import type { Overview, TaskSummary } from "../../../src/server/api-types.ts";
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
  const [projectId, setProjectId] = useState(overview.projects[0]?.id ?? 0);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  // 企画のタスク(フェーズ9): 調査から始め、要件の整理の後で開発のチケットに引き渡す
  const [planning, setPlanning] = useState(false);
  const [docs, setDocs] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = overview.projects.find((p) => p.id === projectId);

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

  if (overview.projects.length === 0) {
    return (
      <Empty>
        プロジェクトがまだありません。<code className="font-mono">agent-crew project add &lt;path&gt; --name &lt;name&gt;</code> で登録します
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
            {overview.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
          {project && project.profileStatus !== "approved" && !planning && <span className="text-xs text-attn">プロファイルが未承認のため、承認されるまで開始しません</span>}
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
