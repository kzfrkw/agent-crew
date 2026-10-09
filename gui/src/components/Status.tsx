import type { ReactNode } from "react";
import { ApiError } from "../lib/api.ts";

/** 読み込み中・エラー・空の表示 */
export function Loading() {
  return (
    <div aria-busy="true" aria-label="読み込み中" className="flex flex-col gap-2 p-4">
      {["w-2/5", "w-3/4", "w-1/2"].map((w) => (
        <div key={w} className={`h-3.5 rounded bg-muted ${w}`} />
      ))}
    </div>
  );
}

export function ErrorView({ error }: { error: Error }) {
  if (error instanceof ApiError && error.status === 404) return <Empty>見つかりませんでした</Empty>;
  return <div className="rounded-md bg-destructive-soft px-4 py-3 text-destructive">読み込めませんでした: {error.message}</div>;
}

/** 空・案内の表示 */
export function Empty({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`px-4 py-8 text-center text-xs text-muted-foreground ${className}`}>{children}</div>;
}

/** useApi の結果に応じて、読み込み中・エラー・本体を出し分ける */
export function Async<T>({ state, children }: { state: { data: T | undefined; error: Error | undefined }; children: (data: T) => ReactNode }) {
  if (state.data !== undefined) return <>{children(state.data)}</>;
  if (state.error) return <ErrorView error={state.error} />;
  return <Loading />;
}
