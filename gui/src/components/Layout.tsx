import { useEffect, useState, type ReactNode } from "react";
import { UsageMeter } from "./Usage.tsx";
import { PlusIcon } from "lucide-react";
import type { Overview, WorkerView } from "../../../src/server/api-types.ts";
import { postJson, useApi } from "../lib/api.ts";
import { paths } from "../lib/routes.ts";
import { Link, navigate } from "../lib/router.tsx";
import { useStream } from "../lib/stream.tsx";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const CONN = { connecting: "接続中…", open: "リアルタイム", reconnecting: "再接続中…" };
const CONN_DOT = { connecting: "bg-subtle-foreground", open: "bg-run", reconnecting: "bg-attn" };

/** 共通ヘッダー(docs/skeleton.md「ナビゲーション」)。対応待ちの件数をタブのタイトルにも出す */
export function Layout({ children, projectId }: { children: ReactNode; projectId?: number }) {
  const { status } = useStream();
  const overview = useApi<Overview>("/api/overview");
  const projects = overview.data?.projects ?? [];
  const attention = overview.data?.tasks.filter((t) => t.attention && t.attention !== "human_working").length ?? 0;

  useEffect(() => {
    document.title = attention > 0 ? `(${attention}) agent-crew` : "agent-crew";
  }, [attention]);

  return (
    <TooltipProvider delayDuration={300}>
      <header className="sticky top-0 z-10 h-12 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-full max-w-[1200px] items-center gap-4 px-4 max-sm:gap-3 max-sm:px-3">
          <Link to={paths.dashboard()} className="flex items-center gap-2 font-semibold tracking-tight whitespace-nowrap no-underline">
            <img src="/favicon.svg" alt="" className="size-5" />
            <span className="max-sm:sr-only">agent-crew</span>
          </Link>
          {projects.length > 0 && (
            <NativeSelect
              size="sm"
              className="max-w-[200px] max-sm:min-w-24 max-sm:max-w-none max-sm:flex-1"
              aria-label="プロジェクト"
              value={projectId ?? ""}
              onChange={(e) => navigate(e.target.value ? paths.project(Number(e.target.value)) : paths.dashboard())}
            >
              <option value="">すべてのプロジェクト</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          )}
          <Button asChild variant="outline" size="xs">
            <Link to={paths.newTask()} className="no-underline">
              <PlusIcon />
              <span className="max-sm:sr-only">チケット</span>
            </Link>
          </Button>
          <span className="flex-1 max-sm:hidden" />
          {overview.data && <UsageMeter usage={overview.data.usage} quota={overview.data.worker.quota} />}
          {overview.data && <WorkerSwitch worker={overview.data.worker} onChange={overview.reload} />}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground" role="status">
                <span className={cn("size-[7px] rounded-full", CONN_DOT[status])} aria-hidden />
                <span className="max-sm:sr-only">{CONN[status]}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent>画面の更新: {CONN[status]}</TooltipContent>
          </Tooltip>
          {overview.data?.worker.state === "disabled" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="rounded-full border px-2 text-[11px] whitespace-nowrap text-muted-foreground max-sm:hidden">読み取り専用</span>
              </TooltipTrigger>
              <TooltipContent>serve --no-worker で起動しています。操作は CLI(agent-crew)で行います</TooltipContent>
            </Tooltip>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-[1200px] px-4 pt-6 pb-8 max-sm:px-3 max-sm:pt-4">{children}</main>
    </TooltipProvider>
  );
}

const WORKER = {
  running: { label: "自動実行中", button: "一時停止", dot: "bg-run", hint: "新しい役割を起動しません(実行中のものは最後まで動きます)" },
  paused: { label: "一時停止中", button: "再開", dot: "rounded-[1px] bg-attn", hint: "進められるタスクを自動で進めます" },
  locked: { label: "CLI の run が実行中", button: null, dot: "bg-human", hint: "CLI の agent-crew run が終わったら、自動で引き継ぎます" },
  disabled: { label: "", button: null, dot: "", hint: "" },
};

/** 常駐ワーカーの状態と、一時停止・再開(G1・G2) */
function WorkerSwitch({ worker, onChange }: { worker: WorkerView; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  if (worker.state === "disabled") return null;
  const w = WORKER[worker.state];
  const toggle = async () => {
    setBusy(true);
    try {
      await postJson("/api/worker", { paused: worker.state === "running" });
      onChange();
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
      <span className={cn("size-[7px] rounded-full", w.dot)} aria-hidden />
      <span className="max-sm:sr-only">
        {w.label}
        {worker.active.length > 0 && `(${worker.active.length})`}
      </span>
      {w.button && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="outline" size="xs" onClick={toggle} disabled={busy}>
              {w.button}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{w.hint}</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}

export function Crumbs({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <nav className="mb-2 flex flex-wrap gap-1.5 text-xs text-muted-foreground" aria-label="パンくず">
      {items.map((it, i) => (
        <span key={i}>
          {i > 0 && <span className="text-subtle-foreground">/ </span>}
          {it.to ? (
            <Link to={it.to} className="no-underline hover:underline">
              {it.label}
            </Link>
          ) : (
            <span>{it.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

/** 画面の見出し */
export function PageTitle({ id, children }: { id?: number; children: ReactNode }) {
  return (
    <h1 className="mt-0 mb-2 text-xl leading-snug font-semibold tracking-tight break-words max-sm:text-lg">
      {id !== undefined && <span className="mr-2 font-medium text-subtle-foreground tabular-nums">#{id}</span>}
      {children}
    </h1>
  );
}

/** 見出しの下の補足の並び */
export function Meta({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground", className)}>{children}</div>;
}
