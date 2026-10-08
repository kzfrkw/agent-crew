import type { ArtifactDetail } from "../../../src/server/api-types.ts";
import { Crumbs } from "../components/Layout.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { VerdictBadge } from "../components/StateBadge.tsx";
import { Async } from "../components/Status.tsx";
import { useApi } from "../lib/api.ts";
import { formatDateTime } from "../lib/format.ts";
import { paths } from "../lib/routes.ts";
import { Link, navigate } from "../lib/router.tsx";

/** S3 成果物ビューア */
export function ArtifactPage({ taskId, id }: { taskId: number; id: number }) {
  const detail = useApi<ArtifactDetail>(`/api/artifacts/${id}`);
  return <Async state={detail}>{(d) => <ArtifactView d={d} taskId={taskId} />}</Async>;
}

function ArtifactView({ d, taskId }: { d: ArtifactDetail; taskId: number }) {
  const a = d.artifact;
  const label = (x: ArtifactDetail["siblings"][number]) => {
    const versions = d.siblings.filter((s) => s.kind === x.kind);
    return versions.length > 1 ? `${x.fileName}(${versions.indexOf(x) + 1}/${versions.length})` : x.fileName;
  };
  const extra = Object.entries(d.frontmatter ?? {}).filter(([k]) => k !== "verdict");
  return (
    <>
      <Crumbs items={[{ label: d.task ? `#${d.task.id} ${d.task.title}` : `#${taskId}`, to: paths.task(taskId) }, { label: a.fileName }]} />
      <div className="viewer">
        <nav className="viewer__nav" aria-label="成果物">
          {d.siblings.map((s) => (
            <Link key={s.id} to={paths.artifact(taskId, s.id)} aria-current={s.id === a.id ? "page" : undefined}>
              <span className="ellipsis">{label(s)}</span>
              <span className="subtle num">{formatDateTime(s.createdAt)}</span>
            </Link>
          ))}
        </nav>
        <div style={{ minWidth: 0 }}>
          <select className="select viewer__select" aria-label="成果物" value={a.id} onChange={(e) => navigate(paths.artifact(taskId, Number(e.target.value)))}>
            {d.siblings.map((s) => (
              <option key={s.id} value={s.id}>
                {label(s)}
              </option>
            ))}
          </select>
          <h1 className="page-title">{a.fileName}</h1>
          <div className="meta" style={{ marginBottom: 16 }}>
            <VerdictBadge verdict={a.verdict} />
            {d.run && (
              <Link to={paths.run(d.run.id)}>
                実行 #{d.run.id} {d.run.role}
                {d.run.model && `(${d.run.model})`}
              </Link>
            )}
            <span className="num">{formatDateTime(a.createdAt)}</span>
            {a.url && (
              <a href={a.url} target="_blank" rel="noreferrer">
                生ファイル ↗
              </a>
            )}
          </div>
          <article className="card viewer__doc">
            {extra.length > 0 && (
              <dl className="kv" style={{ marginBottom: 20, paddingBottom: 12, borderBottom: "1px solid var(--line)" }}>
                {extra.map(([k, v]) => (
                  <Fm key={k} k={k} v={v} />
                ))}
              </dl>
            )}
            <Body d={d} />
          </article>
        </div>
      </div>
    </>
  );
}

function Fm({ k, v }: { k: string; v: unknown }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{typeof v === "string" ? v : <code>{JSON.stringify(v)}</code>}</dd>
    </>
  );
}

function Body({ d }: { d: ArtifactDetail }) {
  if (d.mediaType === "image" && d.artifact.url) return <img className="img-artifact" src={d.artifact.url} alt={d.artifact.fileName} />;
  if (d.content === null) {
    return <div className="state-msg">ここでは表示できません。{d.artifact.url ? <a href={d.artifact.url}>ファイルを開く</a> : "ファイルが見つかりません"}</div>;
  }
  if (d.mediaType === "markdown") return <Markdown text={d.content} />;
  return <pre className="pre-text">{d.content}</pre>;
}
