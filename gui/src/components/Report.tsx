import { ExternalLinkIcon } from "lucide-react";
import type { TaskReportView } from "../../../src/server/api-types.ts";
import { CopyButton } from "./Commands.tsx";

/**
 * Notion などに貼る報告(6c。API を使わない書き戻し)。節ごとに中身を見せ、節ごと・すべてをコピーできる。
 * 投稿は人が行う。Markdown なので、Notion に貼ると見出し・表・チェックリストになる
 */
export function Report({ report }: { report: TaskReportView }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton text={report.markdown} label="すべてをコピー">
          すべてをコピー
        </CopyButton>
        {report.sourceUrl && (
          <a href={report.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ExternalLinkIcon className="size-3.5" />
            元のページを開く
          </a>
        )}
      </div>
      {report.sections.map((s) => (
        <div key={s.id} className="rounded-md border">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
            <h3 className="m-0 text-xs font-semibold text-muted-foreground">{s.title}</h3>
            <CopyButton text={s.markdown} label={`${s.title}をコピー`} />
          </div>
          <pre className="m-0 max-h-48 overflow-auto px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words">{s.markdown}</pre>
        </div>
      ))}
    </div>
  );
}
