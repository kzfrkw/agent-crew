import type { UsageView, WorkerView } from "../../../src/server/api-types.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const time = (ms: number) => new Date(ms).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * 利用枠の表示(7-1)。いちばん高い使用率を出し、窓ごとの値とリセットの時刻はツールチップに出す。
 * 自動の一時停止中は、理由と再開の時刻を出す
 */
export function UsageMeter({ usage, quota }: { usage: UsageView | null; quota?: WorkerView["quota"] }) {
  if (!usage || usage.windows.length === 0) return null;
  const top = Math.max(...usage.windows.map((w) => w.utilization));
  const label = quota ? `利用枠のため停止中(${time(quota.until)} に再開)` : `利用枠 ${Math.round(top * 100)}%`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="status" className={cn("text-xs whitespace-nowrap tabular-nums text-muted-foreground", (quota || top >= 0.8) && "text-attn")}>
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {quota && <div>{quota.reason}</div>}
        {usage.windows.map((w) => (
          <div key={w.key}>
            {w.label}: {Math.round(w.utilization * 100)}%(リセット {time(w.resetsAt)})
          </div>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
