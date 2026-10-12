import { useState } from "react";
import type { TaskDetail } from "../../../src/server/api-types.ts";
import { postJson } from "../lib/api.ts";
import { Button } from "@/components/ui/button";

const TARGET = { conventions: "規約", decisions: "設計判断" };
const STATUS = { pending: null, adopted: "採用済み", rejected: "却下" };

/**
 * 振り返りの提案(8-5)。完了したタスクから、規約・設計判断ログに足すべきことの提案。
 * 採用すると、ツールがプロファイルの規約か decisions.md に書き足す。却下したものは採用し直せる
 */
export function RetroPanel({ taskId, retro, onDone }: { taskId: number; retro: NonNullable<TaskDetail["retro"]>; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (retro.proposals.length === 0) return <p className="m-0 text-xs text-muted-foreground">提案はありませんでした</p>;
  const decide = async (index: number, adopt: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/tasks/${taskId}/actions`, { action: "retro", index, adopt });
      onDone?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <ul className="m-0 flex list-none flex-col divide-y p-0">
        {retro.proposals.map((p) => (
          <li key={p.index} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
            <span className="text-xs whitespace-nowrap text-muted-foreground">{TARGET[p.target]}</span>
            <span className="min-w-0 flex-1">{p.text}</span>
            {STATUS[p.status] && <span className="text-xs whitespace-nowrap text-muted-foreground">{STATUS[p.status]}</span>}
            {p.status !== "adopted" && (
              <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => decide(p.index, true)} aria-label={`「${p.text}」を採用`}>
                採用
              </Button>
            )}
            {p.status === "pending" && (
              <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => decide(p.index, false)} aria-label={`「${p.text}」を却下`}>
                却下
              </Button>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="m-0 text-xs text-destructive">{error}</p>}
    </div>
  );
}
