import type { ProjectDetail } from "../../../src/server/api-types.ts";
import { CommandLine } from "../components/Commands.tsx";
import { Crumbs, Meta, PageTitle } from "../components/Layout.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { SectionHead } from "../components/Panel.tsx";
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
  return <Async state={detail}>{(d) => <ProjectView d={d} />}</Async>;
}

function ProjectView({ d }: { d: ProjectDetail }) {
  const p = d.project;
  return (
    <>
      <Crumbs items={[{ label: "ダッシュボード", to: paths.dashboard() }, { label: p.name }]} />
      <PageTitle>{p.name}</PageTitle>
      <Meta>
        <Badge variant={p.profileStatus === "approved" ? "done" : "attention"}>プロファイル: {PROFILE[p.profileStatus] ?? p.profileStatus}</Badge>
        <Badge variant={p.testInfra === "present" ? "done" : "outline"}>テスト基盤: {TEST_INFRA[p.testInfra] ?? p.testInfra}</Badge>
        {p.allowWithoutTests && <span>テスト基盤の整備前の通常タスクを許可</span>}
      </Meta>
      {p.profileStatus === "draft" && (
        <Alert variant="attention" role="status" className="mt-4">
          <AlertTitle className="font-semibold">プロファイルの確認と承認が必要です</AlertTitle>
          <AlertDescription className="w-full">
            <CommandLine command={`agent-crew project approve ${p.name}`} />
          </AlertDescription>
        </Alert>
      )}

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
          <div className="rounded-lg border bg-card px-4 py-3">
            <h3 className="mt-0 mb-2 text-xs font-semibold text-muted-foreground">リポジトリ</h3>
            {d.repos.map((r) => (
              <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs" key={r.id}>
                <dt className="text-muted-foreground">役目</dt>
                <dd className="m-0">{r.role}</dd>
                <dt className="text-muted-foreground">パス</dt>
                <dd className="m-0 font-mono break-all">{r.path}</dd>
                <dt className="text-muted-foreground">既定</dt>
                <dd className="m-0 font-mono">{r.defaultBranch}</dd>
              </dl>
            ))}
          </div>
          {d.repos.map((r) => (
            <ProfileCommands key={r.id} name={p.name} role={d.repos.length > 1 ? r.role : undefined} profile={r.profile ?? d.profile} env={r.env} />
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

/** 役割に渡すコマンド。正本は DB のプロファイル(profile.md を手で直しても反映されない)ので、直し方を添える */
function ProfileCommands({ name, role, profile, env = {} }: { name: string; role?: string; profile: unknown; env?: Record<string, string> }) {
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
      <p className="mt-2 mb-0 text-xs text-muted-foreground">
        直すとき: <code className="font-mono break-all">agent-crew project set {name}{role ? ` --role ${role}` : ""} --start "..."</code>(profile.md を直しても反映されません)
      </p>
    </div>
  );
}
