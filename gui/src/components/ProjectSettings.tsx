import { useEffect, useState } from "react";
import type { ProjectSettingsView } from "../../../src/server/api-types.ts";
import { postJson } from "../lib/api.ts";
import { CommandLine } from "./Commands.tsx";

type Flag = "explain" | "autoApprovePlan" | "retrospective" | "coordinator";

const FLAGS: { key: Flag; label: string; note: string; option: string }[] = [
  { key: "explain", label: "解説を作る", note: "最終確認の前に、変更の重要なロジックと使っている技術の解説(explain.md)を作る", option: "--explain" },
  { key: "autoApprovePlan", label: "計画の自動承認", note: "小さなタスクの計画を、人の承認なしで進める", option: "--auto-approve-plan" },
  { key: "retrospective", label: "振り返り", note: "完了したタスクから、規約と設計判断の提案を出す", option: "--retrospective" },
  { key: "coordinator", label: "企画をコーディネーターで進める", note: "新しく作る企画の既定(作るときに選び直せる)", option: "--coordinator" },
];

/**
 * S5 プロジェクトの設定(v0.23)。取り込み方は2択、ほかはチェックで、選んだらすぐ送る。
 * 読み取り専用(serve --no-worker)では切り替えられないので、CLI のコマンドを出す
 */
/** onChanged: 変えた後に、画面のほかの欄(リポジトリの説明など)を読み直す */
export function ProjectSettings({ projectId, name, defaultBranch, settings, operable, onChanged }: { projectId: number; name: string; defaultBranch: string; settings: ProjectSettingsView; operable: boolean; onChanged?: () => void }) {
  const [current, setCurrent] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setCurrent(settings), [settings]);

  const save = async (patch: Partial<ProjectSettingsView>) => {
    setBusy(true);
    setError(null);
    try {
      setCurrent((await postJson<{ settings: ProjectSettingsView }>(`/api/projects/${projectId}/settings`, patch)).settings);
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const disabled = !operable || busy;
  const workspace = (value: ProjectSettingsView["workspace"], label: string, note: string) => (
    <label className="flex cursor-pointer items-start gap-1.5">
      <input type="radio" name={`workspace-${projectId}`} className="mt-0.5 accent-foreground" checked={current.workspace === value} disabled={disabled} onChange={() => void save({ workspace: value })} />
      <span>
        {label}
        <span className="block text-subtle-foreground">{note}</span>
      </span>
    </label>
  );
  const integrate = (value: ProjectSettingsView["integrate"], label: string, note: string) => (
    <label className="flex cursor-pointer items-start gap-1.5">
      <input type="radio" name={`integrate-${projectId}`} className="mt-0.5 accent-foreground" checked={current.integrate === value} disabled={disabled} onChange={() => void save({ integrate: value })} />
      <span>
        {label}
        <span className="block text-subtle-foreground">{note}</span>
      </span>
    </label>
  );

  return (
    <div className="rounded-lg border bg-card px-4 py-3 text-xs">
      <h3 className="mt-0 mb-2 text-xs font-semibold text-muted-foreground">設定</h3>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 p-0 text-muted-foreground">作業場所</legend>
        {workspace("worktree", "worktree(タスクごとに別のフォルダ)", "人の作業場所とは別に作業する。タスクを並べて進められる")}
        {workspace("repo", "リポジトリで直接", "人のリポジトリでタスクのブランチに切り替えて作業する。Xcode の設定・管理外のファイル・シンボリックリンクがそのまま使える。タスクは1つずつで、動いている間はリポジトリを触らない")}
      </fieldset>
      <fieldset className="m-0 mt-3 flex flex-col gap-2 border-0 border-t p-0 pt-3">
        <legend className="mb-1 p-0 text-muted-foreground">最終確認の後の取り込み方</legend>
        {integrate("pr", "PR を作る", "タスクごとにブランチと PR の下書きを残す。人が PR を作ってマージする")}
        {integrate("main", `${defaultBranch} に取り込む`, `ツールがローカルの ${defaultBranch} に fast-forward で取り込む。タスクは1つずつ進む。push は人が行う(新規開発向け)`)}
      </fieldset>
      <div className="mt-3 flex flex-col gap-2 border-t pt-3">
        {FLAGS.map((f) => (
          <label key={f.key} className="flex cursor-pointer items-start gap-1.5">
            <input type="checkbox" className="mt-0.5 accent-foreground" checked={current[f.key]} disabled={disabled} onChange={(e) => void save({ [f.key]: e.target.checked })} />
            <span>
              {f.label}
              <span className="block text-subtle-foreground">{f.note}</span>
            </span>
          </label>
        ))}
      </div>
      {!operable && (
        <div className="mt-3 flex flex-col gap-1 border-t pt-3">
          <span className="text-muted-foreground">読み取り専用で起動しています。切り替えは CLI で行います</span>
          <CommandLine command={`agent-crew project set ${name} --workspace ${current.workspace === "worktree" ? "repo" : "worktree"}`} />
          <CommandLine command={`agent-crew project set ${name} --integrate ${current.integrate === "pr" ? "main" : "pr"}`} />
          {FLAGS.map((f) => (
            <CommandLine key={f.key} command={`agent-crew project set ${name} ${f.option} ${current[f.key] ? "off" : "on"}`} />
          ))}
        </div>
      )}
      {error && (
        <p className="mt-2 mb-0 text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
