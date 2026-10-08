import type { TaskSummary } from "../../../src/server/api-types.ts";

/** 状態バッジ(docs/surface.md)。色は状態の意味にだけ使う */
export function StateBadge({ task }: { task: Pick<TaskSummary, "state" | "stateLabel" | "attention" | "running"> }) {
  const tone =
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
              : "";
  return (
    <span className={`badge ${tone ? `badge--${tone}` : ""}`}>
      {tone === "attention" && <span aria-hidden>◆</span>}
      {tone === "running" && <span className="pulse" aria-hidden />}
      {task.stateLabel}
    </span>
  );
}

const RUN_STATE: Record<string, { label: string; tone: string }> = {
  running: { label: "実行中", tone: "running" },
  succeeded: { label: "成功", tone: "done" },
  failed: { label: "失敗", tone: "danger" },
  timeout: { label: "時間切れ", tone: "danger" },
  cancelled: { label: "中止", tone: "" },
};

export function RunStateBadge({ state }: { state: string }) {
  const s = RUN_STATE[state] ?? { label: state, tone: "" };
  return (
    <span className={`badge ${s.tone ? `badge--${s.tone}` : ""}`}>
      {s.tone === "running" && <span className="pulse" aria-hidden />}
      {s.label}
    </span>
  );
}

export function VerdictBadge({ verdict }: { verdict: string | null }) {
  if (!verdict) return <span className="subtle">-</span>;
  const bad = /reject|changes|fail|need_human|blocked/.test(verdict);
  return <span className={`badge badge--plain ${bad ? "badge--attention" : ""}`}>{verdict}</span>;
}
