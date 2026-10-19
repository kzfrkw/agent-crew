import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { postJson } from "../lib/api.ts";
import { Link } from "../lib/router.tsx";
import { Button } from "@/components/ui/button";
import type { ProjectDetail } from "../../../src/server/api-types.ts";
import { CommandLine } from "../components/Commands.tsx";
import { Crumbs, Meta, PageTitle } from "../components/Layout.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { SectionHead } from "../components/Panel.tsx";
import { ProjectSettings } from "../components/ProjectSettings.tsx";
import { RunTable } from "../components/RunTable.tsx";
import { Async } from "../components/Status.tsx";
import { TaskTable } from "../components/TaskTable.tsx";
import { useApi } from "../lib/api.ts";
import { paths } from "../lib/routes.ts";
import { PROFILE, TEST_INFRA } from "./Dashboard.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

/** S5 プロジェクト */
export function ProjectPage({ id }: { id: number }) {
  const detail = useApi<ProjectDetail>(`/api/projects/${id}`);
  return <Async state={detail}>{(d) => <ProjectView d={d} reload={detail.reload} />}</Async>;
}

function ProjectView({ d, reload }: { d: ProjectDetail; reload: () => void }) {
  const p = d.project;
  return (
    <>
      <Crumbs items={[{ label: "ダッシュボード", to: paths.dashboard() }, { label: p.name }]} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageTitle>{p.name}</PageTitle>
        <div className="flex gap-2">
          {d.repos.length > 0 && (
            <Button asChild variant="outline" size="sm">
              <Link to={paths.newTask(p.id)} className="no-underline">
                <PlusIcon />
                チケット
              </Link>
            </Button>
          )}
          <Button asChild variant="outline" size="sm">
            <Link to={paths.newPlan(p.id)} className="no-underline">
              <PlusIcon />
              企画
            </Link>
          </Button>
        </div>
      </div>
      <Meta>
        <Badge variant={p.profileStatus === "approved" ? "done" : "attention"}>プロファイル: {PROFILE[p.profileStatus] ?? p.profileStatus}</Badge>
        <Badge variant={p.testInfra === "present" ? "done" : "outline"}>テスト基盤: {TEST_INFRA[p.testInfra] ?? p.testInfra}</Badge>
        {p.allowWithoutTests && <span>テスト基盤の整備前の通常タスクを許可</span>}
      </Meta>
      <ProfileStatus d={d} />

      <div className="mt-6 grid grid-cols-1 items-start gap-6 min-[880px]:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-6">
          <section>
            <SectionHead title="タスク" note={d.tasks.length} />
            <div className="rounded-lg border bg-card">
              <TaskTable tasks={[...d.tasks].sort((a, b) => b.id - a.id)} />
            </div>
          </section>
          <section>
            <SectionHead title="プロファイル" note="プロジェクト把握担当がまとめた前提" />
            <div className="rounded-lg border bg-card px-8 py-6 max-[879px]:px-4 max-[879px]:py-4">
              {d.profileMd ? (
                <Markdown text={d.profileMd} />
              ) : d.profile ? (
                <pre className="m-0 font-mono text-xs whitespace-pre-wrap">{JSON.stringify(d.profile, null, 2)}</pre>
              ) : (
                <span className="text-muted-foreground">まだありません</span>
              )}
            </div>
          </section>
          <section>
            <SectionHead title="設計判断ログ" note="decisions.md" />
            <div className="rounded-lg border bg-card px-8 py-6 max-[879px]:px-4 max-[879px]:py-4">
              {d.decisionsMd ? <Markdown text={d.decisionsMd} /> : <span className="text-muted-foreground">まだありません</span>}
            </div>
          </section>
        </div>
        <aside className="flex flex-col gap-3">
          <ProjectSettings projectId={p.id} name={p.name} defaultBranch={d.repos[0]?.defaultBranch ?? "既定ブランチ"} settings={d.settings} operable={d.operable} onChanged={reload} />
          <div className="rounded-lg border bg-card px-4 py-3">
            <h3 className="mt-0 mb-2 text-xs font-semibold text-muted-foreground">リポジトリ</h3>
            {d.repos.length === 0 && (
              <p className="m-0 text-xs text-muted-foreground">
                リポジトリはまだありません(企画用のプロジェクト)。登録は <code className="font-mono">agent-crew project add-repo {p.name} &lt;パス&gt; --role &lt;名前&gt;</code>
              </p>
            )}
            {d.repos.map((r) => (
              <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs [&+dl]:mt-3 [&+dl]:border-t [&+dl]:pt-3" key={r.id}>
                {/* リポジトリが1つだけなら、区別する名前は要らないので出さない */}
                {d.repos.length > 1 && (
                  <>
                    <dt className="text-muted-foreground">名前</dt>
                    <dd className="m-0">
                      <span className="font-mono">{r.role}</span>
                      <span className="block text-subtle-foreground">このプロジェクトの中でリポジトリを区別する名前。コマンドの --role で指定する</span>
                    </dd>
                  </>
                )}
                <dt className="text-muted-foreground">パス</dt>
                <dd className="m-0 font-mono break-all">{r.path}</dd>
                <dt className="text-muted-foreground">ベースのブランチ</dt>
                <dd className="m-0">
                  <span className="font-mono">{r.defaultBranch}</span>
                  <span className="block text-subtle-foreground">{d.settings.integrate === "main" ? "タスクのブランチはここから作り、最終確認の後にここへ取り込む" : "タスクのブランチはここから作り、PR もここに向けて出す"}</span>
                </dd>
              </dl>
            ))}
          </div>
          {d.repos.map((r) => (
            <ProfileCommands key={r.id} name={p.name} role={d.repos.length > 1 ? r.role : undefined} profile={r.profile ?? d.profile} env={r.env} protect={r.protect} />
          ))}
          <div className="rounded-lg border bg-card">
            <h3 className="mt-0 mb-0 px-4 pt-3 text-xs font-semibold text-muted-foreground">プロジェクト把握担当の実行</h3>
            <RunTable runs={d.runs} compact />
          </div>
        </aside>
      </div>
    </>
  );
}

type ProfileJson = {
  platform?: "web" | "flutter" | "ios";
  commands?: Record<"install" | "build" | "test" | "start", string | null> & { analyze?: string | null; screens?: string | null };
  startUrl?: string | null;
} | null;

/**
 * プロファイルの状態(フェーズ9)。承認待ちなら GUI で承認でき、作っている間・失敗もここに出す。
 * 作っているかは、プロジェクトの実行(プロジェクト把握担当)で見る
 */
function ProfileStatus({ d }: { d: ProjectDetail }) {
  const p = d.project;
  const [allow, setAllow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const last = d.runs.filter((r) => r.role === "profiler").sort((a, b) => b.id - a.id)[0];
  const send = async (body: object) => {
    setBusy(true);
    setError(null);
    try {
      setMessage((await postJson<{ message: string }>(`/api/projects/${p.id}/profile`, body)).message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const result = (
    <>
      {error && (
        <p className="m-0 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="m-0 text-xs text-run" role="status">
          {message}
        </p>
      )}
    </>
  );
  if (d.repos.length === 0 || p.profileStatus === "approved") return null;
  if (last?.state === "running") {
    return (
      <Alert variant="running" role="status" className="mt-4">
        <AlertTitle className="font-semibold">プロジェクト把握担当がプロファイルを作っています(数分)</AlertTitle>
        <AlertDescription>できたらここで確認して承認してください。承認すると開発のタスクが始まります</AlertDescription>
      </Alert>
    );
  }
  if (p.profileStatus === "none") {
    return (
      <Alert variant="attention" className="mt-4">
        <AlertTitle className="font-semibold">プロファイルがありません</AlertTitle>
        <AlertDescription className="flex w-full flex-col gap-2">
          {last?.state && last.state !== "succeeded" && <span>前回は作れませんでした: {last.error ?? last.state}</span>}
          <div>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void send({ action: "reprofile" })}>
              作り直す
            </Button>
          </div>
          {result}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="attention" className="mt-4">
      <AlertTitle className="font-semibold">プロファイルの確認と承認が必要です</AlertTitle>
      <AlertDescription className="flex w-full flex-col gap-2">
        <span>下の「プロファイル」と「役割に渡すコマンド」を確かめてください。承認すると、このプロジェクトのタスクが始まります</span>
        {p.testInfra !== "present" && (
          <label className="inline-flex cursor-pointer items-start gap-1.5 text-xs">
            <input type="checkbox" className="mt-0.5 accent-foreground" checked={allow} onChange={(e) => setAllow(e.target.checked)} disabled={busy} />
            <span>テスト基盤の整備を待たずに開発を始める(新しい空のリポジトリなら、最初のチケットでテストの仕組みも作るためおすすめ)</span>
          </label>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => void send({ action: "approve", ...(allow ? { allowWithoutTests: true } : {}) })}>
            プロファイルを承認する
          </Button>
          <CommandLine command={`agent-crew project approve ${p.name}${allow ? " --allow-without-tests" : ""}`} />
        </div>
        {result}
      </AlertDescription>
    </Alert>
  );
}

/** 役割に渡すコマンド。正本は DB のプロファイル(profile.md を手で直しても反映されない)ので、直し方を添える */
function ProfileCommands({ name, role, profile, env = {}, protect = [] }: { name: string; role?: string; profile: unknown; env?: Record<string, string>; protect?: string[] }) {
  const p = profile as ProfileJson;
  if (!p?.commands) return null;
  const rows: [string, string | null | undefined][] = [
    ...(p.platform === "flutter" ? ([["種類", "Flutter(iOS)"]] as [string, string][]) : p.platform === "ios" ? ([["種類", "ネイティブ iOS"]] as [string, string][]) : []),
    ["依存の準備", p.commands.install],
    ["ビルド", p.commands.build],
    ["テスト", p.commands.test],
    ["起動", p.commands.start],
    ["確認URL", p.startUrl],
    ...(p.commands.analyze ? ([["静的解析", p.commands.analyze]] as [string, string][]) : []),
    ...(p.commands.screens ? ([["撮影の UI テスト", p.commands.screens]] as [string, string][]) : []),
  ];
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <h3 className="mt-0 mb-2 text-xs font-semibold text-muted-foreground">役割に渡すコマンド{role && <span className="font-mono">[{role}]</span>}</h3>
      <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {rows.map(([label, v]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="m-0 font-mono break-all">{v ?? <span className="font-sans text-subtle-foreground">なし</span>}</dd>
          </div>
        ))}
      </dl>
      {Object.keys(env).length > 0 && (
        <div className="mt-2 text-xs">
          <span className="text-muted-foreground">起動のつなぎ方: </span>
          {Object.entries(env).map(([k, v]) => (
            <code key={k} className="mr-2 font-mono break-all">
              {k}={v}
            </code>
          ))}
        </div>
      )}
      <div className="mt-2 text-xs">
        <span className="text-muted-foreground">読ませないパス: </span>
        {protect.length > 0 ? (
          protect.map((p) => (
            <code key={p} className="mr-2 font-mono break-all">
              {p}
            </code>
          ))
        ) : (
          <span className="text-subtle-foreground">なし(agent-crew project protect {name} --add &lt;パス&gt; で足せる)</span>
        )}
      </div>
      <p className="mt-2 mb-0 text-xs text-muted-foreground">
        直すとき: <code className="font-mono break-all">agent-crew project set {name}{role ? ` --role ${role}` : ""} --start "..."</code>(profile.md を直しても反映されません)
      </p>
    </div>
  );
}
