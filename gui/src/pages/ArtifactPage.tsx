import type { ArtifactDetail } from "../../../src/server/api-types.ts";
import { Crumbs, Meta, PageTitle } from "../components/Layout.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { VerdictBadge } from "../components/StateBadge.tsx";
import { Async, Empty } from "../components/Status.tsx";
import { useApi } from "../lib/api.ts";
import { formatDateTime } from "../lib/format.ts";
import { paths } from "../lib/routes.ts";
import { Link, navigate } from "../lib/router.tsx";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";

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
      <div className="grid grid-cols-1 items-start gap-6 min-[880px]:grid-cols-[200px_minmax(0,1fr)]">
        <nav className="sticky top-16 flex flex-col gap-0.5 text-xs max-[879px]:hidden" aria-label="成果物">
          {d.siblings.map((s) => (
            <Link
              key={s.id}
              to={paths.artifact(taskId, s.id)}
              aria-current={s.id === a.id ? "page" : undefined}
              className={cn(
                "flex justify-between gap-2 rounded-md px-2.5 py-1 text-muted-foreground no-underline hover:bg-muted hover:text-foreground",
                s.id === a.id && "bg-muted font-semibold text-foreground",
              )}
            >
              <span className="truncate">{label(s)}</span>
              <span className="text-subtle-foreground tabular-nums">{formatDateTime(s.createdAt)}</span>
            </Link>
          ))}
        </nav>
        <div className="min-w-0">
          <NativeSelect className="mb-3 w-full min-[880px]:hidden" aria-label="成果物" value={a.id} onChange={(e) => navigate(paths.artifact(taskId, Number(e.target.value)))}>
            {d.siblings.map((s) => (
              <option key={s.id} value={s.id}>
                {label(s)}
              </option>
            ))}
          </NativeSelect>
          <PageTitle>{a.fileName}</PageTitle>
          <Meta className="mb-4">
            <VerdictBadge verdict={a.verdict} />
            {d.run && (
              <Link to={paths.run(d.run.id)}>
                実行 #{d.run.id} {d.run.role}
                {d.run.model && `(${d.run.model})`}
              </Link>
            )}
            <span className="tabular-nums">{formatDateTime(a.createdAt)}</span>
            {a.url && (
              <a href={a.url} target="_blank" rel="noreferrer">
                生ファイル ↗
              </a>
            )}
          </Meta>
          <article className="rounded-lg border bg-card px-8 py-6 max-[879px]:px-4 max-[879px]:py-4">
            {extra.length > 0 && (
              <dl className="mt-0 mb-5 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 border-b pb-3 text-xs">
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
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="m-0 break-words">{typeof v === "string" ? v : <code className="font-mono">{JSON.stringify(v)}</code>}</dd>
    </>
  );
}

function Body({ d }: { d: ArtifactDetail }) {
  if (d.mediaType === "image" && d.artifact.url) return <img className="max-w-full rounded-md border" src={d.artifact.url} alt={d.artifact.fileName} />;
  if (d.content === null) {
    return <Empty>ここでは表示できません。{d.artifact.url ? <a href={d.artifact.url}>ファイルを開く</a> : "ファイルが見つかりません"}</Empty>;
  }
  if (d.mediaType === "markdown") return <Markdown text={d.content} />;
  return <pre className="m-0 font-mono text-[12.5px] leading-relaxed break-all whitespace-pre-wrap">{d.content}</pre>;
}
