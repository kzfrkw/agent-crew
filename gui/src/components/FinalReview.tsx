import { FileTextIcon } from "lucide-react";
import type { TaskDetail } from "../../../src/server/api-types.ts";
import { paths } from "../lib/routes.ts";
import { Link } from "../lib/router.tsx";
import { Button } from "@/components/ui/button";

type Artifact = Pick<TaskDetail["artifacts"][number], "id" | "kind" | "fileName">;
type Item = { name: string; to: string; external: boolean; check: string };

/**
 * 最終確認の欄。まず QA の結果(受け入れ条件ごと)を目立たせ、続けて確かめるもの(差分、テストの変更、レビュー、
 * デザインレビュー、実装のメモ)を、何を確かめるかつきで並べる
 */
export function FinalReview({ taskId, artifacts, files, screenshots }: { taskId: number; artifacts: Artifact[]; files: TaskDetail["reviewFiles"]; screenshots: number }) {
  const latest = (kind: string) => artifacts.filter((a) => a.kind === kind).at(-1);
  const art = (kind: string, check: string): Item[] => {
    const a = latest(kind);
    return a ? [{ name: a.fileName, to: paths.artifact(taskId, a.id), external: false, check }] : [];
  };
  const file = (url: string | null, name: string, check: string): Item[] => (url ? [{ name, to: url, external: true, check }] : []);
  const qa = latest("qa-report");
  const design = latest("design-review");
  const items: Item[] = [
    ...file(files.diff, "diff.patch", "変更の中身。意図しないファイルや、計画にない変更が入っていないか"),
    ...file(files.testChanges, "test-changes.md", "テストを弱めたり消したりしていないか(ツールの検出結果)"),
    ...art("review", "レビューの指摘。直さずに残った should・nit を受け入れてよいか"),
    ...(design ? art("design-review", `デザインレビューの結果${screenshots > 0 ? `(下の「撮影した画面 ${screenshots} 枚」と合わせて)` : ""}`) : []),
    ...art("impl-notes", "実装者のメモ。計画から変えたことと、その理由"),
  ];
  return (
    <div className="mt-1 flex flex-col gap-3">
      {qa && (
        <div className="flex flex-col gap-1.5">
          <p className="m-0 text-xs font-semibold text-muted-foreground">まず読むもの</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm">
              <Link to={paths.artifact(taskId, qa.id)} className="no-underline">
                <FileTextIcon />
                {qa.fileName} を読む
              </Link>
            </Button>
            <span className="text-xs text-muted-foreground">QA の受け入れ条件ごとの結果(計画の条件をすべて満たしたか)</span>
          </div>
        </div>
      )}
      {items.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="m-0 text-xs font-semibold text-muted-foreground">続けて確かめるもの</p>
          <ol className="m-0 flex flex-col gap-1 pl-5 text-xs">
            {items.map((it) => (
              <li key={it.name}>
                {it.external ? (
                  <a href={it.to} target="_blank" rel="noreferrer">
                    {it.name}
                  </a>
                ) : (
                  <Link to={it.to}>{it.name}</Link>
                )}
                <span className="ml-2 text-muted-foreground">{it.check}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <p className="m-0 text-xs text-muted-foreground">
        手元で動かして確かめるなら「エディタで開く」か、worktree で起動してください。承認すると、統合担当が PR 本文の下書き(pr-draft.md)を作ります。push と PR は人が行います
      </p>
    </div>
  );
}
