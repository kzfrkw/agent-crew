import type { ReactNode } from "react";
import { ApiError } from "../lib/api.ts";

/** 読み込み中・エラー・空の表示 */
export function Loading() {
  return (
    <div aria-busy="true" aria-label="読み込み中">
      <div className="skeleton" style={{ width: "40%" }} />
      <div className="skeleton" style={{ width: "70%" }} />
      <div className="skeleton" style={{ width: "55%" }} />
    </div>
  );
}

export function ErrorView({ error }: { error: Error }) {
  if (error instanceof ApiError && error.status === 404) return <div className="state-msg">見つかりませんでした</div>;
  return <div className="error-box">読み込めませんでした: {error.message}</div>;
}

/** useApi の結果に応じて、読み込み中・エラー・本体を出し分ける */
export function Async<T>({ state, children }: { state: { data: T | undefined; error: Error | undefined }; children: (data: T) => ReactNode }) {
  if (state.data !== undefined) return <>{children(state.data)}</>;
  if (state.error) return <ErrorView error={state.error} />;
  return <Loading />;
}
