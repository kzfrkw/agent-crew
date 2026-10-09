import type { TaskSummary } from "../../../src/server/api-types.ts";
import { Badge } from "@/components/ui/badge";

/** 状態バッジ(docs/surface.md)。色は状態の意味にだけ使う */
export function StateBadge({ task }: { task: Pick<TaskSummary, "state" | "stateLabel" | "attention" | "running"> }) {
  const variant =
    task.attention === "failed"
      ? "danger"
      : task.attention === "human_working"
        ? "human"
        : task.attention
          ? "attention"
          : task.running
            ? "running"
            : task.state === "done"
              ? "done"
              : "neutral";
  return (
    <Badge variant={variant}>
      {variant === "attention" && <span aria-hidden>◆</span>}
      {variant === "running" && <PulseDot />}
      {task.stateLabel}
    </Badge>
  );
}

export function PulseDot() {
  return <span className="size-1.5 animate-pulse-dot rounded-full bg-current" aria-hidden />;
}

const RUN_STATE: Record<string, { label: string; variant: "running" | "done" | "danger" | "neutral" }> = {
  running: { label: "実行中", variant: "running" },
  succeeded: { label: "成功", variant: "done" },
  failed: { label: "失敗", variant: "danger" },
  timeout: { label: "時間切れ", variant: "danger" },
  cancelled: { label: "中止", variant: "neutral" },
};

export function RunStateBadge({ state }: { state: string }) {
  const s = RUN_STATE[state] ?? { label: state, variant: "neutral" as const };
  return (
    <Badge variant={s.variant}>
      {s.variant === "running" && <PulseDot />}
      {s.label}
    </Badge>
  );
}

export function VerdictBadge({ verdict }: { verdict: string | null }) {
  if (!verdict) return <span className="text-subtle-foreground">-</span>;
  const bad = /reject|changes|fail|need_human|blocked/.test(verdict);
  return <Badge variant={bad ? "attention" : "outline"}>{verdict}</Badge>;
}
