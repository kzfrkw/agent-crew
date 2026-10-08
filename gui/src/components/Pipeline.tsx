import type { TaskState } from "../../../src/server/api-types.ts";
import { pipelineOf } from "../lib/pipeline.ts";

const STATUS_TEXT = { done: "済み", current: "現在", todo: "未着手", blocked: "人の対応待ち", human: "人が作業中", failed: "失敗" };

/** パイプライン上の位置(docs/surface.md) */
export function Pipeline({ state, heldFrom }: { state: TaskState; heldFrom: TaskState | null }) {
  return (
    <ol className="pipeline" aria-label="パイプライン">
      {pipelineOf(state, heldFrom).map((s) => (
        <li
          key={s.state}
          className={`pipeline__stage pipeline__stage--${s.status}`}
          title={STATUS_TEXT[s.status]}
          aria-label={`${s.label}: ${STATUS_TEXT[s.status]}`}
          aria-current={s.status !== "done" && s.status !== "todo" ? "step" : undefined}
        >
          <span className="pipeline__dot" aria-hidden />
          <span aria-hidden>{s.label}</span>
        </li>
      ))}
    </ol>
  );
}
