import { useState, type FormEvent } from "react";
import type { ProjectSummary } from "../../../src/server/api-types.ts";
import { CommandLine } from "../components/Commands.tsx";
import { Crumbs, PageTitle } from "../components/Layout.tsx";
import { postJson } from "../lib/api.ts";
import { paths } from "../lib/routes.ts";
import { navigate } from "../lib/router.tsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * S7 プロジェクトを作る(docs/structure.md「フェーズ9: プロジェクトから作る」)。
 * 企画用(リポジトリなし)は GUI で作る。リポジトリの登録はローカルのパスを扱い調査も走るため、CLI のコマンドを示す
 */
export function NewProjectPage() {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("名前を書いてください");
    setBusy(true);
    try {
      const r = await postJson<{ project: ProjectSummary }>("/api/projects", { name: name.trim() });
      navigate(paths.project(r.project.id));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <Crumbs items={[{ label: "ダッシュボード", to: paths.dashboard() }, { label: "プロジェクトを作る" }]} />
      <PageTitle>プロジェクトを作る</PageTitle>
      <div className="mt-4 flex max-w-[760px] flex-col gap-4">
        <section className="rounded-lg border bg-card p-6 max-sm:p-4">
          <h2 className="mt-0 mb-1 text-sm font-semibold">企画用(リポジトリなし)</h2>
          <p className="mt-0 mb-3 text-xs text-muted-foreground">新サービスの企画から始めるとき。開発に引き渡すときに、リポジトリを登録したプロジェクトを選びます</p>
          <form className="flex flex-wrap items-center gap-2" onSubmit={create}>
            <Input
              className="max-w-[260px] bg-card"
              aria-label="企画用のプロジェクトの名前"
              placeholder="名前(例: kakeibo。英数字と . _ -)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
            <Button type="submit" disabled={busy}>
              作る
            </Button>
          </form>
          {error && (
            <p className="mt-2 mb-0 text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </section>
        <section className="rounded-lg border bg-card p-6 max-sm:p-4">
          <h2 className="mt-0 mb-1 text-sm font-semibold">リポジトリを登録する(開発に使う)</h2>
          <p className="mt-0 mb-3 text-xs text-muted-foreground">
            今は CLI で行います。登録すると、プロジェクト把握担当がリポジトリを調べてプロファイル(テスト・起動などのコマンド)を作ります(数分。利用枠を少し使う)。内容を確かめて承認すると、チケットを流せます
          </p>
          <div className="flex flex-col gap-1.5">
            <CommandLine label="登録" command="npx agent-crew project add <リポジトリのパス> --name <名前>" />
            <CommandLine label="確認" command="npx agent-crew project show <名前>" />
            <CommandLine label="承認" command="npx agent-crew project approve <名前>" />
          </div>
        </section>
      </div>
    </>
  );
}
