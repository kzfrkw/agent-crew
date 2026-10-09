import { useState, type FormEvent } from "react";
import type { Overview, TaskSummary } from "../../../src/server/api-types.ts";
import { Crumbs } from "../components/Layout.tsx";
import { Async } from "../components/Status.tsx";
import { postJson, useApi } from "../lib/api.ts";
import { paths } from "../lib/routes.ts";
import { navigate } from "../lib/router.tsx";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = overview.projects.find((p) => p.id === projectId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!title.trim()) return setError("タイトルを書いてください");
    setBusy(true);
    try {
      const r = await postJson<{ task: TaskSummary }>("/api/tasks", { projectId, title, body, ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}) });
      navigate(paths.task(r.task.id));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (overview.projects.length === 0) {
    return <div className="state-msg">プロジェクトがまだありません。<code>agent-crew project add &lt;path&gt; --name &lt;name&gt;</code> で登録します</div>;
  }
  return (
    <>
      <Crumbs items={[{ label: "ダッシュボード", to: paths.dashboard() }, { label: "チケットを作る" }]} />
      <h1 className="page-title">チケットを作る</h1>
      <form className="card form" onSubmit={submit}>
        <label className="field">
          <span className="field__label">プロジェクト</span>
          <select className="select" value={projectId} onChange={(e) => setProjectId(Number(e.target.value))} disabled={busy}>
            {overview.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {project && project.profileStatus !== "approved" && <span className="field__hint attn">プロファイルが未承認のため、承認されるまで開始しません</span>}
        </label>
        <label className="field">
          <span className="field__label">タイトル</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} disabled={busy} placeholder="例: 在庫0のアイテムを一覧から除外する" />
        </label>
        <label className="field">
          <span className="field__label">本文</span>
          <textarea
            className="textarea"
            rows={12}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={busy}
            placeholder={"仕様・不具合の内容。Notion などから貼り付けてかまいません(Markdown)。\n受け入れ条件があれば書いてください"}
          />
        </label>
        <label className="field">
          <span className="field__label">取り込み元の URL(任意)</span>
          <input className="input" type="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} disabled={busy} placeholder="https://www.notion.so/..." />
        </label>
        {error && (
          <p className="actions__error" role="alert">
            {error}
          </p>
        )}
        <div className="actions__buttons">
          <button type="submit" className="btn btn--primary" disabled={busy}>
            作成する
          </button>
          <span className="sm muted">
            {overview.worker.state === "running" ? "作成するとすぐ計画に入ります" : "自動実行が止まっているため、作成後は待機します"}
          </span>
        </div>
      </form>
    </>
  );
}
